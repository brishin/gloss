import type { ReviewRequest, ReviewResult } from '@gloss/protocol';
import { type Duration, Effect } from 'effect';
import { CommandError } from './exec.ts';
import { gh, ghPaginated, githubViewer } from './github.ts';

/** The body of `POST /repos/{owner}/{repo}/pulls/{number}/reviews` for a review. */
export function reviewPayload(review: ReviewRequest) {
  const side = (value: 'additions' | 'deletions') => (value === 'deletions' ? 'LEFT' : 'RIGHT');
  return {
    ...(review.commitId ? { commit_id: review.commitId } : {}),
    event: review.verdict,
    body: review.body.trim(),
    comments: review.comments.map((comment) => ({
      path: comment.path,
      body: comment.body,
      line: comment.line,
      side: side(comment.side),
      ...(comment.startLine !== undefined && comment.startLine < comment.line
        ? { start_line: comment.startLine, start_side: side(comment.side) }
        : {}),
    })),
  };
}

/**
 * Whether a failed submit may be GitHub's own hiccup (a 5xx, or a reply `gh` could not read)
 * rather than a refusal. GitHub sometimes still creates the review behind such a reply.
 */
export function isTransient(error: unknown): boolean {
  if (error instanceof SyntaxError) {
    return true;
  }
  return (
    error instanceof CommandError &&
    /\(HTTP 5\d\d\)|unexpected end of JSON input/i.test(`${error.stderr}\n${error.message}`)
  );
}

export interface PostedReviewJson {
  html_url: string;
  user: { login: string } | null;
  state: string;
  body: string | null;
  submitted_at?: string | null;
}

const STATE = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' } as const;

/** GitHub's clock and ours differ a little; a review this much before the first try still counts. */
const CLOCK_SLACK_MS = 60_000;

/** The viewer's review that a failed submit created anyway: same verdict and body, submitted since `since`. */
export function landedReview(
  reviews: readonly PostedReviewJson[],
  viewer: string,
  review: Pick<ReviewRequest, 'verdict' | 'body'>,
  since: number,
): PostedReviewJson | undefined {
  const body = review.body.trim();
  return reviews.findLast(
    (candidate) =>
      candidate.user?.login === viewer &&
      candidate.state === STATE[review.verdict] &&
      (candidate.body ?? '').trim() === body &&
      !!candidate.submitted_at &&
      Date.parse(candidate.submitted_at) >= since - CLOCK_SLACK_MS,
  );
}

export interface SubmitSteps {
  /** Posts the review payload; resolves with GitHub's reply. */
  post(payload: string): Effect.Effect<string, unknown>;
  /** The PR's reviews and the viewer's login, to find a review a failed post created anyway. */
  reviews: Effect.Effect<readonly [readonly PostedReviewJson[], string], unknown>;
}

/**
 * Posts a review, riding out GitHub's transient errors. After one it waits, looks for a review the
 * failed post created anyway (so a review is never posted twice), and only then posts again.
 */
export const submitReviewWith = (
  review: ReviewRequest,
  steps: SubmitSteps,
  wait: Duration.Input = '5 seconds',
): Effect.Effect<ReviewResult, unknown> =>
  Effect.suspend(() => {
    const payload = JSON.stringify(reviewPayload(review));
    const since = Date.now();
    const landed = steps.reviews.pipe(
      Effect.map(([reviews, viewer]) => landedReview(reviews, viewer, review, since)),
      Effect.orElseSucceed(() => undefined),
    );
    return steps.post(payload).pipe(
      Effect.flatMap((out) =>
        Effect.try({
          try: () => ({ url: (JSON.parse(out) as { html_url: string }).html_url }),
          catch: (error) => error,
        }),
      ),
      Effect.catchIf(isTransient, (error) =>
        Effect.sleep(wait).pipe(
          Effect.andThen(landed),
          Effect.flatMap((found) => (found ? Effect.succeed({ url: found.html_url }) : Effect.fail(error))),
        ),
      ),
      Effect.retry({ times: 2, while: isTransient }),
    );
  });

/** Submits a review as the user's `gh` login; GitHub's refusal (say, approving your own PR) becomes the error message. */
export const submitGithubReview = (review: ReviewRequest): Effect.Effect<ReviewResult, Error> => {
  const path = `repos/${review.owner}/${review.repo}/pulls/${review.number}/reviews`;
  return submitReviewWith(review, {
    post: (payload) =>
      Effect.tryPromise({
        try: (signal) => gh(['--method', 'POST', path, '--input', '-'], signal, payload),
        catch: (error) => error,
      }),
    reviews: Effect.tryPromise({
      try: (signal) =>
        Promise.all([ghPaginated<PostedReviewJson>(`${path}?per_page=100`, signal), githubViewer(signal)] as const),
      catch: (error) => error,
    }),
  }).pipe(
    Effect.mapError((error) =>
      error instanceof CommandError && error.stderr.trim()
        ? new Error(error.stderr.trim().replace(/^gh: /, ''), { cause: error })
        : error instanceof Error
          ? error
          : new Error(String(error)),
    ),
  );
};
