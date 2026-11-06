import { mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiffPayload } from '@gloss/protocol';
import { Context, Effect, Layer, Schedule, Semaphore } from 'effect';
import { git } from './exec.ts';

/**
 * Where a tour's code can be grepped and read at its head: the repository itself for a local
 * diff, or a shallow clone for a PR. `rev` is the commit to search; a working-tree diff has none.
 */
export interface SearchTree {
  cwd: string;
  rev?: string;
}

/** One shallow clone per GitHub repository under `root`: git objects only, never a checkout. */
export function cloneDir(root: string, owner: string, repo: string): string {
  return join(root, `${owner}__${repo}`);
}

/** When a head last failed to fetch: lookups within `RETRY_MS` skip it instead of trying again. */
const RETRY_MS = 60_000;

/**
 * A head unused this long is dropped, and a clone with no heads left is deleted: tours of a PR
 * come within a day or two, and a head fetches again in seconds.
 */
export const HEAD_TTL_MS = 2 * 86_400_000;

/** Git with the `gh` login as its credentials, and no prompts. */
const fetchConfig = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', '-c', 'gc.auto=0'];

/** Where a repository's clone lives and where it is fetched from. */
export type CloneRemote = (owner: string, repo: string) => { dir: string; url: string };

const githubRemote =
  (root: string): CloneRemote =>
  (owner, repo) => ({
    dir: cloneDir(root, owner, repo),
    url: `https://github.com/${owner}/${repo}.git`,
  });

/** Git in `dir`; interrupting the effect kills the process. */
const gitIn = (dir: string, args: readonly string[]) => Effect.tryPromise((signal) => git(dir, args, { signal }));

const hasCommit = (dir: string, sha: string) =>
  gitIn(dir, ['cat-file', '-e', `${sha}^{commit}`]).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

/**
 * Fetches a PR's head commit into the repository's clone: about 6s for the first PR of a large
 * repository (only the head's objects), 1-3s for each after. No files are checked out, so Git
 * LFS objects are never downloaded; grep and show read the commit. A blob-less partial clone
 * would be faster to make but fetches one file at a time on grep, which takes minutes.
 */
const fetchHead = (dir: string, url: string, number: number, sha: string) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => mkdir(dir, { recursive: true, mode: 0o700 }));
    yield* gitIn(dir, ['init', '-q', '--bare']);
    const fetch = (refspec: string) =>
      gitIn(dir, [...fetchConfig, 'fetch', '-q', '--depth', '1', '--no-tags', url, refspec]);
    if (!(yield* hasCommit(dir, sha))) {
      yield* fetch(`refs/pull/${number}/head`);
    }
    // The PR may have moved on since the diff was read: fetch its exact head by id (GitHub
    // serves any commit it has); only that commit will do.
    if (!(yield* hasCommit(dir, sha))) {
      yield* fetch(sha);
    }
    if (!(yield* hasCommit(dir, sha))) {
      return yield* Effect.fail(new Error(`${sha} is not in ${url}`));
    }
    // One ref per head, so gc keeps it until prune drops it.
    yield* gitIn(dir, ['update-ref', `refs/gloss/head/${sha}`, sha]);
    yield* touch(dir, sha);
  });

/** Marks a head used now: the mtime of `used/<sha>` is its last use. */
const touch = (dir: string, sha: string) =>
  Effect.tryPromise(async () => {
    const file = join(dir, 'used', sha);
    const now = new Date();
    await utimes(file, now, now).catch(async () => {
      await mkdir(join(dir, 'used'), { recursive: true });
      await writeFile(file, '');
    });
  }).pipe(Effect.ignore);

/**
 * Shallow clones of the repositories PR tours read, for grepping callers at the PR's head. One
 * fetch runs per clone at a time (a git lock); an interrupted tour kills its fetch and frees the
 * clone for the next. A failed head is tried again after a minute.
 */
export class RepoClones extends Context.Service<
  RepoClones,
  {
    /**
     * The tree a tour searches, or undefined when there is none to grep (a PR whose head cannot
     * be fetched): callers then fall back to GitHub's code search.
     */
    tree(diff: DiffPayload): Effect.Effect<SearchTree | undefined>;
    /**
     * Drops heads unused for `HEAD_TTL_MS` and deletes clones with none left, each under its
     * clone's lock so it never runs beside a fetch. Counts what it removed.
     */
    prune(now?: number): Effect.Effect<{ heads: number; clones: number }>;
  }
