import { describe, expect, test } from 'vitest';
import { CommandError } from './exec.ts';
import { isTransient, type PostedReviewJson, reviewPayload, submitReviewWith } from './github-review.ts';

const review = { owner: 'o', repo: 'r', number: 1, body: '  ship it  ', commitId: 'abc' };

describe('reviewPayload', () => {
  test('maps sides and ranges to what GitHub expects', () => {
    expect(
      reviewPayload({
        ...review,
        verdict: 'REQUEST_CHANGES',
        comments: [
          { path: 'a.ts', side: 'additions', line: 4, body: 'one' },
          { path: 'b.ts', side: 'deletions', line: 9, startLine: 7, body: 'range' },
          { path: 'c.ts', side: 'additions', line: 3, startLine: 3, body: 'one line' },
        ],
      }),
    ).toEqual({
      commit_id: 'abc',
      event: 'REQUEST_CHANGES',
      body: 'ship it',
      comments: [
        { path: 'a.ts', body: 'one', line: 4, side: 'RIGHT' },
        { path: 'b.ts', body: 'range', line: 9, side: 'LEFT', start_line: 7, start_side: 'LEFT' },
        { path: 'c.ts', body: 'one line', line: 3, side: 'RIGHT' },
      ],
    });
  });

  test('leaves the commit to GitHub when the tour has no head', () => {
    expect(reviewPayload({ ...review, commitId: undefined, verdict: 'APPROVE', comments: [] })).not.toHaveProperty(
      'commit_id',
    );
  });
});

describe('submitReviewWith', () => {
  const request = {
    ...review,
    body: '',
    verdict: 'COMMENT' as const,
    comments: [{ path: 'a.ts', side: 'additions' as const, line: 4, body: 'one' }],
  };
  const timeout = new CommandError('gh api failed', "gh: We couldn't respond to your request in time. (HTTP 504)", 1);
  const refused = new CommandError('gh api failed', 'gh: Can not approve your own pull request (HTTP 422)', 1);
  const mine = {
    html_url: 'https://github.com/o/r/pull/1#pullrequestreview-9',
    user: { login: 'me' },
    state: 'COMMENTED',
    body: '',
  };

  function steps(posts: (() => string)[], reviews: PostedReviewJson[] = []) {
    const calls = { posts: 0, waits: [] as number[] };
    return {
      calls,
      steps: {
        post: async () => posts[calls.posts++]!(),
        reviews: async () => reviews,
        viewer: async () => 'me',
        wait: async (ms: number) => void calls.waits.push(ms),
        now: () => Date.parse('2026-11-25T15:00:00Z'),
      },
    };
  }

  test('retries after a GitHub timeout that created nothing', async () => {
    const { calls, steps: s } = steps([
      () => {
        throw timeout;
      },
      () => JSON.stringify({ html_url: 'u' }),
    ]);
    await expect(submitReviewWith(request, s)).resolves.toEqual({ url: 'u' });
    expect(calls.posts).toBe(2);
  });

  test('does not post twice when the timed-out try created the review', async () => {
    const { calls, steps: s } = steps(
      [
        () => {
          throw timeout;
        },
        () => JSON.stringify({ html_url: 'dup' }),
      ],
      [{ ...mine, submitted_at: '2026-11-25T15:00:08Z' }],
    );
    await expect(submitReviewWith(request, s)).resolves.toEqual({ url: mine.html_url });
    expect(calls.posts).toBe(1);
  });

  test('ignores older or other reviews when looking for one that landed', async () => {
    const { calls, steps: s } = steps(
      [
        () => {
          throw timeout;
        },
        () => JSON.stringify({ html_url: 'u' }),
      ],
      [
        { ...mine, submitted_at: '2026-11-25T14:00:00Z' },
        { ...mine, user: { login: 'them' }, submitted_at: '2026-11-25T15:00:08Z' },
        { ...mine, state: 'APPROVED', submitted_at: '2026-11-25T15:00:08Z' },
      ],
    );
    await expect(submitReviewWith(request, s)).resolves.toEqual({ url: 'u' });
    expect(calls.posts).toBe(2);
  });

  test('gives up after the last retry, and never retries a refusal', async () => {
    const failing = steps([
      () => {
        throw timeout;
      },
      () => {
        throw timeout;
      },
      () => {
        throw timeout;
      },
    ]);
    await expect(submitReviewWith(request, failing.steps)).rejects.toBe(timeout);
    expect(failing.calls.posts).toBe(3);

    const refusing = steps([
      () => {
        throw refused;
      },
    ]);
    await expect(submitReviewWith(request, refusing.steps)).rejects.toBe(refused);
    expect(refusing.calls.posts).toBe(1);
  });

  test('counts an unreadable reply as transient', () => {
    expect(isTransient(new CommandError('x', 'unexpected end of JSON input', 1))).toBe(true);
    expect(isTransient(new SyntaxError('Unexpected end of JSON input'))).toBe(true);
    expect(isTransient(refused)).toBe(false);
  });
});
