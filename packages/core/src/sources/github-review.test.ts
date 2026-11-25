import { Effect } from 'effect';
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
  const now = () => new Date().toISOString();
  const mine = {
    html_url: 'https://github.com/o/r/pull/1#pullrequestreview-9',
    user: { login: 'me' },
    state: 'COMMENTED',
    body: '',
  };

  function submit(posts: (() => string)[], reviews: () => PostedReviewJson[] = () => []) {
    let tries = 0;
    const result = Effect.runPromise(
      submitReviewWith(
        request,
        {
          post: () => Effect.try({ try: () => posts[tries++]!(), catch: (error) => error }),
          reviews: Effect.sync(() => [reviews(), 'me'] as const),
        },
        '0 millis',
      ),
    );
    return { result, tries: () => tries };
  }
  const fail = (error: unknown) => () => {
    throw error;
  };

  test('posts again after a GitHub timeout that created nothing', async () => {
    const run = submit([fail(timeout), () => JSON.stringify({ html_url: 'u' })]);
    await expect(run.result).resolves.toEqual({ url: 'u' });
    expect(run.tries()).toBe(2);
  });

  test('does not post twice when the timed-out post created the review', async () => {
    const run = submit([fail(timeout), () => JSON.stringify({ html_url: 'dup' })], () => [
      { ...mine, submitted_at: now() },
    ]);
    await expect(run.result).resolves.toEqual({ url: mine.html_url });
    expect(run.tries()).toBe(1);
  });

  test('ignores older reviews, other logins and other verdicts', async () => {
    const run = submit([fail(timeout), () => JSON.stringify({ html_url: 'u' })], () => [
      { ...mine, submitted_at: '2020-01-01T00:00:00Z' },
      { ...mine, user: { login: 'them' }, submitted_at: now() },
      { ...mine, state: 'APPROVED', submitted_at: now() },
    ]);
    await expect(run.result).resolves.toEqual({ url: 'u' });
    expect(run.tries()).toBe(2);
  });

  test('posts again after a reply it cannot read', async () => {
    const run = submit([() => '', () => JSON.stringify({ html_url: 'u' })]);
    await expect(run.result).resolves.toEqual({ url: 'u' });
    expect(run.tries()).toBe(2);
  });

  test('gives up after three posts, and never posts again after a refusal', async () => {
    const failing = submit([fail(timeout), fail(timeout), fail(timeout)]);
    await expect(failing.result).rejects.toBe(timeout);
    expect(failing.tries()).toBe(3);

    const refusing = submit([fail(refused)]);
    await expect(refusing.result).rejects.toBe(refused);
    expect(refusing.tries()).toBe(1);
  });

  test('counts only 5xx and unreadable replies as transient', () => {
    expect(isTransient(timeout)).toBe(true);
    expect(isTransient(new CommandError('x', 'unexpected end of JSON input', 1))).toBe(true);
    expect(isTransient(new SyntaxError('Unexpected end of JSON input'))).toBe(true);
    expect(isTransient(refused)).toBe(false);
  });
});
