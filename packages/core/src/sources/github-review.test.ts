import { describe, expect, test } from 'vitest';
import { reviewPayload } from './github-review.ts';

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
