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

/** A comment already on GitHub, in a review thread. */
export const ThreadCommentSchema = v.object({
  id: v.string(),
  /** The login, or "ghost" for a deleted account; a bot's login has no `[bot]` suffix. */
  author: v.string(),
  /** The author's avatar as GitHub serves it (bots and apps included). */
  avatar: v.optional(v.string()),
  body: v.string(),
  createdAt: v.string(),
  url: v.string(),
});
export type ThreadComment = v.InferOutput<typeof ThreadCommentSchema>;

/**
 * A line comment thread already on the PR. `line` is where it sits in the PR's head now; an
 * outdated thread has none (its line changed since), and `quote` is the line it was left on.
 */
export const ReviewThreadSchema = v.object({
  id: v.string(),
  path: v.string(),
  side: DiffSideSchema,
  line: v.optional(v.number()),
  startLine: v.optional(v.number()),
  resolved: v.boolean(),
  outdated: v.boolean(),
  quote: v.optional(v.string()),
  comments: v.array(ThreadCommentSchema),
});
export type ReviewThread = v.InferOutput<typeof ReviewThreadSchema>;

const PullFields = {
  owner: v.string(),
  repo: v.string(),
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
};

/** A reply to a thread, posted as the backend's `gh` login. */
export const ThreadReplyRequestSchema = v.object({
  ...PullFields,
  threadId: v.string(),
  body: v.pipe(v.string(), v.trim(), v.minLength(1)),
});
export type ThreadReplyRequest = v.InferOutput<typeof ThreadReplyRequestSchema>;

/** Resolves a thread, or unresolves it. */
export const ThreadResolveRequestSchema = v.object({
  ...PullFields,
  threadId: v.string(),
  resolved: v.boolean(),
});
export type ThreadResolveRequest = v.InferOutput<typeof ThreadResolveRequestSchema>;
