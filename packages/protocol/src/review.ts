import * as v from 'valibot';
import { DiffSideSchema } from './diff.ts';

/** What a review says about the PR, as GitHub names it. */
export const ReviewVerdictSchema = v.picklist(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);
export type ReviewVerdict = v.InferOutput<typeof ReviewVerdictSchema>;

/** A comment on a line of the diff, or on `startLine`..`line` when it spans several. */
export const ReviewCommentSchema = v.object({
  path: v.string(),
  side: DiffSideSchema,
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  startLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  body: v.pipe(v.string(), v.minLength(1)),
});
export type ReviewComment = v.InferOutput<typeof ReviewCommentSchema>;

/** One GitHub review: a verdict, an optional summary, and the line comments it carries. */
export const ReviewRequestSchema = v.object({
  owner: v.string(),
  repo: v.string(),
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
  verdict: ReviewVerdictSchema,
  body: v.string(),
  comments: v.array(ReviewCommentSchema),
  /** The head the diff was read at, so line comments land on the lines the reviewer saw. */
  commitId: v.optional(v.string()),
});
export type ReviewRequest = v.InferOutput<typeof ReviewRequestSchema>;

export const ReviewResultSchema = v.object({ url: v.string() });
export type ReviewResult = v.InferOutput<typeof ReviewResultSchema>;

/** Why GitHub would refuse this review, or undefined when it can be sent. */
export function reviewProblem(review: Pick<ReviewRequest, 'verdict' | 'body' | 'comments'>): string | undefined {
  const body = review.body.trim();
  if (review.verdict === 'REQUEST_CHANGES' && !body) {
    return 'Say what needs to change.';
  }
  if (review.verdict === 'COMMENT' && !body && review.comments.length === 0) {
    return 'Write a comment.';
  }
  return undefined;
}
