import type { CallFrame, DiffHunk } from '@gloss/protocol';
import { describe, expect, it } from 'vitest';
import { callParents, sliceHunk, stepFrames } from './excerpt.ts';

describe('sliceHunk', () => {
  const hunk: DiffHunk = {
    id: 'h1',
    header: '@@ -10,4 +10,5 @@',
    oldStart: 10,
    oldLines: 4,
    newStart: 10,
    newLines: 5,
    patch: ' a\n-b\n+c\n+d\n e\n f',
  };

  it('keeps the new-side range with the removed lines inside it, and recomputes the header', () => {
    expect(sliceHunk(hunk, 11, 12)).toMatchObject({
      header: '@@ -11,1 +11,2 @@',
      oldStart: 11,
      newStart: 11,
      patch: '-b\n+c\n+d',
    });
    expect(sliceHunk(hunk, 13, 14)).toMatchObject({ header: '@@ -12,2 +13,2 @@', patch: ' e\n f' });
    // Lines removed at the end of a hunk come with the last line before them.
    const trailing = { ...hunk, patch: ' a\n b\n c\n-oldCall()', newLines: 3, oldLines: 4 };
    expect(sliceHunk(trailing, 10, 12).patch).toBe(' a\n b\n c\n-oldCall()');
  });
});

describe('stepFrames', () => {
  it('keeps the picked frames and their callers, in tree order', () => {
    const frame = (depth: number, name: string): CallFrame => ({ depth, name, status: 'new' });
    const frames = [frame(0, 'a'), frame(1, 'b'), frame(2, 'c'), frame(1, 'd'), frame(0, 'e')];
    expect(stepFrames(frames, callParents(frames), [3, 2])).toEqual([0, 1, 2, 3]);
    expect(stepFrames(frames, callParents(frames), [])).toEqual([]);
  });
});
