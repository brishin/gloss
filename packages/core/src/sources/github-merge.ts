import type { MergeRequest, StackMember } from '@gloss/protocol';
import { CommandError } from './exec.ts';
import { githubStackLookup } from './github-stack.ts';
import { gh } from './github.ts';

const MERGE = `mutation($id: ID!, $method: PullRequestMergeMethod!, $head: GitObjectID) {
  mergePullRequest(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $head }) { clientMutationId }
}`;
const ENQUEUE = `mutation($id: ID!, $head: GitObjectID) {
  enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) { clientMutationId }
}`;
const DEQUEUE = `mutation($id: ID!) { dequeuePullRequest(input: { id: $id }) { clientMutationId } }`;
const AUTO = `mutation($id: ID!, $method: PullRequestMergeMethod!, $head: GitObjectID) {
  enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $head }) { clientMutationId }
}`;
const CANCEL = `mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }`;

/** A GitHub call: a mutation and its variables. */
export interface MergeCall {
  query: string;
  vars: Record<string, string>;
}

/**
 * The mutation a merge request comes to, given the PR as GitHub has it now. `ready` merges (or
 * joins the queue) at once when nothing is left; otherwise auto-merge does it once checks and
 * reviews clear, and on a queued base that means joining the queue then. A queue sets its own
 * method, so a queued base never sends one that matters.
 */
export function mergeCall(request: MergeRequest, merge: NonNullable<StackMember['merge']>): MergeCall {
  const id = merge.id;
  const method = merge.method;
  const head: Record<string, string> = request.headOid ? { head: request.headOid } : {};
  const withMethod: Record<string, string> = { id, method: method.toUpperCase(), ...head };
  switch (request.action) {
    case 'now':
      return merge.queue ? { query: ENQUEUE, vars: { id, ...head } } : { query: MERGE, vars: withMethod };
    case 'ready': {
      const ready = merge.status === 'clean' || merge.status === 'unstable';
      if (ready) {
        return merge.queue ? { query: ENQUEUE, vars: { id, ...head } } : { query: MERGE, vars: withMethod };
      }
      return { query: AUTO, vars: withMethod };
    }
    case 'cancel':
      return { query: CANCEL, vars: { id } };
    case 'dequeue':
      return { query: DEQUEUE, vars: { id } };
  }
}

/** GitHub's refusal ("Pull request is not mergeable", a newer head) as the error message. */
async function call({ query, vars }: MergeCall, signal: AbortSignal | undefined): Promise<void> {
  const args = [
    'graphql',
    '-f',
    `query=${query}`,
    ...Object.entries(vars).flatMap(([key, value]) => ['-f', `${key}=${value}`]),
  ];
  try {
    await gh(args, signal);
  } catch (error) {
    if (error instanceof CommandError && error.stderr.trim()) {
      throw new Error(
        error.stderr
          .trim()
          .replace(/^gh: /, '')
          .replace(/^GraphQL: /, ''),
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Merges, queues or turns auto-merge on or off as the user's `gh` login, then reads the PR
 * again: the answer is GitHub's state after the change, not a guess at it.
 */
export async function mergeGithubPull(request: MergeRequest, signal?: AbortSignal): Promise<StackMember> {
  const ref = { kind: 'github-pr', owner: request.owner, repo: request.repo, number: request.number } as const;
  const before = await githubStackLookup(ref, signal).pull(request.number);
  if (!before.merge) {
    throw new Error(
      before.state === 'merged'
        ? 'Already merged'
        : before.state === 'draft'
          ? 'Drafts cannot merge'
          : 'You cannot merge this pull request',
    );
  }
  await call(mergeCall(request, before.merge), signal);
  const { headInRepo: _, ...after } = await githubStackLookup(ref, signal).pull(request.number);
  return after;
}
