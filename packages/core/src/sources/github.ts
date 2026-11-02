import type { FileStatus, PullState, RecentTour, ResolvedAsset, SourceRef, StackMember } from '@gloss/protocol';
import { isGithubAssetUrl, serializeRef } from '@gloss/protocol';
import { CommandError, run } from './exec.ts';
import { isGenerated, parseGitattributes } from './gitattributes.ts';
import { assignIds, countChanges, parseHunks, parsePatch, type ParsedFile } from './patch-parser.ts';
import type { DiffSource, FetchedDiff } from './types.ts';

type GithubRef = Extract<SourceRef, { kind: 'github-pr' }>;

interface PullJson {
  title: string;
  body: string | null;
  html_url: string;
  user: { login: string } | null;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
}

interface PullFileJson {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface CommitJson {
  sha: string;
  commit: { message: string };
}

/** Calls the GitHub API through the user's `gh` login, so gloss never handles a token itself. */
export async function gh(args: string[], signal?: AbortSignal, input?: string): Promise<string> {
  try {
    return await run('gh', ['api', ...args], { signal, input });
  } catch (error) {
    if (error instanceof CommandError && /auth login|not logged/i.test(error.stderr)) {
      throw new Error('The GitHub CLI is not signed in. Run `gh auth login`, then try again.', { cause: error });
    }
    throw error;
  }
}

export async function ghJson<T>(args: string[], signal?: AbortSignal): Promise<T> {
  return JSON.parse(await gh(args, signal)) as T;
}

export async function ghPaginated<T>(path: string, signal?: AbortSignal): Promise<T[]> {
  const pages = await ghJson<T[][]>(['--paginate', '--slurp', path], signal);
  return pages.flat();
}

const STATUS: Record<string, FileStatus> = {
  added: 'added',
  removed: 'removed',
  modified: 'modified',
  changed: 'modified',
  renamed: 'renamed',
  copied: 'copied',
};

/** The files API caps a patch per file and omits huge ones; used when the whole-diff endpoint refuses (too large). */
async function filesFromApi(base: string, signal?: AbortSignal): Promise<ParsedFile[]> {
  const files = await ghPaginated<PullFileJson>(`${base}/files?per_page=100`, signal);
  return files.map((file) => {
    const hunks = file.patch ? parseHunks(file.patch.split('\n')) : [];
    const counts = countChanges(hunks);
    return {
      path: file.filename,
      previousPath: file.previous_filename,
      status: STATUS[file.status] ?? 'modified',
      additions: file.additions,
      deletions: file.deletions,
      isBinary: !file.patch && file.additions + file.deletions === 0,
      truncated:
        !file.patch && file.additions + file.deletions > 0
          ? true
          : counts.additions + counts.deletions < file.additions + file.deletions,
      hunks,
    };
  });
}

async function gitattributesAt(owner: string, repo: string, sha: string, signal?: AbortSignal) {
  try {
    const content = await ghJson<{ content: string; encoding: string }>(
      [`repos/${owner}/${repo}/contents/.gitattributes?ref=${sha}`],
      signal,
    );
    return parseGitattributes(Buffer.from(content.content, 'base64').toString('utf8'));
  } catch {
    return [];
  }
}

export function createGithubSource(ref: GithubRef): DiffSource {
  const base = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
  return {
    ref,
    async fingerprint(signal) {
      return (await gh([base, '--jq', '.head.sha'], signal)).trim();
    },
    async fetch(signal): Promise<FetchedDiff> {
      const [pull, commits] = await Promise.all([
        ghJson<PullJson>([base], signal),
        ghPaginated<CommitJson>(`${base}/commits?per_page=100`, signal),
      ]);
      let parsed: ParsedFile[];
      try {
        parsed = parsePatch(await gh(['-H', 'Accept: application/vnd.github.v3.diff', base], signal));
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        parsed = await filesFromApi(base, signal);
      }
      const rules = await gitattributesAt(ref.owner, ref.repo, pull.head.sha, signal);
      const files = assignIds(parsed).map((file) =>
        isGenerated(rules, file.path) ? { ...file, generated: 'gitattributes' as const } : file,
      );
      return {
        meta: {
          title: pull.title,
          description: pull.body ?? undefined,
          url: pull.html_url,
          author: pull.user?.login,
          baseRef: pull.base.ref,
          headRef: pull.head.ref,
          baseSha: pull.base.sha,
          headSha: pull.head.sha,
          commits: commits.map((commit) => ({ sha: commit.sha, subject: commit.commit.message.split('\n')[0] ?? '' })),
        },
        files,
      };
    },
  };
}

/**
 * Resolves a PR body attachment to GitHub's short-lived signed URL (about five minutes),
 * so the page can show images and videos from private repos. GitHub only accepts a token
 * here, not `gh api`, so this reads the `gh` token for the one request and keeps nothing.
 * Returns undefined when GitHub does not redirect (unknown asset, or no access).
 */
export async function resolveGithubAsset(url: string, signal?: AbortSignal): Promise<ResolvedAsset | undefined> {
  if (!isGithubAssetUrl(url)) {
    return undefined;
  }
  const token = (await run('gh', ['auth', 'token', '--hostname', 'github.com'], { signal })).trim();
  const response = await fetch(url, { headers: { Authorization: `token ${token}` }, redirect: 'manual', signal });
  const location = response.headers.get('location');
  if (response.status < 300 || response.status >= 400 || !location) {
    return undefined;
  }
  return { url: location, contentType: new URL(location).searchParams.get('response-content-type') ?? undefined };
}

/** PRs per GraphQL query; well under GitHub's node limits. */
const PULLS_PER_QUERY = 50;

/** GitHub's flags as one state. A merged PR is closed too, so merged wins over closed. */
export function pullState(pull: { open: boolean; merged: boolean; draft?: boolean; queued?: boolean }): PullState {
  if (!pull.open) {
    return pull.merged ? 'merged' : 'closed';
  }
  return pull.queued ? 'queued' : pull.draft ? 'draft' : 'open';
}

/** A PR's author and current state, as the side rail shows them. */
export interface PullSummary {
  author?: string;
  state: PullState;
}

/** One GraphQL query that asks for each PR's author and state, aliased `p0`, `p1`, … in `refs` order. */
export function pullsQuery(refs: readonly GithubRef[]): string {
  // JSON string literals are valid GraphQL string literals, so owner and repo names stay quoted.
  const fields = refs.map(
    (ref, index) =>
      `p${index}: repository(owner: ${JSON.stringify(ref.owner)}, name: ${JSON.stringify(ref.repo)}) { pullRequest(number: ${ref.number}) { author { login } state isDraft isInMergeQueue } }`,
  );
  return `query { ${fields.join(' ')} }`;
}

export type PullsJson = {
  data: Record<
    string,
    {
      pullRequest: {
        author: { login: string } | null;
        state: 'OPEN' | 'CLOSED' | 'MERGED';
        isDraft: boolean;
        isInMergeQueue: boolean;
      } | null;
    } | null
  >;
};

/**
 * Each PR's author and state, keyed by `serializeRef`, in one `gh` call per 50 PRs instead of
 * one REST call each. GitHub fails a whole query when one PR in it is gone or out of reach, so
 * a failed batch is split in half and retried, until the PRs it cannot see are left out alone.
 */
export async function githubPulls(
  refs: readonly GithubRef[],
  signal?: AbortSignal,
  query: (text: string) => Promise<PullsJson> = (text) => ghJson(['graphql', '-f', `query=${text}`], signal),
): Promise<Map<string, PullSummary>> {
  const pulls = new Map<string, PullSummary>();
  const lookup = async (batch: readonly GithubRef[]): Promise<void> => {
    let json: PullsJson;
    try {
      json = await query(pullsQuery(batch));
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      if (batch.length === 1) {
        return;
      }
      const half = Math.ceil(batch.length / 2);
      await lookup(batch.slice(0, half));
      await lookup(batch.slice(half));
      return;
    }
    batch.forEach((ref, index) => {
      const pull = json.data?.[`p${index}`]?.pullRequest;
      if (pull) {
        const state = pullState({
          open: pull.state === 'OPEN',
          merged: pull.state === 'MERGED',
          draft: pull.isDraft,
          queued: pull.isInMergeQueue,
        });
        pulls.set(serializeRef(ref), { ...(pull.author?.login ? { author: pull.author.login } : {}), state });
      }
    });
  };
  for (let start = 0; start < refs.length; start += PULLS_PER_QUERY) {
    await lookup(refs.slice(start, start + PULLS_PER_QUERY));
  }
  return pulls;
}

/** The `gh` login: whose PRs are "mine". */
export async function githubViewer(signal?: AbortSignal): Promise<string> {
  return (await gh(['user', '--jq', '.login'], signal)).trim();
}

/** Open PRs per inbox list; the side rail shows them all. */
const INBOX_LIMIT = 50;

const INBOX_FIELDS =
  'nodes { ... on PullRequest { number title state isDraft isInMergeQueue updatedAt author { login } baseRefName headRefName repository { owner { login } name } } }';

/** One GraphQL query for the open PRs that ask for the viewer's review and the open PRs they wrote. */
export const INBOX_QUERY = `query {
  review: search(query: "is:pr is:open archived:false review-requested:@me sort:updated-desc", type: ISSUE, first: ${INBOX_LIMIT}) { ${INBOX_FIELDS} }
  authored: search(query: "is:pr is:open archived:false author:@me sort:updated-desc", type: ISSUE, first: ${INBOX_LIMIT}) { ${INBOX_FIELDS} }
}`;

interface InboxNode {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  isInMergeQueue: boolean;
  updatedAt: string;
  author: { login: string } | null;
  baseRefName: string;
  headRefName: string;
  repository: { owner: { login: string }; name: string };
}

export type InboxJson = { data: { review: { nodes: InboxNode[] }; authored: { nodes: InboxNode[] } } };

/** The viewer's open PRs and the open PRs waiting on their review, newest first, each in its stack. */
export interface Inbox {
  reviewRequested: RecentTour[];
  authored: RecentTour[];
}

/**
 * PRs from a search as rows, newest first. PRs in one repo whose base branch is another's
 * head branch chain into a stack (bottom first), so a stack of open PRs shows as one, without
 * walking it on GitHub.
 */
export function inboxTours(nodes: readonly InboxNode[]): RecentTour[] {
  const pulls = nodes.filter((node) => node.number !== undefined && node.repository);
  const repoOf = (node: InboxNode) => `${node.repository.owner.login}/${node.repository.name}`.toLowerCase();
  const byHead = new Map(pulls.map((node) => [`${repoOf(node)}:${node.headRefName}`, node]));
  const above = new Map(pulls.map((node) => [`${repoOf(node)}:${node.baseRefName}`, node]));
  const member = (node: InboxNode): StackMember => ({
    number: node.number,
    title: node.title,
    state: pullState({
      open: node.state === 'OPEN',
      merged: node.state === 'MERGED',
      draft: node.isDraft,
      queued: node.isInMergeQueue,
    }),
    ...(node.author?.login ? { author: node.author.login } : {}),
    baseRef: node.baseRefName,
    headRef: node.headRefName,
  });
  return pulls.map((node) => {
    // Walk down to the bottom, then up to the top; `seen` stops a cycle of branches.
    const seen = new Set([node]);
    let bottom = node;
    for (let below = byHead.get(`${repoOf(bottom)}:${bottom.baseRefName}`); below && !seen.has(below);) {
      seen.add(below);
      bottom = below;
      below = byHead.get(`${repoOf(bottom)}:${bottom.baseRefName}`);
    }
    const chain = [bottom];
    for (let next = above.get(`${repoOf(bottom)}:${bottom.headRefName}`); next && !chain.includes(next);) {
      chain.push(next);
      next = above.get(`${repoOf(next)}:${next.headRefName}`);
    }
    const ref: GithubRef = {
      kind: 'github-pr',
      owner: node.repository.owner.login,
      repo: node.repository.name,
      number: node.number,
    };
    const own = member(node);
    return {
      ref,
      title: node.title,
      ...(own.author ? { author: own.author } : {}),
      state: own.state,
      updatedAt: node.updatedAt,
      ...(chain.length > 1
        ? { stack: { owner: ref.owner, repo: ref.repo, base: bottom.baseRefName, members: chain.map(member) } }
        : {}),
    };
  });
}

/** The viewer's inbox through one `gh` GraphQL call. */
export async function githubInbox(
  signal?: AbortSignal,
  query: () => Promise<InboxJson> = () => ghJson(['graphql', '-f', `query=${INBOX_QUERY}`], signal),
): Promise<Inbox> {
  const { data } = await query();
  return { reviewRequested: inboxTours(data.review.nodes), authored: inboxTours(data.authored.nodes) };
}
