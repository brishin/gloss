import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiffPayload } from '@gloss/protocol';
import { Effect, Fiber } from 'effect';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { HEAD_TTL_MS, makeRepoClones } from './clone.ts';

const root = mkdtempSync(join(tmpdir(), 'gloss-clone-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();

/** A "GitHub" repository whose PR 7 head adds a caller, with a big file only on another branch. */
function upstream(name = 'work') {
  const work = join(root, name);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  writeFileSync(join(work, 'shared.ts'), 'export const shared = 1;\n');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'base');
  writeFileSync(join(work, 'screen.ts'), "import { shared } from './shared';\n");
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'pr');
  const head = git(work, 'rev-parse', 'HEAD');
  const bare = join(root, `${name}.git`);
  execFileSync('git', ['clone', '-q', '--bare', work, bare]);
  git(bare, 'update-ref', 'refs/pull/7/head', head);
  return { bare, head };
}

const diff = (sha: string): DiffPayload => ({
  id: 'd',
  ref: { kind: 'github-pr', owner: 'o', repo: 'r', number: 7 },
  sourceKey: 'k',
  fingerprint: sha,
  meta: { title: 't', baseRef: 'main', headRef: 'pr', headSha: sha, commits: [] },
  files: [],
});

describe('RepoClones', () => {
  it("fetches a PR's head into a shallow bare clone, without checking out files, and greps it", async () => {
    const { bare, head } = upstream();
    const dir = join(root, 'clone');
    const clones = makeRepoClones(root, () => ({ dir, url: `file://${bare}` }));
    const tree = await Effect.runPromise(clones.tree(diff(head)));
    expect(tree).toEqual({ cwd: dir, rev: head });
    expect(existsSync(join(dir, 'screen.ts'))).toBe(false);
    expect(git(dir, 'rev-parse', '--is-shallow-repository')).toBe('true');
    expect(git(dir, 'grep', '-n', '-F', "from './shared'", head)).toBe(
      `${head}:screen.ts:1:import { shared } from './shared';`,
    );
    // A second lookup of the same head reuses the fetch.
    expect(await Effect.runPromise(clones.tree(diff(head)))).toEqual(tree);
    // A clone removed from under the server (the OS, another process's prune) is fetched again.
    rmSync(dir, { recursive: true, force: true });
    expect(await Effect.runPromise(clones.tree(diff(head)))).toEqual(tree);
    expect(git(dir, 'cat-file', '-t', head)).toBe('commit');
  });

  it('runs one fetch per clone at a time, so lookups of one head queued together all find it', async () => {
    const { bare, head } = upstream('queued');
    const dir = join(root, 'queued-clone');
    const clones = makeRepoClones(root, () => ({ dir, url: `file://${bare}` }));
    const trees = await Effect.runPromise(
      Effect.all([clones.tree(diff(head)), clones.tree(diff(head)), clones.tree(diff(head))], { concurrency: 3 }),
    );
    expect(trees).toEqual([0, 1, 2].map(() => ({ cwd: dir, rev: head })));
  });

  it('gives no tree when the head cannot be fetched, so search falls back to GitHub', async () => {
    const clones = makeRepoClones(root, () => ({
      dir: join(root, 'missing-clone'),
      url: `file://${join(root, 'nowhere.git')}`,
    }));
    expect(await Effect.runPromise(clones.tree(diff('0'.repeat(40))))).toBeUndefined();
  });

  it('tries a failed head again after a minute, and an interrupted one at once', async () => {
    const { bare, head } = upstream('later');
    const dir = join(root, 'later-clone');
    let url = `file://${join(root, 'not-yet.git')}`;
    const clones = makeRepoClones(root, () => ({ dir, url }));
    expect(await Effect.runPromise(clones.tree(diff(head)))).toBeUndefined();
    url = `file://${bare}`;
    // Within the minute, the failure stands; after it, the fetch runs again.
    expect(await Effect.runPromise(clones.tree(diff(head)))).toBeUndefined();
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ['Date'] });
    try {
      const fiber = Effect.runFork(clones.tree(diff(head)));
      await Effect.runPromise(Fiber.interrupt(fiber));
      expect(await Effect.runPromise(clones.tree(diff(head)))).toEqual({ cwd: dir, rev: head });
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops heads unused for two days and gc-s their objects, then the whole clone', async () => {
    const { bare, head: first } = upstream('pruned');
    const work = join(root, 'pruned');
    writeFileSync(join(work, 'later.ts'), 'export const later = 1;\n');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'later');
    const second = git(work, 'rev-parse', 'HEAD');
    git(bare, 'fetch', '-q', work, 'main');
    git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    // Its own cache root: prune deletes anything under it with no live heads.
    const cache = join(root, 'cache');
    const dir = join(cache, 'o__r');
    const clones = makeRepoClones(cache, () => ({ dir, url: `file://${bare}` }));
    expect(await Effect.runPromise(clones.tree(diff(first)))).toBeDefined();
    git(bare, 'update-ref', 'refs/pull/7/head', second);
    expect(await Effect.runPromise(clones.tree(diff(second)))).toBeDefined();
    const old = new Date(Date.now() - HEAD_TTL_MS - 60_000);
    utimesSync(join(dir, 'used', first), old, old);

    expect(await Effect.runPromise(clones.prune())).toEqual({ heads: 1, clones: 0 });
    const has = (sha: string) => {
      try {
        execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: dir, stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    };
    expect(has(first)).toBe(false);
    expect(has(second)).toBe(true);
    // A pruned head is fetched again, not handed out as a dead tree.
    expect(await Effect.runPromise(clones.tree(diff(first)))).toEqual({ cwd: dir, rev: first });
    expect(has(first)).toBe(true);

    expect(await Effect.runPromise(clones.prune(Date.now() + HEAD_TTL_MS + 60_000))).toEqual({ heads: 2, clones: 1 });
    expect(existsSync(dir)).toBe(false);
  });
});
