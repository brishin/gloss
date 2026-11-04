import type { PullState, ReviewDecision, Reviewer, SourceRef, Stack, StackMember } from '@gloss/protocol';
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
  const { since, mergedBy, queuePosition, reviewers } = current;
  return [
    ...below.map(member),
    {
      ...member(current),
      ...(since ? { since } : {}),
      ...(mergedBy ? { mergedBy } : {}),
      ...(queuePosition ? { queuePosition } : {}),
      ...(reviewers?.length ? { reviewers } : {}),
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
    repository?: {
      pullRequest?: {
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
        mergeQueueEntry: { position: number; enqueuedAt: string } | null;
        author: { login: string } | null;
        baseRefName: string;
        headRefName: string;
        headRepository: { nameWithOwner: string } | null;
        reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
        latestReviews: { nodes: ReviewJson[] } | null;
        reviewRequests: { nodes: ReviewRequestJson[] } | null;
      } | null;
      defaultBranchRef: { name: string } | null;
    } | null;
  };
}

interface ReviewJson {
  author: { login: string } | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
}

interface ReviewRequestJson {
  requestedReviewer: { login?: string; combinedSlug?: string } | null;
}

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
      ? [{ login: who.login, state: 'pending' as const }]
      : who?.combinedSlug
        ? [{ login: who.combinedSlug, team: true, state: 'pending' as const }]
        : [],
  );
  const asked = new Set(pending.map((reviewer) => reviewer.login));
  const reviewed: Reviewer[] = reviews.flatMap(({ author: by, state }) => {
    const mapped = REVIEW_STATE[state];
    return by && mapped && by.login !== author && !asked.has(by.login) ? [{ login: by.login, state: mapped }] : [];
  });
  return [...reviewed, ...pending];
}

/**
 * GitHub's decision when the repo's rules give one. Without rules GitHub gives none, so it
 * follows the reviews: any change request wins, else any approval.
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
  repository(owner: $owner, name: $repo) {
    defaultBranchRef { name }
    pullRequest(number: $number) {
      number title body state isDraft isInMergeQueue author { login } baseRefName headRefName
      createdAt mergedAt closedAt mergedBy { login } mergeQueueEntry { position enqueuedAt }
      headRepository { nameWithOwner } reviewDecision
      latestReviews(first: 20) { nodes { author { login } state } }
      reviewRequests(first: 20) {
        nodes { requestedReviewer { ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { combinedSlug } } }
      }
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
      const reviewDecision = reviewDecisionOf(pull.reviewDecision, reviewers);
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
