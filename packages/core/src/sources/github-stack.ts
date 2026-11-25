import type {
  MergeMethod,
  PullMerge,
  PullState,
  ReviewDecision,
  Reviewer,
  SourceRef,
  Stack,
  StackMember,
  SuggestedReviewer,
} from '@gloss/protocol';
import { ghJson, ghPaginated, pullState } from './github.ts';

type GithubRef = Extract<SourceRef, { kind: 'github-pr' }>;

/** Longest chain gloss walks; past it the stack is cut, never looped. */
export const MAX_STACK = 12;

/**
 * A PR as the walk sees it. `headInRepo` is false for a PR from a fork: its head branch
 * (often `main`) is not a branch of this repo, so PRs based on a same-named branch here
 * are not stacked on it.
 */
export type StackPull = StackMember & { headInRepo: boolean };

/** How a stack walk finds a PR's neighbours. Kept apart from `gh` so the walk is testable. */
export interface StackLookup {
  /** The repo's default branch: a stack never reaches past it. */
  trunk(): Promise<string>;
  pull(number: number): Promise<StackPull>;
  /** PRs whose head branch in this repo is `branch` (the PR below). */
  byHead(branch: string): Promise<StackPull[]>;
  /** Open PRs whose base branch is `branch` (the PRs above). */
  byBase(branch: string): Promise<StackPull[]>;
}

/** Not yet merged or closed. */
export const isOpen = (state: PullState): boolean => state === 'open' || state === 'draft' || state === 'queued';

/** The PR below: prefer an open one, else the most recent (highest number) merged or closed one. */
function pickBelow(candidates: StackPull[]): StackPull | undefined {
  const sorted = candidates.toSorted((a, b) => b.number - a.number);
  return sorted.find((pull) => isOpen(pull.state)) ?? sorted[0];
}

/** The PR above: the oldest open one. A branch with several PRs on it is a tree; gloss shows one line of it. */
function pickAbove(candidates: StackPull[]): StackPull | undefined {
  return candidates.filter((pull) => isOpen(pull.state)).toSorted((a, b) => a.number - b.number)[0];
}

/**
 * Walks base branches down and head branches up from one PR. Stops at the trunk (a PR
 * promoting trunk into a release branch is not under PRs onto trunk), at a branch no PR
 * heads, at a PR already seen, or at `MAX_STACK` members.
 */
export async function walkStack(number: number, lookup: StackLookup): Promise<StackMember[]> {
  const [current, trunk] = await Promise.all([lookup.pull(number), lookup.trunk()]);
  const seen = new Set([current.number]);
  const below: StackPull[] = [];
  const above: StackPull[] = [];
  const full = () => seen.size >= MAX_STACK;

  for (let at = current; at.baseRef !== trunk && !full();) {
    const next = pickBelow((await lookup.byHead(at.baseRef)).filter((pull) => !seen.has(pull.number)));
    if (!next) {
      break;
    }
    seen.add(next.number);
    below.unshift(next);
    at = next;
  }
  for (let at = current; at.headInRepo && at.headRef !== trunk && !full();) {
    const next = pickAbove((await lookup.byBase(at.headRef)).filter((pull) => !seen.has(pull.number)));
    if (!next) {
      break;
    }
    seen.add(next.number);
    above.push(next);
    at = next;
  }
  const member = ({ number, title, state, author, baseRef, headRef, blurb }: StackPull): StackMember => ({
    number,
    title,
    state,
    ...(author ? { author } : {}),
    baseRef,
    headRef,
    ...(blurb ? { blurb } : {}),
  });
  const { since, mergedBy, queuePosition, reviewers, reviewDecision, suggestedReviewers, canRequestReviews, merge } =
    current;
  return [
    ...below.map(member),
    {
      ...member(current),
      ...(since ? { since } : {}),
      ...(mergedBy ? { mergedBy } : {}),
      ...(queuePosition ? { queuePosition } : {}),
      ...(reviewers?.length ? { reviewers } : {}),
      ...(reviewDecision ? { reviewDecision } : {}),
      ...(suggestedReviewers?.length ? { suggestedReviewers } : {}),
      ...(canRequestReviews ? { canRequestReviews } : {}),
      ...(merge ? { merge } : {}),
    },
    ...above.map(member),
  ];
}

