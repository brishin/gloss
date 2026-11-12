import type { ReviewThread, SourceRef, ThreadComment, ThreadReplyRequest, ThreadResolveRequest } from '@gloss/protocol';
import { CommandError } from './exec.ts';
import { ghJson } from './github.ts';

type GithubRef = Extract<SourceRef, { kind: 'github-pr' }>;

const COMMENT_FIELDS = 'id author { login avatarUrl(size: 48) } body createdAt url';

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line startLine diffSide
          opener: comments(first: 1) { nodes { ${COMMENT_FIELDS} diffHunk } }
          comments(last: 99) { nodes { ${COMMENT_FIELDS} diffHunk } }
        }
      }
    }
  }
}`;

interface CommentJson {
  id: string;
  author: { login: string; avatarUrl?: string } | null;
  body: string;
  createdAt: string;
  url: string;
  diffHunk?: string;
}

export interface ThreadJson {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  diffSide: 'LEFT' | 'RIGHT';
  /** The first comment, which a thread past 100 comments would otherwise lose. */
  opener?: { nodes: CommentJson[] };
  /** The latest 99 comments: a long thread keeps its opener and its newest replies. */
  comments: { nodes: CommentJson[] };
}

interface ThreadsPage {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ThreadJson[] };
      } | null;
    } | null;
  };
}

/** Never more than this many pages of 100 threads: a PR past that has bigger problems than this list. */
const MAX_PAGES = 5;

const comment = (json: CommentJson): ThreadComment => ({
  id: json.id,
  author: json.author?.login ?? 'ghost',
  ...(json.author?.avatarUrl ? { avatar: json.author.avatarUrl } : {}),
  body: json.body,
  createdAt: json.createdAt,
  url: json.url,
});

/** The last row of a comment's diff hunk: the line the thread was left on. */
const hunkLine = (hunk: string | undefined): string | undefined => {
  const last = hunk?.split('\n').at(-1);
  return last && !last.startsWith('@@') ? last.slice(1) : undefined;
};

/** A thread as the page shows it; one with no comments left (all deleted) is dropped. */
export function threadFromJson(json: ThreadJson): ReviewThread | undefined {
  const latest = json.comments.nodes;
  const opener = json.opener?.nodes[0];
  const comments = opener && !latest.some((c) => c.id === opener.id) ? [opener, ...latest] : latest;
  if (!comments.length) {
    return undefined;
  }
  const outdated = json.isOutdated || json.line === null;
  return {
    id: json.id,
    path: json.path,
    side: json.diffSide === 'LEFT' ? 'deletions' : 'additions',
    ...(outdated ? {} : { line: json.line! }),
    ...(!outdated && json.startLine !== null && json.startLine < json.line! ? { startLine: json.startLine } : {}),
    resolved: json.isResolved,
    outdated,
    ...(outdated ? { quote: hunkLine(comments[0]!.diffHunk) } : {}),
    comments: comments.map(comment),
  };
}

/** The PR's line comment threads, oldest first, through the user's `gh` login. */
export async function fetchReviewThreads(
  ref: GithubRef,
  signal?: AbortSignal,
  query: (after: string | undefined) => Promise<ThreadsPage> = (after) =>
    ghJson(
      [
        'graphql',
        '-f',
        `query=${THREADS_QUERY}`,
        '-f',
        `owner=${ref.owner}`,
        '-f',
        `repo=${ref.repo}`,
        '-F',
        `number=${ref.number}`,
        ...(after ? ['-f', `after=${after}`] : []),
      ],
      signal,
    ),
): Promise<ReviewThread[]> {
  const threads: ReviewThread[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const found = (await query(after)).data.repository?.pullRequest?.reviewThreads;
    if (!found) {
      break;
    }
    threads.push(...found.nodes.flatMap((node) => threadFromJson(node) ?? []));
    if (!found.pageInfo.hasNextPage || !found.pageInfo.endCursor) {
      break;
    }
    after = found.pageInfo.endCursor;
  }
  return threads;
}

/** `gh api graphql` with variables; GitHub's refusal becomes the error message. */
async function mutate<T>(text: string, variables: Record<string, string>, signal?: AbortSignal): Promise<T> {
  try {
    return await ghJson<T>(
      [
        'graphql',
        '-f',
        `query=${text}`,
        ...Object.entries(variables).flatMap(([key, value]) => ['-f', `${key}=${value}`]),
      ],
      signal,
    );
  } catch (error) {
    if (error instanceof CommandError && error.stderr.trim()) {
      throw new Error(error.stderr.trim().replace(/^gh: /, ''), { cause: error });
    }
    throw error;
  }
}

const REPLY_MUTATION = `mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) {
    comment { ${COMMENT_FIELDS} }
  }
}`;

/** Replies to a thread as the user's `gh` login. */
export async function replyToGithubThread(reply: ThreadReplyRequest, signal?: AbortSignal): Promise<ThreadComment> {
  const json = await mutate<{ data: { addPullRequestReviewThreadReply: { comment: CommentJson } } }>(
    REPLY_MUTATION,
    { thread: reply.threadId, body: reply.body },
    signal,
  );
  return comment(json.data.addPullRequestReviewThreadReply.comment);
}

/** Resolves or unresolves a thread as the user's `gh` login. */
export async function resolveGithubThread(request: ThreadResolveRequest, signal?: AbortSignal): Promise<void> {
  const name = request.resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  await mutate(
    `mutation($thread: ID!) { ${name}(input: { threadId: $thread }) { thread { id } } }`,
    {
      thread: request.threadId,
    },
    signal,
  );
}
