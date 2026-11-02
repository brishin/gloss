import type {
  DiffPayload,
  FileChange,
  FileContents,
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
import { githubPulls, githubViewer, type PullSummary, resolveGithubAsset } from './github.ts';

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
    /** The `gh` login, kept for an hour once known; undefined when `gh` is not signed in. */
    viewer: Effect.Effect<string | undefined>;
    /** The stack a PR sits in (a stack of one when it has no neighbours). */
    stack(ref: Extract<SourceRef, { kind: 'github-pr' }>): Effect.Effect<Stack, RepoError>;
    /** Posts a review as the `gh` login; GitHub's refusal is the error. */
    review(review: ReviewRequest): Effect.Effect<ReviewResult, RepoError>;
    /** A changed file in full, for expanding unchanged lines; undefined when there are none to show. */
    contents(diff: DiffPayload, file: FileChange): Effect.Effect<FileContents | undefined, RepoError | StaleFileError>;
  }
>()('@gloss/core/Repos') {
  /** Through the user's `gh` login and local git. */
  static readonly layer = Layer.effect(
    Repos,
    Effect.gen(function* () {
      const viewer = yield* Effect.tryPromise((signal) => githubViewer(signal)).pipe(
        Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? '1 hour' : 0)),
      );
      return {
        pulls: (refs) =>
          Effect.tryPromise((signal) => githubPulls(refs, signal)).pipe(Effect.orElseSucceed(() => new Map())),
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
