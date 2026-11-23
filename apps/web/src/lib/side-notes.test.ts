import type { GroupView, TourState } from '@gloss/protocol';
import { describe, expect, test } from 'vitest';
import { noteFrames, noteLines, readStops, sideNotes } from './side-notes.ts';

const snippet = (fileId: string, from: number, to = from + 2) => ({
  fileId,
  hunkId: 'h',
  from,
  to,
  focus: from,
  caption: '',
});

/** Group `a` holds f1 and f2; f2 has a confirmed risk, so it is read first. */
const group = (notes: unknown, key = 'a', fileIds = ['f1', 'f2']) =>
  ({ key, fileIds, notes: { riskNotes: [{ fileId: 'f2', text: '' }], ...(notes as object) } }) as unknown as GroupView;

const tour = (overrides: unknown = {}) => overrides as Pick<TourState, 'decisions' | 'walkthrough'>;

describe('sideNotes', () => {
  test('a stop sits on its first snippet in the group; its other snippets are its reach', () => {
    const [note] = sideNotes(
      tour(),
      [
        group({
          section: {
            points: [
              {
                kind: 'decision',
                priority: 'high',
                title: 'T',
                why: 'W',
                check: 'C',
                snippets: [snippet('x', 1), snippet('f1', 10, 14), snippet('f2', 3)],
              },
            ],
          },
        }),
      ],
      new Map(),
    );
    expect(note).toMatchObject({
      id: 'a/p0',
      n: 1,
      key: true,
      level: 'investigate',
      title: 'T',
      why: 'W',
      check: 'C',
      fileId: 'f1',
      from: 10,
      to: 14,
      also: [
        { fileId: 'x', line: 1 },
        { fileId: 'f2', line: 3 },
      ],
    });
  });

  test('a stop with no snippets sits where it points, or where the decision it reads is', () => {
    const notes = sideNotes(
      tour(),
      [
        group({
          decisions: [{ text: 'd', priority: 'low', fileId: 'f1', side: 'additions', line: 7 }],
          section: {
            points: [
              { kind: 'step', title: 'see', why: '', see: { fileId: 'f1', line: 40 }, snippets: [] },
              { kind: 'decision', decision: 0, title: 'reads', why: '', snippets: [] },
            ],
          },
        }),
      ],
      new Map(),
    );
    // The decision a stop reads is not a note of its own, and gives the stop its level.
    expect(notes.map(({ title, from, level, key }) => ({ title, from, level, key }))).toEqual([
      { title: 'reads', from: 7, level: 'info', key: false },
      { title: 'see', from: 40, level: undefined, key: false },
    ]);
  });

  test('notes about the group lead; the rest follow the files down the page, by line', () => {
    const state = tour({
      decisions: [
        { text: 'wide', priority: 'urgent', groupKey: 'a' },
        { text: 'matched', priority: 'medium', groupKey: 'a' },
        { text: 'elsewhere', priority: 'medium', groupKey: 'b' },
      ],
      walkthrough: {
        decisions: [
          {
            decision: 0,
            title: 'Wide',
            why: 'w',
            snippets: [snippet('f1', 5)],
            refs: [{ label: 'r', fileId: 'f2' }],
            links: [],
          },
        ],
      },
    });
    const notes = sideNotes(
      state,
      [
        group({
          decisions: [
            { text: 'f1 late', priority: 'low', fileId: 'f1', side: 'additions', line: 90 },
            { text: 'f2', priority: 'low', fileId: 'f2', side: 'deletions', line: 4 },
            { text: 'on a file', priority: 'low', fileId: 'f1' },
          ],
          section: { points: [{ kind: 'wide', wide: 0, title: '', why: '', snippets: [] }] },
        }),
      ],
      new Map([[0, 'a']]),
    );
    expect(notes.map((note) => [note.n, note.id, note.fileId, note.from])).toEqual([
      // A change-wide decision a walk reads is the walk's note, not also a plain one.
      [1, 'a/c1', undefined, undefined],
      [2, 'a/d1', 'f2', 4],
      [3, 'a/d2', 'f1', undefined],
      [4, 'a/w0', 'f1', 5],
      [5, 'a/d0', 'f1', 90],
    ]);
    expect(notes[1]!.side).toBe('deletions');
    expect(notes[3]).toMatchObject({ title: 'Wide', level: 'severe', key: true, also: [{ label: 'r', fileId: 'f2' }] });
  });
});

test('numbers run on from one group to the next, in reading order', () => {
  const groups = [
    group({
      decisions: [
        { text: 'line', priority: 'low', fileId: 'f1', side: 'additions', line: 3 },
        { text: 'group', priority: 'low' },
      ],
    }),
    group({ decisions: [{ text: 'next', priority: 'low', fileId: 'f3', side: 'additions', line: 1 }] }, 'b', ['f3']),
  ];
  expect(sideNotes(tour(), groups, new Map()).map((note) => [note.n, note.id])).toEqual([
    [1, 'a/d1'],
    [2, 'a/d0'],
    [3, 'b/d0'],
  ]);
});

describe('readStops', () => {
  test('a file with notes is read as its notes; one with none is a stop itself', () => {
    const groups = [
      group({
        decisions: [
          { text: 'd', priority: 'low', fileId: 'f1', side: 'additions', line: 1 },
          { text: 'g', priority: 'low' },
        ],
      }),
      group(undefined, 'b', ['f3']),
    ];
    expect(readStops(tour(), groups, new Map()).map((stop) => ('note' in stop ? stop.note.id : stop.fileId))).toEqual([
      'a/d1',
      'f2',
      'a/d0',
      'f3',
    ]);
  });
});

describe('noteFrames', () => {
  test('a note is in the last frame defined at or above its first line, in its file', () => {
    const frames = [
      { depth: 0, name: 'entry', status: 'same' },
      { depth: 1, name: 'a', status: 'changed', path: 'src/f1.ts', line: 10 },
      { depth: 1, name: 'b', status: 'new', path: 'src/f1.ts', line: 50 },
      { depth: 2, name: 'c', status: 'new', path: 'src/f2.ts', line: 1 },
    ] as const;
    const notes = sideNotes(
      tour(),
      [
        group({
          decisions: [5, 10, 49, 60].map((line) => ({
            text: `${line}`,
            priority: 'low',
            fileId: 'f1',
            side: 'additions',
            line,
          })),
        }),
      ],
      new Map(),
    );
    const found = noteFrames(frames, notes, (fileId) => `src/${fileId}.ts`);
    expect(notes.map((note) => found.get(note.id))).toEqual([undefined, 1, 1, 2]);
  });
});

test('noteLines', () => {
  expect([noteLines({}), noteLines({ from: 3, to: 3 }), noteLines({ from: 3, to: 9 })]).toEqual(['', '3', '3–9']);
});
