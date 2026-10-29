import * as v from 'valibot';

export const PullStateSchema = v.picklist(['open', 'draft', 'merged', 'closed']);
export type PullState = v.InferOutput<typeof PullStateSchema>;

export const StackMemberSchema = v.object({
  number: v.number(),
  title: v.string(),
  state: PullStateSchema,
  baseRef: v.string(),
  headRef: v.string(),
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