>()('@gloss/core/RepoClones') {
  /** Clones kept under `root` (gloss's cache dir), pruned a minute after start and every 6 hours. */
  static readonly layer = (root: string) =>
    Layer.effect(
      RepoClones,
      Effect.gen(function* () {
        const clones = makeRepoClones(root);
        yield* Effect.forkScoped(
          Effect.suspend(() => clones.prune()).pipe(
            Effect.delay('1 minute'),
            Effect.repeat(Schedule.spaced('6 hours')),
          ),
        );
        return clones;
      }),
    );
}

export function makeRepoClones(root: string, remote: CloneRemote = githubRemote(root)): RepoClones['Service'] {
  const locks = new Map<string, Semaphore.Semaphore>();
  const ready = new Set<string>();
  const failed = new Map<string, number>();
  const lock = (dir: string) => {
    let semaphore = locks.get(dir);
    if (!semaphore) {
      semaphore = Semaphore.makeUnsafe(1);
      locks.set(dir, semaphore);
    }
    return semaphore;
  };
  return {
    tree: (diff) =>
      Effect.suspend(() => {
        const { ref, meta } = diff;
        if (ref.kind === 'local') {
          return Effect.succeed<SearchTree>({ cwd: ref.repo, ...(meta.headSha ? { rev: meta.headSha } : {}) });
        }
        const sha = meta.headSha;
        if (!sha) {
          return Effect.succeed(undefined);
        }
        const { dir, url } = remote(ref.owner, ref.repo);
        const key = `${dir}@${sha}`;
        const tree: SearchTree = { cwd: dir, rev: sha };
        // A fetched head may be gone since (another process's prune, the OS emptying its cache):
        // checked in a few ms, and fetched again when it is.
        const reuse = ready.has(key)
          ? hasCommit(dir, sha).pipe(
              Effect.tap((has) => (has ? touch(dir, sha) : Effect.sync(() => ready.delete(key)))),
            )
          : Effect.succeed(false);
        const fetched = Effect.suspend(() =>
          Date.now() - (failed.get(key) ?? -Infinity) < RETRY_MS ? Effect.succeed(undefined) : fetchOnce,
        );
        // A lookup queued behind the fetch of the same head finds the commit there at once.
        const fetchOnce = lock(dir)
          .withPermit(fetchHead(dir, url, ref.number, sha))
          .pipe(
            Effect.map(() => {
              failed.delete(key);
              ready.add(key);
              return tree as SearchTree | undefined;
            }),
            // An interruption is not a failure: the next tour tries again.
            Effect.catch(() =>
              Effect.sync(() => {
                failed.set(key, Date.now());
                return undefined;
              }),
            ),
          );
        return reuse.pipe(Effect.flatMap((has) => (has ? Effect.succeed<SearchTree | undefined>(tree) : fetched)));
      }),
    prune: (now = Date.now()) =>
      Effect.gen(function* () {
        const names = yield* Effect.tryPromise(() => readdir(root)).pipe(Effect.orElseSucceed(() => []));
        let heads = 0;
        let clones = 0;
        for (const name of names) {
          const dir = join(root, name);
          const pruned = yield* lock(dir).withPermit(pruneClone(dir, now));
          heads += pruned.heads;
          clones += pruned.deleted ? 1 : 0;
        }
        return { heads, clones };
      }),
  };

  /** One clone's stale heads dropped (and their objects gc'd), or the whole clone when none are left. */
  function pruneClone(dir: string, now: number) {
    return Effect.gen(function* () {
      const used = join(dir, 'used');
      const shas = yield* Effect.tryPromise(() => readdir(used)).pipe(Effect.orElseSucceed(() => [] as string[]));
      const stale: string[] = [];
      for (const sha of shas) {
        const { mtimeMs } = yield* Effect.tryPromise(() => stat(join(used, sha)));
        if (now - mtimeMs > HEAD_TTL_MS) {
          stale.push(sha);
        }
      }
      for (const sha of stale) {
        ready.delete(`${dir}@${sha}`);
      }
      if (stale.length === shas.length) {
        for (const sha of shas) {
          ready.delete(`${dir}@${sha}`);
        }
        yield* Effect.tryPromise(() => rm(dir, { recursive: true, force: true }));
        return { heads: stale.length, deleted: true };
      }
      if (stale.length) {
        for (const sha of stale) {
          yield* gitIn(dir, ['update-ref', '-d', `refs/gloss/head/${sha}`]);
          yield* Effect.tryPromise(() => rm(join(used, sha), { force: true }));
        }
        yield* gitIn(dir, ['reflog', 'expire', '--expire=now', '--all']);
        yield* gitIn(dir, ['gc', '--prune=now', '--quiet']);
      }
      return { heads: stale.length, deleted: false };
    }).pipe(Effect.orElseSucceed(() => ({ heads: 0, deleted: false })));
  }
}
