import type { FileChange, ResolvedGroup } from '@gloss/protocol';
import { describe, expect, it } from 'vitest';
import {
  isSinglePath,
  looseEnds,
  normalizeSketch,
  sketchGap,
  normalizeDecisionGroups,
  normalizeNotes,
  normalizeVisual,
  normalizeVisuals,
  normalizeWalkthrough,
} from './normalize.ts';
import { SKETCH_SYSTEM } from './prompts.ts';

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

describe('normalizeDecisionGroups', () => {
  it('keeps a known group key and drops an unknown one, so the decision stays change-wide', () => {
    expect(
      normalizeDecisionGroups(
        [
          { text: 'a', priority: 'high', groupKey: 'auth' },
          { text: 'b', priority: 'low', groupKey: 'invented' },
          { text: 'c', priority: 'medium' },
        ],
        ['auth', 'docs'],
      ),
    ).toEqual([
      { text: 'a', priority: 'high', groupKey: 'auth' },
      { text: 'b', priority: 'low' },
      { text: 'c', priority: 'medium' },
    ]);
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
      second: { ...rows, caption: '3' },
    });
    expect(visuals.map((visual) => visual.caption)).toEqual(['3']);
    expect(warnings).toEqual(['Dropped the mermaid visual: only flowcharts and state diagrams are drawn.']);
  });

  it('keeps a sanitized sketch, drops an unsafe one with a warning, and an empty one silently', () => {
    const svg = '<svg viewBox="0 0 10 10"><rect width="4"/></svg>';
    expect(normalizeSketch({ caption: 's', svg })).toEqual({
      visual: { kind: 'svg', caption: 's', svg: svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ') },
      warnings: [],
    });
    expect(normalizeSketch({ caption: 's', svg: '<svg viewBox="0 0 1 1"><script/></svg>' })).toEqual({
      warnings: ['Dropped the svg visual: it uses <script>.'],
    });
    expect(normalizeSketch({ caption: '', svg: '' })).toEqual({ warnings: [] });
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
    ['a path beside a separate loop', 'flowchart TD\nA --> B\nC --> D\nD --> C', false],
    ['a path beside a standalone node', 'flowchart TD\nA --> B\nC[Independent worker]', false],
    ['a chain with its nodes declared first', 'flowchart TD\nA[One]\nB[Two]\nA --> B', true],
    ['a loop with labels', 'flowchart TD\nA[Start] --> B{Trunk?}\nB -- no --> C[Step down]\nC -->|again| B', false],
    ['a fork written on one line', 'flowchart TD\nA --> B; A --> C', false],
    ['a fork to grouped ends', 'flowchart TD\nA --> B & C', false],
    ['a two-way edge', 'flowchart TD\nA <--> B\nB --> C', false],
    ['a chain with ; and & inside node text', 'flowchart TD\nA[Read; parse] --> B["Save & exit"]', true],
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

describe('looseEnds', () => {
  const box = (x: number, y: number) => `<rect x="${x}" y="${y}" width="100" height="40"/>`;
  const to = 'marker-end="url(#a)"';
  // Shapes from round-6 eval sketches: arrows drawn into empty space never close the flow.
  it.each([
    ['box edge to box edge', `${box(0, 0)}${box(200, 0)}<line x1="100" y1="20" x2="198" y2="20" ${to}/>`, 0],
    ['an arrowhead a few units short', `${box(0, 0)}${box(200, 0)}<line x1="100" y1="20" x2="194" y2="20" ${to}/>`, 0],
    [
      'a loop back that stops short of the box',
      `${box(0, 50)}${box(300, 50)}<line x1="350" y1="50" x2="100" y2="30" ${to}/>`,
      1,
    ],
    [
      'an arrow floating above both boxes',
      `${box(0, 50)}${box(200, 50)}<line x1="100" y1="30" x2="200" y2="30" ${to}/>`,
      2,
    ],
    ['a path without a marker that ends nowhere', `${box(0, 0)}<path d="M50 40V100H600"/>`, 1],
    ['a marker shape without a close', `<defs><marker id="a"><path d="M0 0L8 4L0 8"/></marker></defs>${box(0, 0)}`, 0],
    ['a divider without a marker', `${box(0, 0)}<line x1="0" y1="80" x2="700" y2="80"/>`, 0],
    [
      'a polyline around to a circle',
      `${box(0, 0)}<circle cx="300" cy="20" r="20"/><polyline points="50,40 50,80 300,80 300,40" ${to}/>`,
      0,
    ],
    [
      'into and out of a decision diamond',
      `${box(0, 0)}<polygon points="200,0 240,20 200,40 160,20"/>${box(320, 0)}<line x1="100" y1="20" x2="160" y2="20" ${to}/><line x1="240" y1="20" x2="320" y2="20" ${to}/>`,
      0,
    ],
    ['a path with two hops', `${box(0, 0)}${box(160, 0)}${box(320, 0)}<path d="M100 20H158M260 20H318" ${to}/>`, 0],
    ['a path whose second hop ends nowhere', `${box(0, 0)}${box(160, 0)}<path d="M100 20H158M260 20H400" ${to}/>`, 1],
    ['a curve (not checked)', `${box(0, 0)}<path d="M100 20C300 0 500 0 600 300" ${to}/>`, 0],
    ['the marker shape itself', `<defs><marker id="a"><path d="M0 0L10 5L0 10z"/></marker></defs>${box(0, 0)}`, 0],
    [
      'anything transformed (not checked)',
      `<g transform="translate(5 0)">${box(0, 0)}</g><line x1="500" y1="500" x2="600" y2="600" ${to}/>`,
      0,
    ],
  ] as const)('%s', (_, body, expected) => {
    expect(looseEnds(`<svg viewBox="0 0 760 200">${body}</svg>`)).toBe(expected);
  });

  it('drops a sketch with a loose arrow, and keeps the prompt examples', () => {
    const svg = `<svg viewBox="0 0 760 200"><rect x="0" y="0" width="10" height="10"/><line x1="5" y1="10" x2="5" y2="90" ${to}/></svg>`;
    expect(normalizeSketch({ caption: 's', svg })).toEqual({
      warnings: ['Dropped the svg visual: 1 connector end touches no box.'],
    });
    const examples = SKETCH_SYSTEM.match(/<svg[\s\S]*?<\/svg>/g)!;
    expect(examples).toHaveLength(3);
    for (const svg of examples) expect(normalizeSketch({ caption: 'e', svg })).toMatchObject({ warnings: [] });
  });
});

describe('sketchGap', () => {
  const box = (x: number, label: string) =>
    `<rect x="${x}" y="40" width="100" height="40"/><text x="${x + 50}" y="65">${label}</text>`;
  const arrow = (x: number, label = '') =>
    `<path d="M${x} 60H${x + 60}" marker-end="url(#a)"/>${label && `<text x="${x + 30}" y="54">${label}</text>`}`;
  const svg = (body: string) =>
    `<svg viewBox="0 0 760 200"><defs><marker id="a"><path d="M0 0L1 1"/></marker></defs>${body}</svg>`;
  // Shapes from round 9-10 eval sketches.
  it.each([
    [
      'labelled arrows',
      box(0, 'A') + arrow(100, 'calls') + box(160, 'B') + arrow(260, 'writes') + box(320, 'C'),
      'A to C',
      undefined,
    ],
    [
      'half the arrows labelled',
      box(0, 'A') + arrow(100, 'calls') + box(160, 'B') + arrow(260) + box(320, 'C'),
      'A to C',
      undefined,
    ],
    [
      'labelled arrows inside a region',
      '<rect x="0" y="0" width="760" height="120"/>' +
        box(0, 'A') +
        arrow(100, 'calls') +
        box(160, 'B') +
        arrow(260, 'writes') +
        box(320, 'C'),
      'A to C',
      undefined,
    ],
    [
      'no arrow labelled',
      box(0, 'A') + arrow(100) + box(160, 'B') + arrow(260) + box(320, 'C'),
      'A to C',
      '2 of its 2 arrows have no label',
    ],
    [
      'a heading is not a label',
      '<text x="16" y="24" font-weight="600">AFTER</text>' + box(0, 'A') + arrow(100) + box(160, 'B'),
      'A, B',
      'its arrow has no label',
    ],
    ['a capital protocol name is a label', box(0, 'A') + arrow(100, 'HTTP') + box(160, 'B'), 'A, B', undefined],
    [
      'a before it never draws',
      '<text x="16" y="24">AFTER</text>' + box(0, 'A') + arrow(100, 'calls') + box(160, 'B'),
      'Before: X. After: A calls B.',
      'its caption describes a before it does not draw',
    ],
    [
      'a before that is only an order',
      box(0, 'A') + arrow(100, 'checks') + box(160, 'B'),
      'Requests check the cache before reaching the database',
      undefined,
    ],
    [
      'a before band',
      '<text x="16" y="24">BEFORE</text>' + box(0, 'A') + arrow(100, 'calls') + box(160, 'B'),
      'Before and after',
      undefined,
    ],
  ] as const)('%s', (_, body, caption, expected) => {
    expect(sketchGap(svg(body), caption)).toBe(expected);
  });
});

describe('normalizeWalkthrough', () => {
  // 40 new-side lines; changes at 16 (added) and 30 (added, after a removed line).
  const patch = Array.from({ length: 40 }, (_, i) =>
    i + 1 === 16 ? '+new' : i + 1 === 30 ? '-old\n+new' : ` line ${i + 1}`,
  ).join('\n');
  const long: FileChange = {
    ...file,
    id: 'f2',
    path: 'src/b.ts',
    hunks: [{ id: 'h2', header: '@@ -1,40 +1,40 @@', oldStart: 1, oldLines: 40, newStart: 1, newLines: 40, patch }],
  };
  const files = [file, long];
  type Raw = NonNullable<Parameters<typeof normalizeWalkthrough>[0]['decisions']>[number];
  type RawSnippet = Raw['snippets'][number];
  type RawNode = Raw['nodes'][number];
  const snippet = (fileId: string, hunkId: string, from: number, to: number, focus: number): RawSnippet => ({
    fileId,
    hunkId,
    from,
    to,
    focus,
    caption: 'What these lines show.',
    note: '',
  });
  const entry = (decision: number, snippets: RawSnippet[], more: Partial<Raw> = {}): Raw => ({
    decision,
    title: 'A choice',
    why: 'Because.',
    instead: '',
    check: '',
    snippets,
    tree: 'none',
    nodes: [],
    refs: [],
    links: [],
    ...more,
  });
  const node = (depth: number, fields: Partial<RawNode>): RawNode => ({
    depth,
    receiver: '',
    name: '',
    args: '',
    status: 'same',
    label: '',
    note: '',
    fileId: '',
    line: 0,
    snippet: -1,
    ...fields,
  });
  const walk = (decisions: Raw[], count = 3, list = files) => normalizeWalkthrough({ decisions }, list, count);

  it('keeps one entry per listed decision, in their order, and drops entries with no code', () => {
    const at = [snippet('f1', 'h1', 10, 13, 11)];
    const { walkthrough, warnings } = walk([
      entry(2, at, { instead: 'Something else', check: 'What to hold it to.' }),
      entry(0, at),
      entry(0, at),
      entry(5, at),
      entry(1, [snippet('f9', 'h1', 1, 2, 1)]),
      { ...entry(1, at), title: '' },
    ]);
    expect(walkthrough!.decisions.map((walk) => walk.decision)).toEqual([0, 2]);
    expect(walkthrough!.decisions[1]).toMatchObject({ instead: 'Something else', check: 'What to hold it to.' });
    expect(walkthrough!.decisions[0]).not.toHaveProperty('instead');
    expect(warnings).toEqual([
      'Dropped a walkthrough entry: decision 0 is not listed, repeated or untitled.',
      'Dropped a walkthrough entry: decision 5 is not listed, repeated or untitled.',
      'Dropped a snippet of decision 1: f9:1 is not in the diff.',
      'Dropped the walkthrough of decision 1: none of its code is in the diff.',
      'Dropped a walkthrough entry: decision 1 is not listed, repeated or untitled.',
    ]);
    expect(walk([])).toEqual({ warnings: [] });
    expect(walk([entry(0, [])]).walkthrough).toBeUndefined();
  });

  it('pins snippets to a hunk that shows their focus, and narrows long ones around it', () => {
    const { walkthrough } = walk([
      entry(0, [
        // The whole hunk around line 30: narrowed to 16 rows (the removed one counts) around it.
        snippet('f2', 'h2', 1, 40, 30),
        // A wrong hunk id is repaired from the focus; a path works as a file id.
        { ...snippet('src/a.ts', 'nope', 11, 12, 12), note: 'Only what the code does not say.' },
        // Overlaps the first: the same code, so it is not shown twice.
        snippet('f2', 'h2', 28, 31, 29),
      ]),
    ]);
    const [a, b] = walkthrough!.decisions[0]!.snippets;
    expect(a).toEqual({ fileId: 'f2', hunkId: 'h2', from: 23, to: 37, focus: 30, caption: 'What these lines show.' });
    expect(b).toMatchObject({ fileId: 'f1', hunkId: 'h1', from: 11, to: 12, focus: 12 });
    expect(b!.note).toBe('Only what the code does not say.');
    expect(walkthrough!.decisions[0]!.snippets).toHaveLength(2);
  });

  it('keeps snippets that overlap only in context, each with its own focus', () => {
    const { walkthrough } = walk([entry(0, [snippet('f2', 'h2', 1, 5, 2), snippet('f2', 'h2', 5, 9, 8)])]);
    expect(walkthrough!.decisions[0]!.snippets.map((at) => at.focus)).toEqual([2, 8]);
  });

  it('moves a focus the diff does not show onto the first added line in range', () => {
    const { walkthrough } = walk([entry(0, [snippet('f2', 'h2', 14, 18, 99)])]);
    expect(walkthrough!.decisions[0]!.snippets[0]).toMatchObject({ from: 14, to: 18, focus: 16 });
  });

  it('keeps lines removed at the end of a hunk', () => {
    const trailing: FileChange = {
      ...file,
      id: 'f3',
      hunks: [
        {
          id: 'h3',
          header: '@@ -1,4 +1,3 @@',
          oldStart: 1,
          oldLines: 4,
          newStart: 1,
          newLines: 3,
          patch: ' a\n b\n c\n-oldCall()',
        },
      ],
    };
    const { walkthrough } = walk([entry(0, [snippet('f3', 'h3', 1, 3, 3)])], 1, [trailing]);
    expect(walkthrough!.decisions[0]!.snippets[0]).toMatchObject({ from: 1, to: 3, focus: 3 });
  });

  it('keeps the hunk that shows the focus over a hunk id that names another', () => {
    const split: FileChange = {
      ...file,
      id: 'f4',
      hunks: [
        {
          id: 'a',
          header: '@@ -1,5 +1,5 @@',
          oldStart: 1,
          oldLines: 5,
          newStart: 1,
          newLines: 5,
          patch: ' 1\n 2\n+3\n 4\n 5',
        },
        {
          id: 'b',
          header: '@@ -20,5 +20,5 @@',
          oldStart: 20,
          oldLines: 5,
          newStart: 20,
          newLines: 5,
          patch: ' 20\n 21\n+22\n 23\n 24',
        },
      ],
    };
    const { walkthrough } = walk([entry(0, [snippet('f4', 'a', 3, 22, 22)])], 1, [split]);
    expect(walkthrough!.decisions[0]!.snippets[0]).toMatchObject({ hunkId: 'b', from: 20, to: 22, focus: 22 });
  });

  it('drops a snippet whose focus alone sits beside more removed rows than a snippet shows', () => {
    const replaced: FileChange = {
      ...file,
      id: 'f6',
      hunks: [
        {
          id: 'h6',
          header: '@@ -1,40 +1,1 @@',
          oldStart: 1,
          oldLines: 40,
          newStart: 1,
          newLines: 1,
          patch: [...Array.from({ length: 40 }, (_, i) => `-old ${i}`), '+new'].join('\n'),
        },
      ],
    };
    const { walkthrough, warnings } = walk([entry(0, [snippet('f6', 'h6', 1, 1, 1)])], 1, [replaced]);
    expect(walkthrough).toBeUndefined();
    expect(warnings).toEqual([
      'Dropped a snippet of decision 0: f6:1 shows more than 16 rows at its focus.',
      'Dropped the walkthrough of decision 0: none of its code is in the diff.',
    ]);
  });

  it('narrows a very large hunk quickly', () => {
    const rows = 20_000;
    const huge: FileChange = {
      ...file,
      id: 'f5',
      hunks: [
        {
          id: 'h5',
          header: `@@ -0,0 +1,${rows} @@`,
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: rows,
          patch: Array.from({ length: rows }, (_, i) => `+line ${i}`).join('\n'),
        },
      ],
    };
    const started = performance.now();
    const { walkthrough } = walk([entry(0, [snippet('f5', 'h5', 1, rows, 10_000)])], 1, [huge]);
    expect(walkthrough!.decisions[0]!.snippets[0]).toMatchObject({ from: 9_992, to: 10_007, focus: 10_000 });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('makes a tree a tree, maps its snippets, and keeps only lines the diff shows', () => {
    const at = [snippet('f9', 'h1', 1, 1, 1), snippet('f1', 'h1', 10, 13, 11)];
    const { walkthrough } = walk([
      entry(0, at, {
        tree: 'calls',
        nodes: [
          node(1, { name: 'handler', fileId: 'f1', line: 99 }),
          node(3, {
            receiver: 'Rules.',
            name: 'check',
            args: '(a, b)',
            status: 'new',
            fileId: 'src/a.ts',
            line: 12,
            snippet: 1,
          }),
          node(1, { name: '', label: '' }),
          node(1, { label: 'Every other caller', note: 'admin, MCP', snippet: 0 }),
        ],
      }),
    ]);
    expect(walkthrough!.decisions[0]!.tree).toEqual([
      // A root never nests, and a line outside the diff is a guess, so it goes.
      { kind: 'call', depth: 0, name: 'handler', path: 'src/a.ts', status: 'same' },
      // Snippet 1 is the first one kept; snippet 0 was dropped, so the row loses it.
      {
        kind: 'call',
        depth: 1,
        receiver: 'Rules',
        name: 'check',
        args: 'a, b',
        path: 'src/a.ts',
        line: 12,
        status: 'new',
        snippet: 0,
      },
      { kind: 'concept', depth: 1, label: 'Every other caller', note: 'admin, MCP' },
    ]);
  });

  it('drops a tree that is a list, or a call path with nothing new on it', () => {
    const at = [snippet('f1', 'h1', 10, 13, 11)];
    const tree = (kind: Raw['tree'], nodes: RawNode[]) =>
      walk([entry(0, at, { tree: kind, nodes })]).walkthrough!.decisions[0]!.tree;
    expect(tree('concepts', [node(0, { label: 'A' }), node(0, { label: 'B' })])).toBeUndefined();
    expect(tree('calls', [node(0, { name: 'a' }), node(1, { name: 'b' })])).toBeUndefined();
    expect(tree('none', [node(0, { name: 'a' }), node(1, { name: 'b', status: 'new' })])).toBeUndefined();
    expect(tree('concepts', [node(0, { label: 'Counts' }), node(1, { label: 'capture' })])).toHaveLength(2);
  });

  it('keeps refs to known files and links to other listed decisions', () => {
    const at = [snippet('f1', 'h1', 10, 13, 11)];
    const { walkthrough } = walk([
      entry(0, at, {
        refs: [
          { label: 'Admin check', fileId: 'f2', line: 16 },
          { label: 'Elsewhere', fileId: 'f1', line: 500 },
          { label: 'Elsewhere', fileId: 'f1', line: 501 },
          { label: 'Gone', fileId: 'f9', line: 1 },
        ],
        links: [
          { to: 2, text: 'Forces it.' },
          { to: 2, text: 'Again.' },
          { to: 0, text: 'Itself.' },
          { to: 7, text: 'Nowhere.' },
        ],
      }),
    ]);
    expect(walkthrough!.decisions[0]!.refs).toEqual([
      { label: 'Admin check', fileId: 'f2', line: 16 },
      { label: 'Elsewhere', fileId: 'f1' },
    ]);
    expect(walkthrough!.decisions[0]!.links).toEqual([{ to: 2, text: 'Forces it.' }]);
  });
});

describe('normalizeWalkthrough call paths', () => {
  // 40 new-side lines; changes at 16 (added) and 30 (added, after a removed line).
  const patch = Array.from({ length: 40 }, (_, i) =>
    i + 1 === 16 ? '+new' : i + 1 === 30 ? '-old\n+new' : ` line ${i + 1}`,
  ).join('\n');
  const long: FileChange = {
    ...file,
    id: 'f2',
    path: 'src/b.ts',
    hunks: [{ id: 'h2', header: '@@ -1,40 +1,40 @@', oldStart: 1, oldLines: 40, newStart: 1, newLines: 40, patch }],
  };
  const files = [file, long];
  const frame = (depth: number, name: string, status: 'new' | 'changed' | 'same', fileId = 'f1', line = 0) => ({
    depth,
    receiver: '',
    name,
    args: '',
    fileId,
    line,
    status,
  });
  const rawFrames = [frame(0, 'handler', 'same', ''), frame(1, 'check', 'new', '')];
  const frames = [
    { depth: 0, name: 'handler', status: 'same' as const },
    { depth: 1, name: 'check', status: 'new' as const },
  ];
  const walk = (raw: Parameters<typeof normalizeWalkthrough>[0], list = files) =>
    normalizeWalkthrough({ decisions: [], frames: rawFrames, ...raw }, list, 0);
  const step = (excerpts: { fileId: string; hunkId: string; from: number; to: number }[], picked = [0]) => ({
    title: 'Step',
    text: 'Does a thing.',
    frames: picked,
    excerpts,
  });

  it('pins excerpts to lines the diff shows, trimmed to the changes plus a little context', () => {
    const { walkthrough, warnings } = walk({
      steps: [
        step(
          [
            // The whole hunk: trimmed to 16..30 with 3 lines around.
            { fileId: 'f2', hunkId: 'h2', from: 1, to: 40 },
            // A wrong hunk id is repaired from the line; a path works as a file id.
            { fileId: 'src/a.ts', hunkId: 'nope', from: 11, to: 12 },
          ],
          [1, 0, 1, 7, -1],
        ),
        step([
          // Lines outside the hunk mean the model guessed: show the hunk's changes instead.
          { fileId: 'f1', hunkId: 'h1', from: 500, to: 600 },
          { fileId: 'f9', hunkId: 'h1', from: 1, to: 2 },
        ]),
      ],
    });
    expect(warnings).toEqual(['Dropped a call path excerpt: f9/h1 is not in the diff, or too long to show.']);
    expect(walkthrough).toEqual({
      decisions: [],
      frames,
      steps: [
        {
          title: 'Step',
          text: 'Does a thing.',
          frames: [0, 1],
          excerpts: [
            { fileId: 'f2', hunkId: 'h2', from: 13, to: 33 },
            { fileId: 'f1', hunkId: 'h1', from: 11, to: 12 },
          ],
        },
        {
          title: 'Step',
          text: 'Does a thing.',
          frames: [0],
          excerpts: [{ fileId: 'f1', hunkId: 'h1', from: 10, to: 13 }],
        },
      ],
    });
  });

  it('caps a long excerpt, overlapping excerpts, and the number of steps', () => {
    const spread: FileChange = {
      ...long,
      hunks: [{ ...long.hunks[0]!, patch: patch.replace(' line 1\n', '+first\n').replace(' line 40', '+last') }],
    };
    const { walkthrough } = walk(
      {
        steps: Array.from({ length: 7 }, () =>
          step([
            { fileId: 'f2', hunkId: 'h2', from: 1, to: 40 },
            { fileId: 'f2', hunkId: 'h2', from: 20, to: 22 },
          ]),
        ),
      },
      [spread],
    );
    expect(walkthrough!.steps).toHaveLength(5);
    expect(walkthrough!.steps[0]!.excerpts).toEqual([{ fileId: 'f2', hunkId: 'h2', from: 1, to: 29 }]);
  });

  it('drops steps with no code, and a path of fewer than two steps', () => {
    const one = walk({
      steps: [step([{ fileId: 'f1', hunkId: 'h1', from: 10, to: 13 }]), step([]), { ...step([]), title: '' }],
    });
    expect(one.walkthrough).toBeUndefined();
    expect(one.warnings).toEqual(['Dropped the call path: it has fewer than two steps with code.']);
    expect(walk({ steps: [] })).toEqual({ warnings: [] });
  });

  it('makes the call tree a tree, resolves files, and keeps only lines the diff shows', () => {
    const steps = [
      step([{ fileId: 'f1', hunkId: 'h1', from: 10, to: 13 }]),
      step([{ fileId: 'f1', hunkId: 'h1', from: 10, to: 13 }]),
    ];
    const { walkthrough } = walk({
      frames: [
        frame(1, 'handler', 'same', 'f1', 99),
        { ...frame(3, 'check', 'new', 'src/a.ts', 12), receiver: 'Rules.', args: '(a, b)' },
        frame(1, 'save', 'changed', 'nope', 11),
      ],
      steps,
    });
    expect(walkthrough!.frames).toEqual([
      // An entry point never nests, and a line outside the diff is a guess, so it goes.
      { depth: 0, name: 'handler', path: 'src/a.ts', status: 'same' },
      { depth: 1, receiver: 'Rules', name: 'check', args: 'a, b', path: 'src/a.ts', line: 12, status: 'new' },
      { depth: 1, name: 'save', status: 'changed' },
    ]);
    // A tree with no calls is a list, and one with nothing new is plumbing.
    expect(walk({ frames: [frame(0, 'a', 'new'), frame(0, 'b', 'new')], steps }).warnings).toEqual([
      'Dropped the call path: its call tree has no calls, which a list says as well.',
    ]);
    expect(walk({ frames: [frame(0, 'a', 'same'), frame(1, 'b', 'same')], steps }).walkthrough).toBeUndefined();
    expect(walk({ frames: [], steps })).toEqual({ warnings: [] });
  });

  it('follows step frames past a dropped unnamed frame', () => {
    const at = [{ fileId: 'f1', hunkId: 'h1', from: 10, to: 13 }];
    const { walkthrough } = walk({
      frames: [
        frame(0, 'root', 'same'),
        frame(1, '', 'same'),
        frame(1, 'caller', 'changed'),
        frame(2, 'callee', 'new'),
      ],
      steps: [step(at, [2]), step(at, [3, 1])],
    });
    expect(walkthrough!.frames.map((frame) => frame.name)).toEqual(['root', 'caller', 'callee']);
    expect(walkthrough!.steps.map((step) => step.frames)).toEqual([[1], [2]]);
  });

  it('keeps lines removed at the end of a hunk, and counts removed rows toward the cap', () => {
    const trailing: FileChange = {
      ...file,
      id: 'f3',
      hunks: [
        {
          id: 'h3',
          header: '@@ -1,4 +1,3 @@',
          oldStart: 1,
          oldLines: 4,
          newStart: 1,
          newLines: 3,
          patch: ' a\n b\n c\n-oldCall()',
        },
      ],
    };
    const removed = Array.from({ length: 40 }, (_, i) => `-old ${i}`).join('\n');
    const replaced: FileChange = {
      ...file,
      id: 'f4',
      hunks: [
        {
          id: 'h4',
          header: '@@ -1,42 +1,3 @@',
          oldStart: 1,
          oldLines: 42,
          newStart: 1,
          newLines: 3,
          patch: ` a\n${removed}\n+new\n b`,
        },
      ],
    };
    const excerpts = (list: FileChange[], fileId: string, hunkId: string) =>
      walk({ steps: [step([{ fileId, hunkId, from: 1, to: 3 }]), step([{ fileId, hunkId, from: 1, to: 3 }])] }, list);
    // The removed call sits after line 3; the excerpt still reaches it.
    expect(excerpts([trailing], 'f3', 'h3').walkthrough!.steps[0]!.excerpts).toEqual([
      { fileId: 'f3', hunkId: 'h3', from: 1, to: 3 },
    ]);
    // 40 removed rows at one spot can never fit in 30, so the excerpt goes.
    expect(excerpts([replaced], 'f4', 'h4').walkthrough).toBeUndefined();
  });

  it('caps a very large hunk in one pass', () => {
    const rows = 20_000;
    const huge: FileChange = {
      ...file,
      id: 'f5',
      hunks: [
        {
          id: 'h5',
          header: `@@ -0,0 +1,${rows} @@`,
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: rows,
          patch: Array.from({ length: rows }, (_, i) => `+line ${i}`).join('\n'),
        },
      ],
    };
    const started = performance.now();
    const { walkthrough } = walk(
      {
        steps: [
          step([{ fileId: 'f5', hunkId: 'h5', from: 0, to: 0 }]),
          step([{ fileId: 'f5', hunkId: 'h5', from: 0, to: 0 }]),
        ],
      },
      [huge],
    );
    expect(walkthrough!.steps[0]!.excerpts).toEqual([{ fileId: 'f5', hunkId: 'h5', from: 1, to: 30 }]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('takes an excerpt from the hunk that holds its lines over a hunk id that names another', () => {
    const split: FileChange = {
      ...file,
      id: 'f4',
      hunks: [
        {
          id: 'a',
          header: '@@ -1,5 +1,5 @@',
          oldStart: 1,
          oldLines: 5,
          newStart: 1,
          newLines: 5,
          patch: ' 1\n 2\n+3\n 4\n 5',
        },
        {
          id: 'b',
          header: '@@ -20,5 +20,5 @@',
          oldStart: 20,
          oldLines: 5,
          newStart: 20,
          newLines: 5,
          patch: ' 20\n 21\n+22\n 23\n 24',
        },
      ],
    };
    const excerpt = { fileId: 'f4', hunkId: 'a', from: 21, to: 23 };
    const { walkthrough } = walk({ steps: [step([excerpt]), step([excerpt])] }, [split]);
    expect(walkthrough!.steps[0]!.excerpts).toEqual([{ fileId: 'f4', hunkId: 'b', from: 21, to: 23 }]);
    // A range that starts on the last line of one hunk reads the next one.
    const across = { fileId: 'f4', hunkId: 'a', from: 5, to: 24 };
    const next = walk({ steps: [step([across]), step([across])] }, [split]);
    expect(next.walkthrough!.steps[0]!.excerpts).toEqual([{ fileId: 'f4', hunkId: 'b', from: 20, to: 24 }]);
  });

  it('keeps call paths next to decision entries', () => {
    const at = { fileId: 'f1', hunkId: 'h1', from: 10, to: 13 };
    const decision = {
      decision: 0,
      title: 'A choice',
      why: 'Because.',
      instead: '',
      check: '',
      snippets: [{ ...at, focus: 11, caption: 'These lines.', note: '' }],
      tree: 'none' as const,
      nodes: [],
      refs: [],
      links: [],
    };
    const { walkthrough } = normalizeWalkthrough(
      { decisions: [decision], frames: rawFrames, steps: [step([at]), step([at])] },
      files,
      1,
    );
    expect(walkthrough!.decisions.map((walk) => walk.title)).toEqual(['A choice']);
    expect(walkthrough!.frames).toEqual(frames);
    expect(walkthrough!.steps).toHaveLength(2);

    // A decision whose call tree already shows every new or changed frame walks the path.
    const row = { receiver: '', args: '', label: '', note: '', fileId: '', line: 0, snippet: -1 };
    const covered = normalizeWalkthrough(
      {
        decisions: [
          {
            ...decision,
            tree: 'calls',
            nodes: [
              { ...row, depth: 0, name: 'handler', status: 'same' },
              { ...row, depth: 1, name: 'check', status: 'new', fileId: 'f1' },
            ],
          },
        ],
        frames: [frame(0, 'handler', 'same', ''), frame(1, 'check', 'new', 'f1')],
        steps: [step([at]), step([at])],
      },
      files,
      1,
    );
    expect(covered.walkthrough).toMatchObject({ frames: [], steps: [] });
    expect(covered.warnings).toEqual(['Dropped the call path: the decisions already walk it.']);
    // The same name in another file, or in no known file, is another function: the path stays.
    const elsewhere = normalizeWalkthrough(
      {
        decisions: [
          {
            ...decision,
            tree: 'calls',
            nodes: [
              { ...row, depth: 0, name: 'handler', status: 'same' },
              { ...row, depth: 1, name: 'check', status: 'new', fileId: 'f2' },
            ],
          },
        ],
        frames: [frame(0, 'handler', 'same', ''), frame(1, 'check', 'new', 'f1')],
        steps: [step([at]), step([at])],
      },
      files,
      1,
    );
    expect(elsewhere.walkthrough!.steps).toHaveLength(2);
  });
});