/** Longest blurb kept: a sentence or two is enough to name a stack. */
const BLURB_CHARS = 200;

/**
 * The opening prose of a PR description: HTML comments, headings, lines that are all emphasis
 * (bot and template bylines) and images left out, and markdown links reduced to their text.
 */
export function blurbOf(body: string | null | undefined): string | undefined {
  const prose = (body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !/^#{1,6}\s/.test(line) && !/^([_*]).*\1$/.test(line) && !/^(!\[|<img|---|\|)/.test(line))
    .map((line) =>
      line
        .replace(/^([-*+]|\d+\.)\s+/, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/`/g, ''),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!prose) {
    return undefined;
  }
  if (prose.length <= BLURB_CHARS) {
    return prose;
  }
  const cut = prose.slice(0, BLURB_CHARS);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : BLURB_CHARS)}…`;
}

interface PullJson {
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  draft?: boolean;
  merged_at: string | null;
  user?: { login: string } | null;
  base: { ref: string };
  head: { ref: string; repo: { full_name: string } | null };
}

function toPull(pull: PullJson, repo: string): StackPull {
  const blurb = blurbOf(pull.body);
  return {
    number: pull.number,
    title: pull.title,
    state: pullState({ open: pull.state === 'open', merged: !!pull.merged_at, draft: pull.draft }),
    ...(pull.user?.login ? { author: pull.user.login } : {}),
    baseRef: pull.base.ref,
    headRef: pull.head.ref,
    headInRepo: pull.head.repo?.full_name.toLowerCase() === repo,
    ...(blurb ? { blurb } : {}),
  };
}

interface PullGraphJson {
  data?: {
    viewer?: { login: string } | null;
    repository?: {
      viewerPermission?: 'ADMIN' | 'MAINTAIN' | 'WRITE' | 'TRIAGE' | 'READ' | null;
      squashMergeAllowed?: boolean;
      mergeCommitAllowed?: boolean;
      rebaseMergeAllowed?: boolean;
      viewerDefaultMergeMethod?: 'SQUASH' | 'MERGE' | 'REBASE';
      pullRequest?:
        | (MergeJson & {
            number: number;
            title: string;
            body: string | null;
            state: 'OPEN' | 'CLOSED' | 'MERGED';
            isDraft: boolean;
            isInMergeQueue: boolean;
            createdAt: string;
            mergedAt: string | null;
            closedAt: string | null;
            mergedBy: { login: string } | null;
            author: { login: string } | null;
            baseRefName: string;
            headRefName: string;
            headRepository: { nameWithOwner: string } | null;
            reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
            latestReviews: { nodes: ReviewJson[] } | null;
            latestOpinionatedReviews: { nodes: ReviewJson[] } | null;
            reviewRequests: { nodes: ReviewRequestJson[] } | null;
            suggestedReviewers?: SuggestionJson[] | null;
          })
        | null;
      defaultBranchRef: { name: string } | null;
    } | null;
  };
}

/** What the PR query reads for merging. */
export interface MergeJson {
  id: string;
  headRefOid: string;
  isMergeQueueEnabled?: boolean;
  mergeStateStatus?: 'BEHIND' | 'BLOCKED' | 'CLEAN' | 'DIRTY' | 'DRAFT' | 'HAS_HOOKS' | 'UNKNOWN' | 'UNSTABLE';
  viewerCanEnableAutoMerge?: boolean;
  viewerCanMergeAsAdmin?: boolean;
  autoMergeRequest?: { enabledAt: string | null } | null;
  mergeQueueEntry: { position: number; enqueuedAt: string; estimatedTimeToMerge?: number | null } | null;
  mergeQueue?: { nextEntryEstimatedTimeToMerge: number | null; entries: { totalCount: number } | null } | null;
  statusCheckRollup?: { contexts: { nodes: (CheckJson | null)[] } | null } | null;
}

/** A check run (Actions and apps) or a commit status (older integrations). */
type CheckJson =
  | { __typename: 'CheckRun'; name: string; status: string; conclusion: string | null }
  | { __typename: 'StatusContext'; context: string; state: string };

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** A check's outcome: a finished run passed or failed; anything still going is pending. */
function checkOutcome(check: CheckJson): 'passed' | 'failed' | 'pending' {
  if (check.__typename === 'CheckRun') {
    return check.status !== 'COMPLETED' ? 'pending' : PASSED.has(check.conclusion ?? '') ? 'passed' : 'failed';
  }
  return check.state === 'SUCCESS'
    ? 'passed'
    : check.state === 'PENDING' || check.state === 'EXPECTED'
      ? 'pending'
      : 'failed';
}

const MERGE_STATUS: Record<NonNullable<MergeJson['mergeStateStatus']>, PullMerge['status']> = {
  CLEAN: 'clean',
  HAS_HOOKS: 'clean',
  UNSTABLE: 'unstable',
  BLOCKED: 'blocked',
  BEHIND: 'behind',
  DIRTY: 'conflicts',
  DRAFT: 'blocked',
  UNKNOWN: 'unknown',
};

const METHOD: Record<'SQUASH' | 'MERGE' | 'REBASE', MergeMethod> = {
  SQUASH: 'squash',
  MERGE: 'merge',
  REBASE: 'rebase',
};

/** Merging needs write access or more. */
const MAY_MERGE = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

/**
 * How the viewer may merge the PR, or nothing when they can't: no write access, or a PR that
 * is closed, merged or a draft. Methods come in the repo's allowed set, the viewer's usual
 * one first.
 */
export function mergeOf(
  pull: MergeJson,
  state: PullState,
  repo: {
    viewerPermission?: string | null;
    squashMergeAllowed?: boolean;
    mergeCommitAllowed?: boolean;
    rebaseMergeAllowed?: boolean;
    viewerDefaultMergeMethod?: 'SQUASH' | 'MERGE' | 'REBASE';
  },
): PullMerge | undefined {
  if ((state !== 'open' && state !== 'queued') || !MAY_MERGE.has(repo.viewerPermission ?? '')) {
    return undefined;
  }
  const checks = { passed: 0, failed: 0, pending: 0, failing: [] as string[] };
  for (const check of pull.statusCheckRollup?.contexts?.nodes ?? []) {
    if (!check) continue;
    const outcome = checkOutcome(check);
    checks[outcome] += 1;
    if (outcome === 'failed') checks.failing.push(check.__typename === 'CheckRun' ? check.name : check.context);
  }
  const allowed: MergeMethod[] = [
    ...(repo.squashMergeAllowed ? ['squash' as const] : []),
    ...(repo.mergeCommitAllowed ? ['merge' as const] : []),
    ...(repo.rebaseMergeAllowed ? ['rebase' as const] : []),
  ];
  const usual = repo.viewerDefaultMergeMethod && METHOD[repo.viewerDefaultMergeMethod];
  const methods = usual && allowed.includes(usual) ? [usual, ...allowed.filter((one) => one !== usual)] : allowed;
  const queued = pull.mergeQueueEntry;
  const size = pull.mergeQueue?.entries?.totalCount;
  const eta = queued ? queued.estimatedTimeToMerge : pull.mergeQueue?.nextEntryEstimatedTimeToMerge;
  return {
    id: pull.id,
    headOid: pull.headRefOid,
    status: MERGE_STATUS[pull.mergeStateStatus ?? 'UNKNOWN'],
    checks,
    methods,
    queue: Boolean(pull.isMergeQueueEnabled),
    ...(pull.isMergeQueueEnabled && size !== undefined ? { queueSize: size } : {}),
    ...(pull.isMergeQueueEnabled && typeof eta === 'number' ? { queueEta: eta } : {}),
    ...(pull.autoMergeRequest ? { auto: true } : {}),
    canAuto: Boolean(pull.viewerCanEnableAutoMerge),
    canBypass: Boolean(pull.viewerCanMergeAsAdmin),
  };
}

interface ReviewJson {
  author: { login: string; avatarUrl?: string } | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
}

interface ReviewRequestJson {
  requestedReviewer: { login?: string; avatarUrl?: string; combinedSlug?: string } | null;
}

interface SuggestionJson {
  isAuthor: boolean;
  isCommenter: boolean;
  reviewer: { login: string } | null;
}

/**
 * GitHub's suggestions without the viewer (GitHub suggests you on others' PRs), the PR's author
 * and anyone already reviewing or asked. `reviewed` wins when both apply: it is the stronger reason.
 */
export function suggestionsOf(
  suggestions: readonly SuggestionJson[],
  skip: { viewer?: string; author?: string; reviewers: readonly Reviewer[] },
): SuggestedReviewer[] {
  const taken = new Set([skip.viewer, skip.author, ...skip.reviewers.map((reviewer) => reviewer.login)]);
  return suggestions.flatMap(({ reviewer, isAuthor, isCommenter }) =>
    reviewer && !taken.has(reviewer.login) && (isAuthor || isCommenter)
      ? [{ login: reviewer.login, why: isCommenter ? ('reviewed' as const) : ('wrote' as const) }]
      : [],
  );
}

/** Asking for reviews takes triage access or more. */
const MAY_REQUEST = new Set(['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE']);

const REVIEW_STATE: Partial<Record<ReviewJson['state'], Reviewer['state']>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes',
  COMMENTED: 'commented',
};

/**
 * Each reviewer once: their latest review, unless a review is asked of them again (then they
 * are pending, as GitHub shows it). Dismissed reviews, the viewer's own unsent draft and the
 * PR's author are left out.
 */
export function reviewersOf(
  reviews: readonly ReviewJson[],
  requests: readonly ReviewRequestJson[],
  author?: string,
): Reviewer[] {
  const pending: Reviewer[] = requests.flatMap(({ requestedReviewer: who }) =>
    who?.login
      ? [{ login: who.login, state: 'pending' as const, ...(who.avatarUrl ? { avatar: who.avatarUrl } : {}) }]
      : who?.combinedSlug
        ? [{ login: who.combinedSlug, team: true, state: 'pending' as const }]
        : [],
  );
  const asked = new Set(pending.map((reviewer) => reviewer.login));
  const reviewed: Reviewer[] = reviews.flatMap(({ author: by, state }) => {
    const mapped = REVIEW_STATE[state];
    return by && mapped && by.login !== author && !asked.has(by.login)
      ? [{ login: by.login, state: mapped, ...(by.avatarUrl ? { avatar: by.avatarUrl } : {}) }]
      : [];
  });
  return [...reviewed, ...pending];
}

/**
 * GitHub's decision when the repo's rules give one. Without rules GitHub gives none, so it
 * follows each reviewer's latest approval or change request: any change request wins, else
 * any approval. Pass those reviews without review requests: neither a later comment nor
 * asking a reviewer again withdraws a verdict.
 */
export function reviewDecisionOf(
  decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null | undefined,
  reviewers: readonly Reviewer[],
): ReviewDecision | undefined {
  if (decision === 'APPROVED') return 'approved';
  if (decision === 'CHANGES_REQUESTED') return 'changes';
  if (decision === 'REVIEW_REQUIRED') return undefined;
  if (reviewers.some((reviewer) => reviewer.state === 'changes')) return 'changes';
  if (reviewers.some((reviewer) => reviewer.state === 'approved')) return 'approved';
  return undefined;
}

const PULL_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    defaultBranchRef { name } viewerPermission
    squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed viewerDefaultMergeMethod
    pullRequest(number: $number) {
      number title body state isDraft isInMergeQueue author { login } baseRefName headRefName
      createdAt mergedAt closedAt mergedBy { login } mergeQueueEntry { position enqueuedAt estimatedTimeToMerge }
      id headRefOid isMergeQueueEnabled mergeStateStatus viewerCanEnableAutoMerge viewerCanMergeAsAdmin
      autoMergeRequest { enabledAt }
      mergeQueue { nextEntryEstimatedTimeToMerge entries { totalCount } }
      statusCheckRollup {
        contexts(first: 100) {
          nodes {
            __typename
            ... on CheckRun { name status conclusion }
            ... on StatusContext { context state }
          }
        }
      }
      headRepository { nameWithOwner } reviewDecision
      latestReviews(first: 20) { nodes { author { login avatarUrl(size: 40) } state } }
      latestOpinionatedReviews(first: 100) { nodes { author { login } state } }
      reviewRequests(first: 20) {
        nodes {
          requestedReviewer {
            ... on User { login avatarUrl(size: 40) }
            ... on Bot { login avatarUrl(size: 40) }
            ... on Mannequin { login avatarUrl(size: 40) }
            ... on Team { combinedSlug }
          }
        }
      }
      suggestedReviewers { isAuthor isCommenter reviewer { login } }
    }
  }
}`;

/** Looks PRs up through the user's `gh` login, like the diff source. */
export function githubStackLookup(ref: GithubRef, signal?: AbortSignal): StackLookup {
  const pulls = `repos/${ref.owner}/${ref.repo}/pulls`;
  const repo = `${ref.owner}/${ref.repo}`.toLowerCase();
  const toMember = (pull: PullJson) => toPull(pull, repo);
  // Every page: the pick rules (oldest open, open before closed) need the whole candidate list.
  const list = async (query: Record<string, string>) =>
    (await ghPaginated<PullJson>(`${pulls}?${new URLSearchParams({ ...query, per_page: '100' })}`, signal)).map(
      toMember,
    );
  // GraphQL, not REST: only GraphQL says whether a PR is in the merge queue. One query also
  // gives the trunk, so a walk opens with one request, not two.
  const query = (number: number) =>
    ghJson<PullGraphJson>(
      [
        'graphql',
        '-f',
        `query=${PULL_QUERY}`,
        '-f',
        `owner=${ref.owner}`,
        '-f',
        `repo=${ref.repo}`,
        '-F',
        `number=${number}`,
      ],
      signal,
    );
  let asked: Promise<PullGraphJson> | undefined;
  const queryOnce = (number: number) => (number === ref.number ? (asked ??= query(number)) : query(number));
  return {
    trunk: async () => {
      const trunk = (await queryOnce(ref.number)).data?.repository?.defaultBranchRef?.name;
      if (!trunk) {
        throw new Error(`No default branch for ${ref.owner}/${ref.repo}`);
      }
      return trunk;
    },
    pull: async (number) => {
      const json = await queryOnce(number);
      const pull = json.data?.repository?.pullRequest;
      if (!pull) {
        throw new Error(`No pull request #${number} in ${ref.owner}/${ref.repo}`);
      }
      const state = pullState({
        open: pull.state === 'OPEN',
        merged: pull.state === 'MERGED',
        draft: pull.isDraft,
        queued: pull.isInMergeQueue,
      });
      const queue = state === 'queued' ? pull.mergeQueueEntry : null;
      const blurb = blurbOf(pull.body);
      const reviewers = reviewersOf(
        pull.latestReviews?.nodes ?? [],
        pull.reviewRequests?.nodes ?? [],
        pull.author?.login,
      );
      const reviewDecision = reviewDecisionOf(
        pull.reviewDecision,
        reviewersOf(pull.latestOpinionatedReviews?.nodes ?? [], [], pull.author?.login),
      );
      const suggestedReviewers = isOpen(state)
        ? suggestionsOf(pull.suggestedReviewers ?? [], {
            viewer: json.data?.viewer?.login,
            author: pull.author?.login,
            reviewers,
          })
        : [];
      const canRequestReviews = isOpen(state) && MAY_REQUEST.has(json.data?.repository?.viewerPermission ?? '');
      const merge = mergeOf(pull, state, json.data?.repository ?? {});
      const since =
        state === 'merged' ? pull.mergedAt : state === 'closed' ? pull.closedAt : (queue?.enqueuedAt ?? pull.createdAt);
      return {
        number: pull.number,
        title: pull.title,
        state,
        ...(since ? { since } : {}),
        ...(state === 'merged' && pull.mergedBy?.login ? { mergedBy: pull.mergedBy.login } : {}),
        ...(queue ? { queuePosition: queue.position } : {}),
        ...(reviewers.length ? { reviewers } : {}),
        ...(reviewDecision ? { reviewDecision } : {}),
        ...(suggestedReviewers.length ? { suggestedReviewers } : {}),
        ...(canRequestReviews ? { canRequestReviews } : {}),
        ...(merge ? { merge } : {}),
        ...(pull.author?.login ? { author: pull.author.login } : {}),
        baseRef: pull.baseRefName,
        headRef: pull.headRefName,
        headInRepo: pull.headRepository?.nameWithOwner.toLowerCase() === repo,
        ...(blurb ? { blurb } : {}),
      };
    },
    byHead: (branch) => list({ head: `${ref.owner}:${branch}`, state: 'all' }),
    byBase: (branch) => list({ base: branch, state: 'open' }),
  };
}

export async function resolveGithubStack(ref: GithubRef, signal?: AbortSignal): Promise<Stack> {
  const members = await walkStack(ref.number, githubStackLookup(ref, signal));
  return { owner: ref.owner, repo: ref.repo, base: members[0]!.baseRef, members };
}
