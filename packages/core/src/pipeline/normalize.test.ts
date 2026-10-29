import type { FileChange, ResolvedGroup } from '@gloss/protocol';
import { describe, expect, it } from 'vitest';
import { isSinglePath, normalizeNotes, normalizeVisual, normalizeVisuals } from './normalize.ts';

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
          { fileId: 'src/a.ts', hunkId: 'h1', side: 'additions', line: 13, text: 'by path' },
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
      ['additions', 13, 'h1'],
    ]);
    expect(notes.lineNotes.at(-1)?.fileId).toBe('f1');
    expect(notes.fileNotes).toEqual([{ fileId: 'f1', text: 'off the hunk', critical: undefined }]);
    expect(notes.riskNotes).toHaveLength(1);
    expect(notes.decisions).toEqual([
      { text: 'on d', priority: 'high', fileId: 'f1', hunkId: 'h1', side: 'additions', line: 12 },
      { text: 'off the hunk', priority: 'low', fileId: 'f1' },
    ]);
    expect(warnings).toHaveLength(2);
  });
});

describe('normalizeVisual', () => {
  it('clamps timeline positions, orders spans, and drops empty lanes and zero-length bars', () => {
    const { visual, warnings } = normalizeVisual({
      kind: 'timeline',
      caption: '  The save   now runs on background. ',
      markers: [{ at: 140, text: 'killed' }],
      lanes: [
        {
          label: 'Before',
          spans: [
            { from: 60, to: 20, text: 'idle timer' },
            { from: 5, to: 5, text: 'nothing' },
          ],
        },
        { label: 'Empty', spans: [] },
        { label: 'After', spans: [], outcome: { at: -3, text: 'saved', tone: 'good' } },
      ],
    });
    expect(warnings).toEqual([]);
    expect(visual).toEqual({
      kind: 'timeline',
      caption: 'The save now runs on background.',
      markers: [{ at: 100, text: 'killed' }],
      lanes: [
        { label: 'Before', spans: [{ from: 20, to: 60, text: 'idle timer' }] },
        { label: 'After', spans: [], outcome: { at: 0, text: 'saved', tone: 'good' } },
      ],
    });
  });

  it('keeps the candidates that survive, in order, and skips none without a warning', () => {
    const rows = { kind: 'mermaid' as const, caption: 'c', mermaid: 'flowchart TD\n  A --> B\n  A --> C' };
    const { visuals, warnings } = normalizeVisuals({
      first: { kind: 'mermaid', caption: '1', mermaid: 'pie' },
      second: { kind: 'none', caption: '' },
      third: { ...rows, caption: '3' },
    });
    expect(visuals.map((visual) => visual.caption)).toEqual(['3']);
    expect(warnings).toEqual(['Dropped the mermaid visual: only flowcharts and state diagrams are drawn.']);
  });

  it('needs a diagram on both sides of a before-after', () => {
    expect(
      normalizeVisual({ kind: 'before-after', caption: 'x', before: 'flowchart LR\n  A --> B', after: '- a list' }),
    ).toEqual({
      warnings: ['Dropped the before-after visual: only flowcharts and state diagrams are drawn.'],
    });
  });

  it('keeps flowcharts and state diagrams, strips fences and styling, and drops other diagram types', () => {
    expect(
      normalizeVisual({
        kind: 'mermaid',
        caption: 'c',
        mermaid: '```mermaid\nflowchart TD\n  A --> B\n  A --> C\n  click A "javascript:x"\n  style A fill:#f00\n```',
      }).visual,
    ).toEqual({ kind: 'mermaid', caption: 'c', source: 'flowchart TD\n  A --> B\n  A --> C' });
    expect(normalizeVisual({ kind: 'mermaid', caption: 'c', mermaid: 'sequenceDiagram\n A->>B: hi' }).visual).toBe(
      undefined,
    );
  });
});

describe('isSinglePath', () => {
  // Shapes from real eval candidates: a straight chain is a list with arrows.
  it.each([
    [
      'a five-box chain',
      'flowchart TD\nA[Shell link] --> B[Browser asks]\nB --> C[Static route]\nC --> D[Build file]',
      true,
    ],
    ['a chain written on one line', 'flowchart LR\nA --> B --> C', true],
    ['a fork', 'flowchart TD\nA --> B\nA --> C', false],
    ['a merge', 'flowchart TD\nA --> C\nB --> C', false],
    ['a loop with labels', 'flowchart TD\nA[Start] --> B{Trunk?}\nB -- no --> C[Step down]\nC -->|again| B', false],
    ['a state machine cycle', 'stateDiagram-v2\n[*] --> Idle\nIdle --> Busy: start\nBusy --> Idle: done', false],
  ] as const)('%s', (_, source, expected) => {
    expect(isSinglePath(source)).toBe(expected);
  });

  it('drops a diagram that is one path, and a before-after only when both sides are', () => {
    const chain = 'flowchart TD\nA --> B\nB --> C';
    const tree = 'flowchart TD\nA --> B\nA --> C';
    expect(normalizeVisual({ kind: 'mermaid', caption: '', mermaid: chain }).warnings).toEqual([
      'Dropped the mermaid visual: it is a single path, which a list says as well.',
    ]);
    expect(normalizeVisual({ kind: 'before-after', caption: '', before: chain, after: chain }).visual).toBe(undefined);
    expect(normalizeVisual({ kind: 'before-after', caption: '', before: chain, after: tree }).visual?.kind).toBe(
      'before-after',
    );
  });
});
