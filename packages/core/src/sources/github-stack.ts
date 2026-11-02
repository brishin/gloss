import type { PullState, SourceRef, Stack, StackMember } from '@gloss/protocol';
import { ghJson, ghPaginated } from './github.ts';

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
  const member = ({ number, title, state, author, baseRef, headRef }: StackPull): StackMember => ({
    number,
    title,
    state,
    ...(author ? { author } : {}),
    baseRef,
    headRef,
  });
  const { since, mergedBy, queuePosition } = current;
  return [
    ...below.map(member),
    {
      ...member(current),
      ...(since ? { since } : {}),
      ...(mergedBy ? { mergedBy } : {}),
      ...(queuePosition ? { queuePosition } : {}),
    },
    ...above.map(member),
  ];
}

interface PullJson {
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft?: boolean;
  merged_at: string | null;
  user?: { login: string } | null;
  base: { ref: string };
  head: { ref: string; repo: { full_name: string } | null };
}

/** GitHub's flags as one state. A merged PR is closed too, so merged wins over closed. */
export function pullState(pull: { open: boolean; merged: boolean; draft?: boolean; queued?: boolean }): PullState {
  if (!pull.open) {
    return pull.merged ? 'merged' : 'closed';
  }
  return pull.queued ? 'queued' : pull.draft ? 'draft' : 'open';
}

function toPull(pull: PullJson, repo: string): StackPull {
  return {
    number: pull.number,
    title: pull.title,
    state: pullState({ open: pull.state === 'open', merged: !!pull.merged_at, draft: pull.draft }),
    ...(pull.user?.login ? { author: pull.user.login } : {}),
    baseRef: pull.base.ref,
    headRef: pull.head.ref,
    headInRepo: pull.head.repo?.full_name.toLowerCase() === repo,
  };
}

interface PullGraphJson {
  data?: {
    repository?: {
      pullRequest?: {
        number: number;
        title: string;
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
      } | null;
    } | null;
  };
}

const PULL_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number title state isDraft isInMergeQueue author { login } baseRefName headRefName
      createdAt mergedAt closedAt mergedBy { login } mergeQueueEntry { position enqueuedAt }
      headRepository { nameWithOwner }
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
  return {
    trunk: async () =>
      (await ghJson<{ default_branch: string }>([`repos/${ref.owner}/${ref.repo}`], signal)).default_branch,
    // GraphQL, not REST: only GraphQL says whether a PR is in the merge queue.
    pull: async (number) => {
      const json = await ghJson<PullGraphJson>(
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
      const since =
        state === 'merged' ? pull.mergedAt : state === 'closed' ? pull.closedAt : (queue?.enqueuedAt ?? pull.createdAt);
      return {
        number: pull.number,
        title: pull.title,
        state,
        ...(since ? { since } : {}),
        ...(state === 'merged' && pull.mergedBy?.login ? { mergedBy: pull.mergedBy.login } : {}),
        ...(queue ? { queuePosition: queue.position } : {}),
        ...(pull.author?.login ? { author: pull.author.login } : {}),
        baseRef: pull.baseRefName,
        headRef: pull.headRefName,
        headInRepo: pull.headRepository?.nameWithOwner.toLowerCase() === repo,
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
