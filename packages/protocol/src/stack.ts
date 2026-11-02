import * as v from 'valibot';

/** `queued` is an open PR in its base branch's merge queue. */
export const PullStateSchema = v.picklist(['open', 'draft', 'queued', 'merged', 'closed']);
export type PullState = v.InferOutput<typeof PullStateSchema>;

export const StackMemberSchema = v.object({
  number: v.number(),
  title: v.string(),
  state: PullStateSchema,
  /** The PR author's GitHub login. */
  author: v.optional(v.string()),
  baseRef: v.string(),
  headRef: v.string(),
  /**
   * Since when the PR is in its state: opened, queued, merged or closed (ISO time), who
   * merged it, and its place in the merge queue (1 is next). Only the PR asked about has it.
   */
  since: v.optional(v.string()),
  mergedBy: v.optional(v.string()),
  queuePosition: v.optional(v.number()),
  /** The opening words of the PR's description, without its template lines; context for naming the stack. */
  blurb: v.optional(v.string()),
});
export type StackMember = v.InferOutput<typeof StackMemberSchema>;

/**
 * The chain of same-repo PRs a PR sits in: each member's base branch is the head branch of
 * the one before it. `members` runs bottom (onto `base`) to top and always includes the PR
 * asked about, so a PR outside any stack is a stack of one.
 */
export const StackSchema = v.object({
  owner: v.string(),
  repo: v.string(),
  base: v.string(),
  members: v.array(StackMemberSchema),
});
export type Stack = v.InferOutput<typeof StackSchema>;

/** A stack's short name, as the backend's fast model gives it for the side rail. */
export const StackNameSchema = v.object({ name: v.string() });
export type StackName = v.InferOutput<typeof StackNameSchema>;
