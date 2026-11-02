import type { FileStatus, ResolvedAsset, SourceRef } from '@gloss/protocol';
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

/** PRs per GraphQL query when looking up authors; well under GitHub's node limits. */
const AUTHORS_PER_QUERY = 50;

/** One GraphQL query that asks for each PR's author, aliased `p0`, `p1`, … in `refs` order. */
export function pullAuthorsQuery(refs: readonly GithubRef[]): string {
  // JSON string literals are valid GraphQL string literals, so owner and repo names stay quoted.
  const fields = refs.map(
    (ref, index) =>
      `p${index}: repository(owner: ${JSON.stringify(ref.owner)}, name: ${JSON.stringify(ref.repo)}) { pullRequest(number: ${ref.number}) { author { login } } }`,
  );
  return `query { ${fields.join(' ')} }`;
}

export type AuthorsJson = { data: Record<string, { pullRequest: { author: { login: string } | null } | null } | null> };

/**
 * The author of each PR, keyed by `serializeRef`, in one `gh` call per 50 PRs instead of one
 * REST call each. GitHub fails a whole query when one PR in it is gone or out of reach, so a
 * failed batch is split in half and retried, until the PRs it cannot see are left out alone.
 */
export async function githubPullAuthors(
  refs: readonly GithubRef[],
  signal?: AbortSignal,
  query: (text: string) => Promise<AuthorsJson> = (text) => ghJson(['graphql', '-f', `query=${text}`], signal),
): Promise<Map<string, string>> {
  const authors = new Map<string, string>();
  const lookup = async (batch: readonly GithubRef[]): Promise<void> => {
    let json: AuthorsJson;
    try {
      json = await query(pullAuthorsQuery(batch));
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
      const login = json.data?.[`p${index}`]?.pullRequest?.author?.login;
      if (login) {
        authors.set(serializeRef(ref), login);
      }
    });
  };
  for (let start = 0; start < refs.length; start += AUTHORS_PER_QUERY) {
    await lookup(refs.slice(start, start + AUTHORS_PER_QUERY));
  }
  return authors;
}

/** The `gh` login: whose PRs are "mine". */
export async function githubViewer(signal?: AbortSignal): Promise<string> {
  return (await gh(['user', '--jq', '.login'], signal)).trim();
}
