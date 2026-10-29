import type { ReviewRequest, ReviewResult } from '@gloss/protocol';
import { CommandError } from './exec.ts';
import { gh } from './github.ts';

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

/** Submits a review as the user's `gh` login; GitHub's refusal (say, approving your own PR) becomes the error message. */
export async function submitGithubReview(review: ReviewRequest, signal?: AbortSignal): Promise<ReviewResult> {
  const path = `repos/${review.owner}/${review.repo}/pulls/${review.number}/reviews`;
  try {
    const out = await gh(['--method', 'POST', path, '--input', '-'], signal, JSON.stringify(reviewPayload(review)));
    const created = JSON.parse(out) as { html_url: string };
    return { url: created.html_url };
  } catch (error) {
    if (error instanceof CommandError && error.stderr.trim()) {
      throw new Error(error.stderr.trim().replace(/^gh: /, ''), { cause: error });
    }
    throw error;
  }
}
