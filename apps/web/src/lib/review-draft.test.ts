import { describe, expect, test } from 'vitest';
import { anchorFromRange } from './review-draft.ts';

describe('anchorFromRange', () => {
  test.each([
    ['one line', { start: 5, end: 5, side: 'additions' as const }, { side: 'additions', line: 5 }],
    ['dragged down', { start: 3, end: 6, side: 'deletions' as const }, { side: 'deletions', line: 6, startLine: 3 }],
    ['dragged up', { start: 6, end: 3, side: 'additions' as const }, { side: 'additions', line: 6, startLine: 3 }],
    [
      'across sides: the line it ended on',
      { start: 2, end: 4, side: 'deletions' as const, endSide: 'additions' as const },
      { side: 'additions', line: 4 },
    ],
    ['no side: the new file', { start: 1, end: 1 }, { side: 'additions', line: 1 }],
  ])('%s', (_, range, anchor) => {
    expect(anchorFromRange('f', range)).toEqual({ fileId: 'f', ...anchor });
  });
});
