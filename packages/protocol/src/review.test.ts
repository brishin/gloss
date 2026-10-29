import { describe, expect, test } from 'vitest';
import { reviewProblem, type ReviewVerdict } from './review.ts';

const comment = { path: 'a.ts', side: 'additions' as const, line: 1, body: 'x' };

describe('reviewProblem', () => {
  test.each<[ReviewVerdict, string, number, boolean]>([
    ['APPROVE', '', 0, true],
    ['APPROVE', 'lgtm', 1, true],
    ['REQUEST_CHANGES', '', 1, false],
    ['REQUEST_CHANGES', '  ', 0, false],
    ['REQUEST_CHANGES', 'fix it', 0, true],
    ['COMMENT', '', 0, false],
    ['COMMENT', '', 1, true],
    ['COMMENT', 'note', 0, true],
  ])('%s with body %j and %i comments: sendable %s', (verdict, body, comments, ok) => {
    expect(reviewProblem({ verdict, body, comments: Array(comments).fill(comment) }) === undefined).toBe(ok);
  });
});
