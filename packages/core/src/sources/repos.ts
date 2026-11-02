import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import type {
  DiffPayload,
  FileChange,
  FileContents,
  LfsObject,
  ResolvedAsset,
  ReviewRequest,
  ReviewResult,
  SourceRef,
  Stack,
} from '@gloss/protocol';
import { Context, Data, Deferred, Effect, Exit, Layer, Semaphore } from 'effect';
import { readFileContents, StaleFileError } from './contents.ts';
import { submitGithubReview } from './github-review.ts';
import { resolveGithubStack } from './github-stack.ts';
import { githubInbox, githubPulls, githubViewer, type Inbox, type PullSummary, resolveGithubAsset } from './github.ts';
import { readLfsObject } from './lfs.ts';

/** A `gh` or git call failed; `message` is what the API answers with. */
export class RepoError extends Data.TaggedError('RepoError')<{ message: string; cause?: unknown }> {}

const repoError = (cause: unknown) =>
  new RepoError({ message: cause instanceof Error ? cause.message : String(cause), cause });

/**
 * What the API reads from (or writes to) repositories outside a tour: PR attachments,
 * stacks, reviews and whole files. Interrupting an effect kills its `gh`/git process.
 */
export class Repos extends Context.Service<
  Repos,
  {
    /** A PR body attachment as a URL the browser can load; undefined when GitHub won't say. */
    asset(url: string): Effect.Effect<ResolvedAsset | undefined>;
    /** Each PR's author and current state, keyed by `serializeRef`; PRs GitHub won't say are left out. */
    pulls(refs: readonly Extract<SourceRef, { kind: 'github-pr' }>[]): Effect.Effect<ReadonlyMap<string, PullSummary>>;
    /** Open PRs waiting on the `gh` login's review, and its own; undefined when GitHub won't say. */
    inbox: Effect.Effect<Inbox | undefined>;
    /** The `gh` login, kept for an hour once known; undefined when `gh` is not signed in. */
    viewer: Effect.Effect<string | undefined>;
    /** The stack a PR sits in (a stack of one when it has no neighbours). */
    stack(ref: Extract<SourceRef, { kind: 'github-pr' }>): Effect.Effect<Stack, RepoError>;
    /** Posts a review as the `gh` login; GitHub's refusal is the error. */
    review(review: ReviewRequest): Effect.Effect<ReviewResult, RepoError>;
    /** A changed file in full, for expanding unchanged lines; undefined when there are none to show. */
    contents(diff: DiffPayload, file: FileChange): Effect.Effect<FileContents | undefined, RepoError | StaleFileError>;
    /** A Git LFS object named in the diff, kept in memory once fetched. */
    lfs(diff: DiffPayload, object: LfsObject): Effect.Effect<Uint8Array, RepoError>;
  }
>()('@gloss/core/Repos') {
  /** Through the user's `gh` login and local git. */
  static readonly layer = Layer.effect(
    Repos,
    Effect.gen(function* () {
      const viewer = yield* Effect.tryPromise((signal) => githubViewer(signal)).pipe(
        Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? '1 hour' : 0)),
      );
      const lfs = yield* makeLfsCache();
      return {
        lfs: (diff, object) =>
          lfs(
            object.oid,
            Effect.tryPromise({ try: (signal) => readLfsObject(diff, object, signal), catch: repoError }),
          ),
        pulls: (refs) =>
          Effect.tryPromise((signal) => githubPulls(refs, signal)).pipe(Effect.orElseSucceed(() => new Map())),
        inbox: Effect.tryPromise((signal) => githubInbox(signal)).pipe(Effect.orElseSucceed(() => undefined)),
        viewer: viewer.pipe(Effect.orElseSucceed(() => undefined)),
        asset: (url) =>
          Effect.tryPromise((signal) => resolveGithubAsset(url, signal)).pipe(Effect.orElseSucceed(() => undefined)),
        stack: (ref) => Effect.tryPromise({ try: (signal) => resolveGithubStack(ref, signal), catch: repoError }),
        review: (review) =>
          Effect.tryPromise({ try: (signal) => submitGithubReview(review, signal), catch: repoError }),
        contents: (diff, file) =>
          Effect.tryPromise({
            try: (signal) => readFileContents(diff, file, signal),
            catch: (cause) => (cause instanceof StaleFileError ? cause : repoError(cause)),
          }),
      };
    }),
  );
}

/** At most this many LFS downloads at once. */
const LFS_DOWNLOADS = 4;

/**
 * Git LFS objects saved by oid in a temp folder, so a restart or another tour reads them from disk.
 * Requests for one oid share a download: the page asks for every image when the tour opens, and
 * again when it shows one. A download runs in the service's scope, not the request's, so a reader
 * who leaves the page does not cancel it for the others; closing the service interrupts it.
 */
export const makeLfsCache = (dir = join(tmpdir(), 'gloss-lfs')) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const downloads = yield* Semaphore.make(LFS_DOWNLOADS);
    const running = new Map<string, Deferred.Deferred<Uint8Array, RepoError>>();

    const save = (path: string, bytes: Uint8Array) =>
      Effect.tryPromise(async () => {
        await mkdir(dir, { recursive: true });
        // Written aside, then renamed, so a reader never sees half a file.
        const partial = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
        await writeFile(partial, bytes);
        await rename(partial, path);
      }).pipe(Effect.ignore);

    return (oid: string, download: Effect.Effect<Uint8Array, RepoError>): Effect.Effect<Uint8Array, RepoError> =>
      Effect.suspend(() => {
        const shared = running.get(oid);
        if (shared) {
          return Deferred.await(shared);
        }
        const path = join(dir, oid);
        const deferred = Deferred.makeUnsafe<Uint8Array, RepoError>();
        running.set(oid, deferred);
        const fetched = downloads.withPermit(download).pipe(Effect.tap((bytes) => save(path, bytes)));
        return Effect.tryPromise(() => readFile(path)).pipe(
          Effect.map((bytes) => new Uint8Array(bytes)),
          Effect.catch(() => fetched),
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.sync(() => {
              running.delete(oid);
              Deferred.doneUnsafe(deferred, exit);
            }),
          ),
          Effect.onInterrupt(() =>
            Effect.sync(() => running.delete(oid)).pipe(Effect.andThen(Deferred.interrupt(deferred))),
          ),
          Effect.forkIn(scope),
          Effect.andThen(Deferred.await(deferred)),
        );
      });
  });
