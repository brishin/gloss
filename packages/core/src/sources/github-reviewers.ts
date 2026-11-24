import type { ReviewerCandidate, ReviewersRequest, ReviewersResult } from '@gloss/protocol';
import { CommandError } from './exec.ts';
import { githubStackLookup } from './github-stack.ts';
import { gh, ghJson } from './github.ts';

type Who = NonNullable<ReviewersRequest['add']>[number];

/**
 * The body of `POST`/`DELETE /repos/{owner}/{repo}/pulls/{number}/requested_reviewers`: users by
 * login, teams by slug (a team's login is `org/slug`).
 */
export function reviewersPayload(who: readonly Who[]) {
  return {
    reviewers: who.filter((one) => !one.team).map((one) => one.login),
    team_reviewers: who.filter((one) => one.team).map((one) => one.login.slice(one.login.indexOf('/') + 1)),
  };
}

/** GitHub's refusal (say, someone without access to the repo) as the error message. */
async function call(args: string[], signal: AbortSignal | undefined, input: string): Promise<void> {
  try {
    await gh(args, signal, input);
  } catch (error) {
    if (error instanceof CommandError && error.stderr.trim()) {
      throw new Error(error.stderr.trim().replace(/^gh: /, ''), { cause: error });
    }
    throw error;
  }
}

/**
 * Asks for reviews, or withdraws asks, as the user's `gh` login, then reads the PR again: the
 * answer is GitHub's list of reviewers and suggestions after the change, not a guess at it.
 */
export async function requestGithubReviewers(
  request: ReviewersRequest,
  signal?: AbortSignal,
): Promise<ReviewersResult> {
  const path = `repos/${request.owner}/${request.repo}/pulls/${request.number}/requested_reviewers`;
  if (request.add?.length) {
    await call(['--method', 'POST', path, '--input', '-'], signal, JSON.stringify(reviewersPayload(request.add)));
  }
  if (request.remove?.length) {
    await call(['--method', 'DELETE', path, '--input', '-'], signal, JSON.stringify(reviewersPayload(request.remove)));
  }
  const ref = { kind: 'github-pr', owner: request.owner, repo: request.repo, number: request.number } as const;
  const pull = await githubStackLookup(ref, signal).pull(request.number);
  return { reviewers: pull.reviewers ?? [], suggestedReviewers: pull.suggestedReviewers ?? [] };
}

interface CandidatesJson {
  data?: {
    repository?: { assignableUsers?: { nodes: ({ login: string; name: string | null } | null)[] } | null } | null;
  };
}

const CANDIDATES_QUERY = `query($owner: String!, $repo: String!, $search: String!) {
  repository(owner: $owner, name: $repo) {
    assignableUsers(query: $search, first: 8) { nodes { login name } }
  }
}`;

/**
 * Collaborators matching `query` by login or name: the people a review can be asked of. The
 * variable is `search`: `gh api graphql` keeps `query` for the query text itself.
 */
export async function searchGithubReviewers(
  owner: string,
  repo: string,
  query: string,
  signal?: AbortSignal,
): Promise<ReviewerCandidate[]> {
  const json = await ghJson<CandidatesJson>(
    [
      'graphql',
      '-f',
      `query=${CANDIDATES_QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `repo=${repo}`,
      '-f',
      `search=${query}`,
    ],
    signal,
  );
  return (json.data?.repository?.assignableUsers?.nodes ?? []).flatMap((node) =>
    node ? [{ login: node.login, ...(node.name ? { name: node.name } : {}) }] : [],
  );
}
