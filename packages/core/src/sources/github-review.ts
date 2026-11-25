import type { ReviewRequest, ReviewResult } from '@gloss/protocol';
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
  post(payload: string): Promise<string>;
  reviews(): Promise<readonly PostedReviewJson[]>;
  viewer(): Promise<string>;
  wait(ms: number): Promise<void>;
  now(): number;
}

/** Waits before each retry. Long enough for a review GitHub was still creating behind a 504 to show up. */
const RETRY_DELAYS_MS = [5_000, 10_000];

/**
 * Posts a review, riding out GitHub's transient errors: after one, it waits, looks for a review the
 * failed try created anyway (so a review is never posted twice), and only then tries again.
 */
export async function submitReviewWith(review: ReviewRequest, steps: SubmitSteps): Promise<ReviewResult> {
  const payload = JSON.stringify(reviewPayload(review));
  const since = steps.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const created = JSON.parse(await steps.post(payload)) as { html_url: string };
      return { url: created.html_url };
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (!isTransient(error) || delay === undefined) {
        throw error;
      }
      await steps.wait(delay);
      const landed = await Promise.all([steps.reviews(), steps.viewer()])
        .then(([reviews, viewer]) => landedReview(reviews, viewer, review, since))
        .catch(() => undefined);
      if (landed) {
        return { url: landed.html_url };
      }
    }
  }
}

/** Submits a review as the user's `gh` login; GitHub's refusal (say, approving your own PR) becomes the error message. */
export async function submitGithubReview(review: ReviewRequest, signal?: AbortSignal): Promise<ReviewResult> {
  const path = `repos/${review.owner}/${review.repo}/pulls/${review.number}/reviews`;
  try {
    return await submitReviewWith(review, {
      post: (payload) => gh(['--method', 'POST', path, '--input', '-'], signal, payload),
      reviews: () => ghPaginated<PostedReviewJson>(`${path}?per_page=100`, signal),
      viewer: () => githubViewer(signal),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    });
  } catch (error) {
    if (error instanceof CommandError && error.stderr.trim()) {
      throw new Error(error.stderr.trim().replace(/^gh: /, ''), { cause: error });
    }
    throw error;
  }
}
