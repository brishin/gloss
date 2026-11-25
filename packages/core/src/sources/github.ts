import type {
  FileStatus,
  PullActivity,
  PullState,
  RecentTour,
  ResolvedAsset,
  SourceRef,
  StackMember,
} from '@gloss/protocol';
import { isGithubAssetUrl, serializeRef } from '@gloss/protocol';
import { CommandError, run } from './exec.ts';
import { isGenerated, parseGitattributes } from './gitattributes.ts';
import { reviewDecisionOf, reviewersOf } from './github-stack.ts';
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

const AVATAR = 'avatarUrl(size: 40)';

const INBOX_FIELDS = `nodes { ... on PullRequest {
  id number title state isDraft isInMergeQueue updatedAt author { login } baseRefName headRefName
  repository { owner { login } name }
  additions deletions reviewDecision
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
  latestReviews(first: 20) { nodes { author { __typename login ${AVATAR} } state submittedAt commit { oid } } }
  latestOpinionatedReviews(first: 100) { nodes { author { __typename login } state } }
  reviewRequests(first: 20) { nodes { requestedReviewer {
    __typename
    ... on User { login ${AVATAR} }
    ... on Bot { login ${AVATAR} }
    ... on Mannequin { login ${AVATAR} }
    ... on Team { combinedSlug }
  } } }
  reviewThreads(first: 100) { nodes { isResolved } }
} }`;

/**
 * Who said what on some PRs, by node id. Kept apart from the inbox query: a thread's comments are a
 * connection per thread, which costs GitHub's rate limit far more than the rest of the inbox, so
 * they are read only for PRs that changed since the last read.
 */
export const talkQuery = (ids: readonly string[]) => `query {
  nodes(ids: ${JSON.stringify(ids)}) { ... on PullRequest {
    id
    comments(first: 100) { nodes { author { __typename } } }
    reviews(first: 50) { nodes { author { __typename } body } }
    reviewThreads(first: 50) { nodes { comments(first: 20) { nodes { author { __typename } } } } }
  } }
}`;

/**
 * One GraphQL query for the open PRs that ask for the viewer's review, the open PRs by others
 * they have already reviewed (GitHub drops the review request once they review, so a push after
 * it is only found here), and the open PRs they wrote, each with what the dashboard shows.
 */
export const INBOX_QUERY = `query {
  viewer { login }
  review: search(query: "is:pr is:open archived:false review-requested:@me sort:updated-desc", type: ISSUE, first: ${INBOX_LIMIT}) { ${INBOX_FIELDS} }
  reviewed: search(query: "is:pr is:open archived:false reviewed-by:@me -author:@me sort:updated-desc", type: ISSUE, first: ${INBOX_LIMIT}) { ${INBOX_FIELDS} }
  authored: search(query: "is:pr is:open archived:false author:@me sort:updated-desc", type: ISSUE, first: ${INBOX_LIMIT}) { ${INBOX_FIELDS} }
}`;

/** An author as the inbox reads it; `Bot` covers GitHub Apps such as review bots. */
interface InboxAuthor {
  __typename?: string;
  login?: string;
  avatarUrl?: string;
}

export interface InboxNode {
  id?: string;
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
  additions?: number;
  deletions?: number;
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  commits?: {
    nodes: { commit: { oid?: string; statusCheckRollup: { state: string } | null } }[];
  } | null;
  latestReviews?: {
    nodes: {
      author: InboxAuthor | null;
      state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
      submittedAt: string | null;
      commit?: { oid: string } | null;
    }[];
  } | null;
  latestOpinionatedReviews?: {
    nodes: {
      author: InboxAuthor | null;
      state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
    }[];
  } | null;
  reviewRequests?: { nodes: { requestedReviewer: (InboxAuthor & { combinedSlug?: string }) | null }[] } | null;
  reviewThreads?: { nodes: { isResolved: boolean }[] } | null;
}

/** A PR's talk as `talkQuery` reads it. */
export interface TalkNode {
  id: string;
  comments?: { nodes: { author: InboxAuthor | null }[] } | null;
  reviews?: { nodes: { author: InboxAuthor | null; body: string }[] } | null;
  reviewThreads?: { nodes: { comments: { nodes: { author: InboxAuthor | null }[] } | null }[] } | null;
}

/** Comments, line comments and review notes, from people and from bots; a review counts only when it says something. */
export function talkOf(node: TalkNode): { people: number; bots: number } {
  const talk = [
    ...(node.comments?.nodes ?? []),
    ...(node.reviews?.nodes ?? []).filter((review) => review.body.trim() !== ''),
    ...(node.reviewThreads?.nodes ?? []).flatMap((thread) => thread.comments?.nodes ?? []),
  ];
  const bots = talk.filter((each) => isBot(each.author)).length;
  return { people: talk.length - bots, bots };
}

export type InboxJson = {
  data: {
    viewer?: { login: string };
    review: { nodes: InboxNode[] };
    reviewed: { nodes: InboxNode[] };
    authored: { nodes: InboxNode[] };
  };
};

/** The viewer's open PRs and the open PRs by others waiting on, or already given, their review, newest first, each in its stack. */
export interface Inbox {
  reviewRequested: RecentTour[];
  /** Open PRs by others the viewer has reviewed, whether or not they ask again. */
  reviewed: RecentTour[];
  authored: RecentTour[];
}

/** Review bots (Devin, Cursor, Codex, ...) are GitHub Apps: GraphQL types their author `Bot`. */
const isBot = (author: InboxAuthor | null | undefined) => author?.__typename === 'Bot';

