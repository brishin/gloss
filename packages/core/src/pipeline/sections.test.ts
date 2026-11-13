import type { FileChange, GroupNotes, ResolvedGroup } from '@gloss/protocol';
import { describe, expect, test } from 'vitest';
import {
  contractFlags,
  hunkCut,
  type HunkScore,
  normalizeKeyStops,
  normalizeSection,
  type SectionContext,
  skippableHunks,
  uncoveredKeyHunks,
  walkedGroups,
} from './sections.ts';

const patch = Array.from({ length: 60 }, (_, i) => `+line ${i + 1}`).join('\n');
const file: FileChange = {
  id: 'f1',
  path: 'src/a.ts',
  status: 'modified',
  additions: 60,
  deletions: 0,
  isBinary: false,
  truncated: false,
  hunks: [{ id: 'h1', header: '@@ -0,0 +1,60 @@', oldStart: 0, oldLines: 0, newStart: 1, newLines: 60, patch }],
};
const group = { key: 'core', label: 'Core', summary: '', fileIds: ['f1'] } as unknown as ResolvedGroup;
const notes: GroupNotes = { fileNotes: [], lineNotes: [], riskNotes: [] };
const stop = (title: string, at: number, kind: 'decision' | 'step', priority = '') => ({
  kind,
  decision: -1,
  priority,
  title,
  why: `why ${title}`,
  instead: '',
  check: '',
  snippets: [{ fileId: 'f1', hunkId: 'h1', from: at, to: at + 3, focus: at + 1, caption: '' }],
});
const raw = {
  points: [
    stop('low', 1, 'decision', 'low'),
    stop('step', 6, 'step'),
    stop('repeat', 41, 'decision', 'medium'),
    stop('medium', 11, 'decision', 'medium'),
    stop('step past the cap', 16, 'step'),
    stop('high', 21, 'decision', 'high'),
    stop('low past the cap', 26, 'decision', 'low'),
  ],
  rest: '',
  skim: [],
};
const none: SectionContext = { wideHere: [], pathHere: [], shownInTour: [] };
const hunk = (id: string, oldStart: number, newStart: number, patch: string): FileChange['hunks'][number] => ({
  id,
  header: `@@ ${id} @@`,
  oldStart,
  oldLines: patch.split('\n').filter((row) => row[0] !== '+').length,
  newStart,
  newLines: patch.split('\n').filter((row) => row[0] !== '-').length,
  patch,
});
const four: FileChange = {
  ...file,
  hunks: [
    hunk('h1', 0, 1, '+a\n+b\n+c'),
    hunk('h2', 9, 20, ' d\n-e\n f'),
    hunk('h3', 19, 40, '+f\n+g'),
    hunk('h4', 29, 60, '+h\n+i'),
  ],
};
const refs = (...ids: string[]) => ids.map((hunkId) => ({ fileId: 'f1', hunkId }));

