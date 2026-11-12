import { describe, expect, test } from 'vitest';
import { fetchReviewThreads, type ThreadJson, threadFromJson } from './github-threads.ts';

const comment = (login: string | null, body: string, diffHunk = '@@ -1,2 +1,2 @@\n a\n+b') => ({
  id: `c-${body}`,
  author: login ? { login } : null,
  body,
  createdAt: '2026-11-10T12:00:00Z',
  url: `https://github.com/o/r/pull/1#discussion_${body}`,
  diffHunk,
});

const thread = (patch: Partial<ThreadJson>): ThreadJson => ({
  id: 't',
  isResolved: false,
  isOutdated: false,
  path: 'src/a.ts',
  line: 12,
  startLine: null,
  diffSide: 'RIGHT',
  comments: { nodes: [comment('octocat', 'first'), comment(null, 'second')] },
  ...patch,
});

describe('threadFromJson', () => {
  test('keeps a current thread on its line and side, with a deleted author as ghost', () => {
    expect(threadFromJson(thread({ diffSide: 'LEFT', startLine: 10, isResolved: true }))).toEqual({
      id: 't',
      path: 'src/a.ts',
      side: 'deletions',
      line: 12,
      startLine: 10,
      resolved: true,
      outdated: false,
      comments: [
        expect.objectContaining({ author: 'octocat', body: 'first' }),
        expect.objectContaining({ author: 'ghost', body: 'second' }),
      ],
    });
  });

  test('an outdated thread loses its line and quotes the line it was left on', () => {
    const outdated = threadFromJson(
      thread({
        isOutdated: true,
        line: null,
        comments: { nodes: [comment('a', 'x', '@@ -3 +3 @@\n-old\n+fileId: v.string(),')] },
      }),
    );
    expect(outdated).toMatchObject({ outdated: true, quote: 'fileId: v.string(),' });
    expect(outdated).not.toHaveProperty('line');
  });

  test('a one-line startLine is dropped, and a thread with no comments left is too', () => {
    expect(threadFromJson(thread({ startLine: 12 }))).not.toHaveProperty('startLine');
    expect(threadFromJson(thread({ comments: { nodes: [] } }))).toBeUndefined();
  });
});

describe('fetchReviewThreads', () => {
  test('follows pages until GitHub says there are no more', async () => {
    const asked: (string | undefined)[] = [];
    const page = (id: string, endCursor: string | null) => ({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes: [thread({ id })] },
          },
        },
      },
    });
    const threads = await fetchReviewThreads(
      { kind: 'github-pr', owner: 'o', repo: 'r', number: 1 },
      undefined,
      async (after) => {
        asked.push(after);
        return after ? page('t2', null) : page('t1', 'cursor');
      },
    );
    expect(threads.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(asked).toEqual([undefined, 'cursor']);
  });

  test('a PR GitHub does not know has no threads', async () => {
    const threads = await fetchReviewThreads(
      { kind: 'github-pr', owner: 'o', repo: 'r', number: 1 },
      undefined,
      async () => ({
        data: { repository: null },
      }),
    );
    expect(threads).toEqual([]);
  });
});
