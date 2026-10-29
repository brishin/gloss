import type { PullState, SourceRef, Stack, StackMember } from '@gloss/protocol';
import { run } from './exec.ts';

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

/** The PR below: prefer an open one, else the most recent (highest number) merged or closed one. */
function pickBelow(candidates: StackPull[]): StackPull | undefined {
  const sorted = candidates.toSorted((a, b) => b.number - a.number);
  return sorted.find((pull) => pull.state === 'open' || pull.state === 'draft') ?? sorted[0];
}

/** The PR above: the oldest open one. A branch with several PRs on it is a tree; gloss shows one line of it. */
function pickAbove(candidates: StackPull[]): StackPull | undefined {
  return candidates
    .filter((pull) => pull.state === 'open' || pull.state === 'draft')
    .toSorted((a, b) => a.number - b.number)[0];
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
  return [...below, current, ...above].map(({ number, title, state, baseRef, headRef }) => ({
    number,
    title,
    state,
    baseRef,
    headRef,
  }));
}

interface PullJson {
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft?: boolean;
  merged_at: string | null;
  base: { ref: string };
  head: { ref: string; repo: { full_name: string } | null };
}

function toPull(pull: PullJson, repo: string): StackPull {
  const state: PullState =
    pull.state === 'open' ? (pull.draft ? 'draft' : 'open') : pull.merged_at ? 'merged' : 'closed';
  return {
    number: pull.number,
    title: pull.title,
    state,
    baseRef: pull.base.ref,
    headRef: pull.head.ref,
    headInRepo: pull.head.repo?.full_name.toLowerCase() === repo,
  };
}

/** Looks PRs up through the user's `gh` login, like the diff source. */
export function githubStackLookup(ref: GithubRef, signal?: AbortSignal): StackLookup {
  const pulls = `repos/${ref.owner}/${ref.repo}/pulls`;
  const repo = `${ref.owner}/${ref.repo}`.toLowerCase();
  const toMember = (pull: PullJson) => toPull(pull, repo);
  const list = async (query: Record<string, string>) =>
    (
      JSON.parse(
        await run('gh', ['api', `${pulls}?${new URLSearchParams({ ...query, per_page: '30' })}`], { signal }),
      ) as PullJson[]
    ).map(toMember);
  return {
    trunk: async () =>
      (JSON.parse(await run('gh', ['api', `repos/${ref.owner}/${ref.repo}`], { signal })) as { default_branch: string })
        .default_branch,
    pull: async (number) =>
      toMember(JSON.parse(await run('gh', ['api', `${pulls}/${number}`], { signal })) as PullJson),
    byHead: (branch) => list({ head: `${ref.owner}:${branch}`, state: 'all' }),
    byBase: (branch) => list({ base: branch, state: 'open' }),
  };
}

export async function resolveGithubStack(ref: GithubRef, signal?: AbortSignal): Promise<Stack> {
  const members = await walkStack(ref.number, githubStackLookup(ref, signal));
  return { owner: ref.owner, repo: ref.repo, base: members[0]!.baseRef, members };
}