describe('normalizeSection', () => {
  test('the 3 stops that matter most keep their code, every decision keeps its claim, and a step past them goes', () => {
    const pathHere = [{ fileId: 'f1', hunkId: 'h1', from: 40, to: 48 }];
    const { section } = normalizeSection(raw, group, [file], notes, { ...none, pathHere });
    expect(section.points.map((point) => [point.title, point.kind, point.snippets.length, point.see?.line])).toEqual([
      ['low', 'decision', 1, undefined],
      // Its lines are in the code path above the stops, so it is read as its claim with a link.
      ['repeat', 'decision', 0, 42],
      ['medium', 'decision', 1, undefined],
      ['high', 'decision', 1, undefined],
      ['low past the cap', 'decision', 0, 27],
    ]);
  });

  test('a change-wide stop the call did not place leads the walk, and one it placed keeps its place', () => {
    const walk = (decision: number) => ({ decision, title: '', why: '', snippets: [], refs: [], links: [] }) as never;
    const placed = { kind: 'wide', wide: 4 };
    const { section } = normalizeSection(
      { points: [stop('own', 1, 'step'), placed, { kind: 'wide', wide: 9 }, placed] },
      group,
      [file],
      notes,
      { ...none, wideHere: [walk(2), walk(4)] },
    );
    expect(section.points.map((point) => point.wide ?? point.title)).toEqual([2, 'own', 4]);
  });

  test('a file folds only when nothing points at it', () => {
    const other = { ...file, id: 'f2', path: 'src/b.ts' };
    const third = { ...file, id: 'f3', path: 'src/c.ts' };
    const fourth = { ...file, id: 'f4', path: 'src/d.ts' };
    const { section } = normalizeSection(
      { points: [stop('stop', 1, 'step')], skim: ['f1', 'f2', 'f3', 'f4', 'f4', 'nope'] },
      { ...group, fileIds: ['f1', 'f2', 'f3', 'f4'] },
      [file, other, third, fourth],
      { ...notes, fileNotes: [{ fileId: 'f2', text: 'note' }] },
      { ...none, shownInTour: [{ fileId: 'f3', hunkId: 'h1' }] },
    );
    // f1 holds the stop, f2 a note, and the walkthrough shows f3.
    expect(section.skim).toEqual(['f4']);
  });

  test('a file a claim-only stop links to does not fold', () => {
    const other = { ...file, id: 'f2', path: 'src/b.ts' };
    const on = (fileId: string, title: string, at: number, priority: string) => {
      const entry = stop(title, at, 'decision', priority);
      entry.snippets[0]!.fileId = fileId;
      return entry;
    };
    const { section } = normalizeSection(
      {
        points: [
          on('f1', 'a', 1, 'high'),
          on('f1', 'b', 11, 'high'),
          on('f1', 'c', 21, 'high'),
          on('f2', 'd', 1, 'low'),
        ],
        skim: ['f2'],
      },
      { ...group, fileIds: ['f1', 'f2'] },
      [file, other],
      notes,
      none,
    );
    expect(section.points.at(-1)).toMatchObject({ title: 'd', snippets: [], see: { fileId: 'f2', line: 2 } });
    expect(section.skim).toEqual([]);
  });

  test('a claim-only stop keeps its own hunk open, not one whose old lines hold the same number', () => {
    // Line 111 is in hB on the new side, and in hA's old lines 100-119.
    const shifted: FileChange = {
      ...file,
      id: 'f2',
      path: 'src/b.ts',
      hunks: [
        hunk('hA', 100, 10, [...Array.from({ length: 19 }, () => ' same'), '-gone'].join('\n')),
        hunk('hB', 200, 110, Array.from({ length: 10 }, (_, i) => `+new ${i}`).join('\n')),
      ],
    };
    const claim = stop('d', 110, 'decision', 'low');
    claim.snippets[0] = { ...claim.snippets[0]!, fileId: 'f2', hunkId: 'hB' };
    const high = (title: string, at: number) => stop(title, at, 'decision', 'high');
    const { section } = normalizeSection(
      { points: [high('a', 1), high('b', 11), high('c', 21), claim] },
      { ...group, fileIds: ['f1', 'f2'] },
      [file, shifted],
      notes,
      {
        ...none,
        hunks: {
          skip: [
            { fileId: 'f2', hunkId: 'hA' },
            { fileId: 'f2', hunkId: 'hB' },
          ],
          contract: [],
        },
      },
    );
    expect(section.points.at(-1)).toMatchObject({ title: 'd', see: { fileId: 'f2', line: 111 } });
    expect(section.skimHunks).toEqual([{ fileId: 'f2', hunkId: 'hA' }]);
  });

  test('a hunk folds only when nothing points at it, and never without scores', () => {
    const stops = { points: [stop('stop', 1, 'step')] };
    const noted = {
      ...notes,
      lineNotes: [{ fileId: 'f1', hunkId: '', side: 'additions' as const, line: 21, text: 'note' }],
    };
    const shownInTour = [{ fileId: 'f1', hunkId: 'h3' }];
    const { section, covered } = normalizeSection(stops, group, [four], noted, {
      ...none,
      shownInTour,
      hunks: { skip: refs('h1', 'h2', 'h3', 'h4', 'h4', 'nope'), contract: [] },
    });
    // h1 holds the stop, h2 a note's line, and the walkthrough shows h3.
    expect(section.skimHunks).toEqual(refs('h4'));
    expect([...covered!].toSorted()).toEqual(['f1:h1', 'f1:h2', 'f1:h3']);
    const unscored = normalizeSection(stops, group, [four], noted, { ...none, shownInTour });
    expect(unscored.section.skimHunks).toBeUndefined();
    expect(unscored.covered).toBeUndefined();
  });

  test('one flag a file lands on the first changed line of its surest hunk nothing points at, and not on a folded one', () => {
    const { section } = normalizeSection({ points: [stop('stop', 1, 'step')] }, group, [four], notes, {
      ...none,
      hunks: { skip: refs('h4'), contract: refs('h1', 'h2', 'h3', 'h4') },
    });
    // h1, the surest, holds the stop, so the file's one flag goes to the next: h2, whose first change is its removed line.
    expect(section.hunkFlags).toEqual([{ fileId: 'f1', hunkId: 'h2', side: 'deletions', line: 10, flag: 'contract' }]);
  });
});