const CHECKS: Record<string, PullActivity['checks']> = {
  SUCCESS: 'passing',
  FAILURE: 'failing',
  ERROR: 'failing',
  PENDING: 'pending',
  EXPECTED: 'pending',
};

/** What the dashboard shows of a PR. Bots are left out of the reviewers; `comments` comes from `talkOf`. */
export function activityOf(
  node: InboxNode,
  viewer?: string,
  comments?: { people: number; bots: number },
): PullActivity {
  const head = node.commits?.nodes.at(-1)?.commit;
  const reviews = (node.latestReviews?.nodes ?? []).filter((review) => !isBot(review.author));
  const requests = (node.reviewRequests?.nodes ?? []).filter((request) => !isBot(request.requestedReviewer));
  const reviewers = reviewersOf(
    reviews.map((review) => ({
      author: review.author?.login ? { login: review.author.login, avatarUrl: review.author.avatarUrl } : null,
      state: review.state,
    })),
    requests.map((request) => ({ requestedReviewer: request.requestedReviewer })),
    node.author?.login,
  );
  const viewerReview =
    viewer && node.author?.login !== viewer ? reviews.find((review) => review.author?.login === viewer) : undefined;
  const viewerReviewedAt = viewerReview?.submittedAt ?? undefined;
  // A push since the review: the head is not the commit reviewed. Commit times can predate the push.
  const reviewedOid = viewerReview?.commit?.oid;
  const pushedSinceReview = !!reviewedOid && !!head?.oid && head.oid !== reviewedOid;
  // Without repo rules, each reviewer's latest approval or change request decides, as in `githubStackLookup`:
  // the display reviewers lose a verdict to a later comment or a new request.
  const verdicts = (node.latestOpinionatedReviews?.nodes ?? [])
    .filter((review) => !isBot(review.author))
    .map((review) => ({ author: review.author?.login ? { login: review.author.login } : null, state: review.state }));
  const reviewDecision = reviewDecisionOf(node.reviewDecision, reviewersOf(verdicts, [], node.author?.login));
  const checks = head?.statusCheckRollup ? CHECKS[head.statusCheckRollup.state] : undefined;
  return {
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    ...(checks ? { checks } : {}),
    updatedAt: node.updatedAt,
    reviewers,
    ...(reviewDecision ? { reviewDecision } : {}),
    openThreads: (node.reviewThreads?.nodes ?? []).filter((thread) => !thread.isResolved).length,
    ...(comments ? { comments } : {}),
    ...(viewerReviewedAt ? { viewerReviewedAt } : {}),
    ...(pushedSinceReview ? { pushedSinceReview } : {}),
  };
}

/**
 * PRs from a search as rows, newest first. PRs in one repo whose base branch is another's
 * head branch chain into a stack (bottom first), so a stack of open PRs shows as one, without
 * walking it on GitHub.
 */
export function inboxTours(
  nodes: readonly InboxNode[],
  viewer?: string,
  talk: ReadonlyMap<string, { people: number; bots: number }> = new Map(),
): RecentTour[] {
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
    activity: activityOf(node, viewer, node.id ? talk.get(node.id) : undefined),
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
      ...(own.activity ? { activity: own.activity } : {}),
      ...(chain.length > 1
        ? { stack: { owner: ref.owner, repo: ref.repo, base: bottom.baseRefName, members: chain.map(member) } }
        : {}),
    };
  });
}

/** How many PRs one talk query reads. */
const TALK_BATCH = 25;

/**
 * Reads the viewer's inbox. Each PR's talk is kept by node id and `updatedAt` (a new comment
 * moves it), so after the first read only PRs that changed are asked for again. A failed talk
 * read leaves those PRs without counts rather than failing the inbox.
 */
export function createInboxReader(
  run: {
    inbox: (signal?: AbortSignal) => Promise<InboxJson>;
    talk: (ids: readonly string[], signal?: AbortSignal) => Promise<TalkNode[]>;
  } = {
    inbox: (signal) => ghJson(['graphql', '-f', `query=${INBOX_QUERY}`], signal),
    talk: async (ids, signal) =>
      (
        await ghJson<{ data: { nodes: (TalkNode | null)[] } }>(['graphql', '-f', `query=${talkQuery(ids)}`], signal)
      ).data.nodes.filter((node): node is TalkNode => !!node),
  },
): (signal?: AbortSignal) => Promise<Inbox> {
  const kept = new Map<string, { updatedAt: string; talk: { people: number; bots: number } }>();
  return async (signal) => {
    const { data } = await run.inbox(signal);
    const viewer = data.viewer?.login;
    const nodes = [...data.review.nodes, ...data.reviewed.nodes, ...data.authored.nodes];
    const stale = [
      ...new Set(
        nodes.filter((node) => node.id && kept.get(node.id)?.updatedAt !== node.updatedAt).map((node) => node.id!),
      ),
    ];
    const updatedAt = new Map(nodes.flatMap((node) => (node.id ? [[node.id, node.updatedAt] as const] : [])));
    for (let start = 0; start < stale.length; start += TALK_BATCH) {
      const read = await run.talk(stale.slice(start, start + TALK_BATCH), signal).catch(() => []);
      for (const node of read) {
        kept.set(node.id, { updatedAt: updatedAt.get(node.id) ?? '', talk: talkOf(node) });
      }
    }
    const talk = new Map([...kept].map(([id, entry]) => [id, entry.talk]));
    return {
      reviewRequested: inboxTours(data.review.nodes, viewer, talk),
      reviewed: inboxTours(data.reviewed.nodes, viewer, talk),
      authored: inboxTours(data.authored.nodes, viewer, talk),
    };
  };
}
