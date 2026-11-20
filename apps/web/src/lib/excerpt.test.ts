import type { CallFrame, DiffHunk, FileChange } from '@gloss/protocol';
import { describe, expect, it } from 'vitest';
import { callParents, excerptShows, sliceHunk, sliceTree, snippetHosts, stepFrames } from './excerpt.ts';

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

describe('excerptShows', () => {
  it('takes a comment only on a line the slice shows, on its side', () => {
    const hunk: DiffHunk = {
      id: 'h1',
      header: '@@ -10,4 +10,5 @@',
      oldStart: 10,
      oldLines: 4,
      newStart: 10,
      newLines: 5,
      patch: ' a\n-b\n+c\n+d\n e\n f',
    };
    const file = { id: 'f1', path: 'a.ts', status: 'modified', hunks: [sliceHunk(hunk, 11, 12)] } as FileChange;
    expect([10, 11, 12, 13].map((line) => excerptShows(file, 'additions', line))).toEqual([false, true, true, false]);
    // The removed line was old line 11.
    expect([10, 11, 12].map((line) => excerptShows(file, 'deletions', line))).toEqual([false, true, false]);
  });
});

describe('callParents', () => {
  it('finds the nearest row one level up', () => {
    const rows = [0, 1, 2, 1, 0, 1].map((depth) => ({ depth }));
    expect(callParents(rows)).toEqual([-1, 0, 1, 0, -1, 4]);
  });
});

describe('snippetHosts', () => {
  it('hangs each snippet under the last row of the first run that shows it, once', () => {
    const rows = [undefined, 1, 1, undefined, 0, 1, 0].map((snippet) => ({ snippet }));
    expect([...snippetHosts(rows)]).toEqual([
      [2, 1],
      [4, 0],
    ]);
  });
});

describe('stepFrames', () => {
  it('keeps the picked frames and one caller each, not the chain to the entry point, in tree order', () => {
    const frame = (depth: number, name: string): CallFrame => ({ depth, name, status: 'new' });
    const frames = [frame(0, 'a'), frame(1, 'b'), frame(2, 'c'), frame(3, 'd'), frame(2, 'e'), frame(0, 'f')];
    expect(stepFrames(frames, callParents(frames), [3])).toEqual([2, 3]);
    expect(stepFrames(frames, callParents(frames), [4, 3])).toEqual([1, 2, 3, 4]);
    expect(stepFrames(frames, callParents(frames), [0, 1])).toEqual([0, 1]);
    expect(stepFrames(frames, callParents(frames), [])).toEqual([]);
  });
});

describe('sliceTree', () => {
  it('keeps each frame under its own caller, and starts a frame whose caller is left out as a root', () => {
    const frame = (depth: number, name: string): CallFrame => ({ depth, name, status: 'new' });
    const frames = [0, 1, 2, 1, 2, 3, 4].map((depth, index) => frame(depth, String(index)));
    const only = stepFrames(frames, callParents(frames), [2, 6]);
    expect(only).toEqual([1, 2, 5, 6]);
    const { rows, parents } = sliceTree(frames, only);
    expect(parents).toEqual([-1, 0, -1, 2]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 0, 1]);
  });
});