describe('hunk scores', () => {
  const scores: HunkScore[] = [
    { fileId: 'f1', hunkId: 'h1', skip: 0.1, contract: 0.85, key: 0.9 },
    { fileId: 'f1', hunkId: 'h2', skip: 0.1, contract: 0.92, key: 0.85 },
    { fileId: 'f1', hunkId: 'h3', skip: 0.7, contract: 0.95, key: 0.95 },
    { fileId: 'f2', hunkId: 'h1', skip: 0.69, contract: 0.79, key: 0.81 },
    // A hunk whose Jev call failed is never folded or flagged.
    { fileId: 'f3', hunkId: 'h1' },
  ];

  test('a hunk Jev reads only the start of is cut', () => {
    expect(hunkCut(hunk('h', 0, 1, '+a'))).toBe(false);
    expect(hunkCut(hunk('h', 0, 1, `+${'a'.repeat(6000)}`))).toBe(true);
  });

  test('a hunk folds at 0.7 on the skip question', () => {
    expect(skippableHunks(scores)).toEqual([{ fileId: 'f1', hunkId: 'h3' }]);
  });

  test('the contract flag is offered at 0.8, surest first, never on a skippable hunk', () => {
    expect(contractFlags(scores)).toEqual([
      { fileId: 'f1', hunkId: 'h2' },
      { fileId: 'f1', hunkId: 'h1' },
    ]);
  });

  test('a key hunk counts as missed only when nothing reaches it and it is open', () => {
    const section = { points: [], skim: ['f2'], skimHunks: [{ fileId: 'f1', hunkId: 'h3' }] };
    expect(uncoveredKeyHunks(scores, section, new Set(['f1:h1'])).map((score) => score.hunkId)).toEqual(['h2']);
  });
});

describe('normalizeKeyStops', () => {
  test('keeps one snippet per stop, only on an offered hunk, and no more stops than hunks', () => {
    const two = { ...stop('two snippets', 1, 'decision', 'high'), tree: 'calls' };
    two.snippets.push({ fileId: 'f1', hunkId: 'h1', from: 2, to: 3, focus: 2, caption: '' });
    const points = normalizeKeyStops(
      { points: [stop('elsewhere', 40, 'step'), two, stop('past the offer', 60, 'step')] },
      group,
      [four],
      refs('h1'),
    );
    expect(points.map((point) => [point.title, point.kind, point.snippets.length, point.tree])).toEqual([
      ['two snippets', 'decision', 1, undefined],
    ]);
  });
});

describe('walkedGroups', () => {
  const change = (path: string, lines: number) => ({ ...file, id: path, path, additions: lines });
  const of = (key: string, category: string, paths: string[]) =>
    ({ key, label: key, summary: '', category, fileIds: paths }) as unknown as ResolvedGroup;
  const walked = (files: FileChange[], groups: ResolvedGroup[]) =>
    walkedGroups(groups, files).map((entry) => entry.key);

  test.each([
    // Docs and tests read file by file; the code keeps its walk.
    [
      'by category',
      [change('src/a.ts', 60), change('src/a.test.ts', 100), change('docs/a.md', 20), change('build.gradle', 2)],
      [
        of('docs', 'docs', ['docs/a.md']),
        of('core', 'core', ['src/a.ts']),
        of('tests', 'tests', ['src/a.test.ts', 'build.gradle']),
      ],
      ['core'],
    ],
    // Whatever the definition calls a group, one that holds only tests or only docs is one.
    [
      'by its files',
      [change('src/a.ts', 60), change('src/a.test.ts', 100), change('README.md', 20), change('src/b.ts', 5)],
      [
        of('intro', 'core', ['README.md']),
        of('core', 'core', ['src/a.ts']),
        of('checks', 'core', ['src/a.test.ts']),
        of('mixed', 'core', ['src/b.ts', 'README.md']),
      ],
      ['core', 'mixed'],
    ],
    // When little but tests changed, the tests are the change and keep their walks. Docs never do.
    [
      'tests lead',
      [change('src/a.ts', 2), change('e2e/a.test.ts', 300), change('e2e/b.test.ts', 50), change('docs/a.md', 400)],
      [
        of('docs', 'docs', ['docs/a.md']),
        of('core', 'core', ['src/a.ts']),
        of('tests', 'tests', ['e2e/a.test.ts']),
        of('support', 'core', ['e2e/b.test.ts']),
      ],
      ['core', 'tests', 'support'],
    ],
  ] as const)('%s', (_name, files, groups, expected) => {
    expect(walked([...files], [...groups])).toEqual(expected);
  });
});
