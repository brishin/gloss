import type { FileChange, ResolvedGroup } from '@gloss/protocol';
import { describe, expect, it } from 'vitest';
import { normalizeNotes } from './normalize.ts';

const file: FileChange = {
  id: 'f1',
  path: 'src/a.ts',
  status: 'modified',
  additions: 2,
  deletions: 1,
  isBinary: false,
  truncated: false,
  hunks: [
    {
      id: 'h1',
      header: '@@ -10,3 +10,4 @@',
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 4,
      patch: ' a\n-b\n+c\n+d\n e',
    },
  ],
};
const group: ResolvedGroup = { key: 'g', label: 'G', summary: '', category: 'core', critical: false, fileIds: ['f1'] };

describe('normalizeNotes', () => {
  it('keeps visible lines, repairs a wrong hunk id, and demotes invisible lines to file notes', () => {
    const { notes, warnings } = normalizeNotes(
      {
        fileNotes: [{ fileId: 'other', text: 'stray' }],
        lineNotes: [
          { fileId: 'f1', hunkId: 'h1', side: 'additions', line: 11, text: 'added c' },
          { fileId: 'f1', hunkId: 'h1', side: 'deletions', line: 11, text: 'removed b' },
          { fileId: 'f1', hunkId: 'bogus', side: 'additions', line: 12, text: 'wrong hunk id' },
          { fileId: 'f1', hunkId: 'h1', side: 'deletions', line: 99, text: 'off the hunk' },
        ],
        riskNotes: [{ fileId: 'f1', risk: 'authCheck', text: 'risky' }],
        decisions: [
          { fileId: 'f1', hunkId: 'h1', side: 'additions', line: 12, text: 'on d', priority: 'high' },
          { fileId: 'f1', hunkId: 'h1', side: 'additions', line: 40, text: 'off the hunk', priority: 'low' },
          { fileId: 'other', hunkId: 'h1', side: 'additions', line: 12, text: 'stray', priority: 'urgent' },
        ],
      },
      group,
      [file],
    );
    expect(notes.lineNotes.map((note) => [note.side, note.line, note.hunkId])).toEqual([
      ['additions', 11, 'h1'],
      ['deletions', 11, 'h1'],
      ['additions', 12, 'h1'],
    ]);
    expect(notes.fileNotes).toEqual([{ fileId: 'f1', text: 'off the hunk', critical: undefined }]);
    expect(notes.riskNotes).toHaveLength(1);
    expect(notes.decisions).toEqual([
      { text: 'on d', priority: 'high', fileId: 'f1', hunkId: 'h1', side: 'additions', line: 12 },
      { text: 'off the hunk', priority: 'low', fileId: 'f1' },
    ]);
    expect(warnings).toHaveLength(2);
  });
});
