import * as v from 'valibot';

/** `queued` is an open PR in its base branch's merge queue. */
export const PullStateSchema = v.picklist(['open', 'draft', 'queued', 'merged', 'closed']);
export type PullState = v.InferOutput<typeof PullStateSchema>;

/** A reviewer's latest word on the PR; `pending` is a review requested and not yet given. */
export const ReviewStateSchema = v.picklist(['approved', 'changes', 'commented', 'pending']);
export type ReviewState = v.InferOutput<typeof ReviewStateSchema>;

export const ReviewerSchema = v.object({
  /** A user's login, or a team's `org/slug`. */
  login: v.string(),
  team: v.optional(v.boolean()),
  state: ReviewStateSchema,
  /** GitHub's picture for them; a bot has none at `github.com/<login>.png`. */
  avatar: v.optional(v.string()),
});
export type Reviewer = v.InferOutput<typeof ReviewerSchema>;

/**
 * Someone GitHub suggests for review: `wrote` code in the changed files before (git blame), or
 * `reviewed` them before.
 */
export const SuggestedReviewerSchema = v.object({
  login: v.string(),
  why: v.picklist(['wrote', 'reviewed']),
});
export type SuggestedReviewer = v.InferOutput<typeof SuggestedReviewerSchema>;

/** Where the PR's review stands as a whole: approved, or changes requested. */
export const ReviewDecisionSchema = v.picklist(['approved', 'changes']);
export type ReviewDecision = v.InferOutput<typeof ReviewDecisionSchema>;

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
  /** Who reviewed or is asked to review, reviews first. Only the PR asked about has it. */
  reviewers: v.optional(v.array(ReviewerSchema)),
  /** Approved or changes requested, as GitHub decides it. Only the PR asked about has it. */
  reviewDecision: v.optional(ReviewDecisionSchema),
  /**
   * GitHub's suggested reviewers, less the viewer, the author and anyone already reviewing.
   * Only the PR asked about has it.
   */
  suggestedReviewers: v.optional(v.array(SuggestedReviewerSchema)),
  /** Whether the viewer may ask for reviews on the PR (triage access or more). Only the PR asked about has it. */
  canRequestReviews: v.optional(v.boolean()),
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

/**
 * Asks for reviews on a PR, or withdraws asks, as the backend's `gh` login. Logins are users';
 * a team is its `org/slug`.
 */
export const ReviewersRequestSchema = v.object({
  owner: v.string(),
  repo: v.string(),
  number: v.number(),
  add: v.optional(v.array(v.object({ login: v.pipe(v.string(), v.minLength(1)), team: v.optional(v.boolean()) }))),
  remove: v.optional(v.array(v.object({ login: v.pipe(v.string(), v.minLength(1)), team: v.optional(v.boolean()) }))),
});
export type ReviewersRequest = v.InferOutput<typeof ReviewersRequestSchema>;

/** The PR's reviewers and suggestions as GitHub has them after a change. */
export const ReviewersResultSchema = v.object({
  reviewers: v.array(ReviewerSchema),
  suggestedReviewers: v.array(SuggestedReviewerSchema),
});
export type ReviewersResult = v.InferOutput<typeof ReviewersResultSchema>;

/** Someone who can be asked to review: a collaborator matching a search. */
export const ReviewerCandidateSchema = v.object({
  login: v.string(),
  name: v.optional(v.string()),
});
export type ReviewerCandidate = v.InferOutput<typeof ReviewerCandidateSchema>;
