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
import { Context, Data, Effect, Exit, Layer } from 'effect';
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
      const lfs = lfsCache();
      return {
        lfs: (diff, object) =>
          Effect.tryPromise({ try: () => lfs(object.oid, () => readLfsObject(diff, object)), catch: repoError }),
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

/** At most this many LFS downloads at once, and this many bytes kept. */
const LFS_DOWNLOADS = 4;
const LFS_BUDGET = 512 * 1024 * 1024;

/**
 * Fetched LFS objects by oid. Requests for one oid share a download: the page asks for every
 * image when the tour opens, and again when it shows one. A download is not tied to the request
 * that started it, so a reader who leaves the page does not cancel it for the others.
 */
function lfsCache() {
  const entries = new Map<string, Promise<Uint8Array>>();
  const sizes = new Map<string, number>();
  let used = 0;
  let running = 0;
  const waiting: (() => void)[] = [];
  const slot = async () => {
    if (running >= LFS_DOWNLOADS) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    running++;
  };
  const release = () => {
    running--;
    waiting.shift()?.();
  };
  return (oid: string, download: () => Promise<Uint8Array>): Promise<Uint8Array> => {
    const hit = entries.get(oid);
    if (hit) {
      // Most recently used last, so eviction takes the oldest.
      entries.delete(oid);
      entries.set(oid, hit);
      return hit;
    }
    const pending = slot()
      .then(download)
      .finally(release)
      .then(
        (bytes) => {
          sizes.set(oid, bytes.length);
          used += bytes.length;
          for (const [key] of entries) {
            if (used <= LFS_BUDGET || key === oid) {
              break;
            }
            entries.delete(key);
            used -= sizes.get(key) ?? 0;
            sizes.delete(key);
          }
          return bytes;
        },
        (error: unknown) => {
          entries.delete(oid);
          throw error;
        },
      );
    entries.set(oid, pending);
    return pending;
  };
}
