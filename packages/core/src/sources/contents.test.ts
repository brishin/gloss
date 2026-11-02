import { describe, expect, it } from 'vitest';
import { reverseApply, StaleFileError } from './contents.ts';
import { parseHunks } from './patch-parser.ts';

const hunks = (patch: string) => parseHunks(patch.split('\n'));

describe('reverseApply', () => {
  it.each([
    [
      'a change between unchanged lines',
      '1\n2\nTWO\n4\n5\n6\n7\n8\n9\n',
      '1\n2\n3\n4\n5\n6\n7\n8\n9\n',
      '@@ -2,3 +2,3 @@\n 2\n-3\n+TWO\n 4',
    ],
    [
      'two hunks, one adding and one removing lines',
      'x\n1\n2\n3\n4\n5\n6\n7\n9\n',
      '1\n2\n3\n4\n5\n6\n7\n8\n9\n',
      '@@ -1,2 +1,3 @@\n+x\n 1\n 2\n@@ -7,3 +8,2 @@\n 7\n-8\n 9',
    ],
    ['lines removed without context', '1\n2\n5\n', '1\n2\n3\n4\n5\n', '@@ -3,2 +2,0 @@\n-3\n-4'],
    ['lines added without context', '1\nx\n2\n', '1\n2\n', '@@ -1,0 +2 @@\n+x'],
    ['a file emptied', '', 'a\nb\n', '@@ -1,2 +0,0 @@\n-a\n-b'],
    ['a newline added at the end', 'a\nb\n', 'a\nb', '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b'],
    ['a newline removed at the end', 'a\nb', 'a\nb\n', '@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file'],
    [
      'an unchanged last line without a newline',
      'A\nb',
      'a\nb',
      '@@ -1,2 +1,2 @@\n-a\n+A\n b\n\\ No newline at end of file',
    ],
  ])('rebuilds the old side: %s', (_, newContents, oldContents, patch) => {
    expect(reverseApply(newContents, hunks(patch))).toBe(oldContents);
  });

  it('refuses a new side that no longer matches the patch', () => {
    const patch = hunks('@@ -2,3 +2,3 @@\n 2\n-3\n+TWO\n 4');
    expect(() => reverseApply('1\ninserted\n2\nTWO\n4\n', patch)).toThrow(StaleFileError);
  });

  it('rebuilds a large file', () => {
    const tail = Array.from({ length: 200_000 }, (_, i) => `line ${i}`).join('\n');
    expect(reverseApply(`NEW\n${tail}\n`, hunks('@@ -1 +1 @@\n-old\n+NEW'))).toBe(`old\n${tail}\n`);
  });
});
