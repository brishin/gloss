import type { FileSummary, GroupView, RecentTour, Stack } from '@gloss/protocol';
import { describe, expect, test } from 'vitest';
import {
  byCategory,
  countViewed,
  filterGroups,
  findEntry,
  railAround,
  railSections,
  type RecentEntry,
  recentEntries,
  splitByViewer,
} from './sidebar-tree.ts';

function group(key: string, category: GroupView['category'], fileIds: string[], label = key): GroupView {
  return { key, label, category, critical: false, fileIds, phase: 'resolved', synthetic: false };
}

const GROUPS = [
  group('discovery', 'api', ['f1', 'f2'], 'Stack discovery'),
  group('parents', 'core', ['f3']),
  group('client', 'api', ['f4']),
  group('tests', 'tests', ['f5']),
];

const FILES = new Map(
  [
    ['f1', 'packages/core/src/sources/gh-stack.ts'],
    ['f2', 'packages/core/src/sources/gh.ts'],
    ['f3', 'packages/core/src/sources/stack-graph.ts'],
    ['f4', 'packages/protocol/src/client.ts'],
    ['f5', 'packages/core/src/sources/gh-stack.test.ts'],
  ].map(([id, path]) => [id!, { id, path } as FileSummary]),
);

describe('byCategory', () => {
  test('orders categories by their first group and keeps tour indexes', () => {
    expect(
      byCategory(GROUPS).map((bucket) => [
        bucket.category,
        bucket.groups.map(({ group, index }) => [group.key, index]),
      ]),
    ).toEqual([
      [
        'api',
        [
          ['discovery', 0],
          ['client', 2],
        ],
      ],
      ['core', [['parents', 1]]],
      ['tests', [['tests', 3]]],
    ]);
  });

  test('keeps every group exactly once', () => {
    expect(
      byCategory(GROUPS)
        .flatMap((bucket) => bucket.groups.map(({ group }) => group.key))
        .toSorted(),
    ).toEqual(GROUPS.map((g) => g.key).toSorted());
  });
});

describe('filterGroups', () => {
  test.each([
    ['', undefined],
    ['   ', undefined],
    ['discovery', { discovery: ['f1', 'f2'] }],
    ['DISCOVERY', { discovery: ['f1', 'f2'] }],
    ['gh-stack', { discovery: ['f1'], tests: ['f5'] }],
    ['client.ts', { client: ['f4'] }],
    ['nothing-matches', {}],
  ])('%j', (query, expected) => {
    const kept = filterGroups(GROUPS, FILES, query);
    expect(kept && Object.fromEntries(kept)).toEqual(expected);
  });
});

test('countViewed', () => {
  expect(countViewed(['f1', 'f2', 'f3'], new Set(['f2', 'f9']))).toBe(1);
});

describe('recentEntries', () => {
  const stack = (...numbers: number[]): Stack => ({
    owner: 'o',
    repo: 'r',
    base: 'main',
    members: numbers.map((number) => ({ number, title: `#${number}`, state: 'open', baseRef: 'b', headRef: 'h' })),
  });
  const pr = (number: number, inStack?: Stack): RecentTour => ({
    ref: { kind: 'github-pr', owner: 'O', repo: 'R', number },
    title: `#${number}`,
    updatedAt: '',
    ...(inStack ? { stack: inStack } : {}),
  });
  const local: RecentTour = { ref: { kind: 'local', repo: '/repo', target: 'HEAD' }, title: 'local', updatedAt: '' };
  const shape = (entries: ReturnType<typeof recentEntries>) =>
    entries.map((entry) =>
      entry.kind === 'tour' ? entry.tour.title : `stack ${entry.stack.members.map((m) => m.number).join(',')}`,
    );

  test('folds tours of one stack into one row at the newest member', () => {
    const s = stack(1, 2, 3);
    expect(shape(recentEntries([pr(3, s), local, pr(1, s), pr(9)], new Set()))).toEqual(['stack 1,2,3', 'local', '#9']);
  });

  test('a stack of one is a plain row', () => {
    expect(shape(recentEntries([pr(4, stack(4))], new Set()))).toEqual(['#4']);
  });

  test('skips tours already shown, and shows a tour alone when its stale stack overlaps them', () => {
    expect(shape(recentEntries([pr(2, stack(2, 5)), pr(7), pr(8)], new Set(['github:o/r#5', 'github:o/r#7'])))).toEqual(
      ['#2', '#8'],
    );
  });
});

describe('splitByViewer', () => {
  const tour = (number: number, author?: string): RecentTour => ({
    ref: { kind: 'github-pr', owner: 'o', repo: 'r', number },
    title: `#${number}`,
    updatedAt: '',
    ...(author ? { author } : {}),
  });
  const member = (number: number, author: string) => ({
    number,
    title: '',
    state: 'open' as const,
    author,
    baseRef: 'b',
    headRef: 'h',
  });
  const stack = (at: number, ...authors: string[]): RecentTour => ({
    ...tour(at),
    stack: { owner: 'o', repo: 'r', base: 'main', members: authors.map((author, i) => member(at + i, author)) },
  });
  const local: RecentTour = { ref: { kind: 'local', repo: '/repo', target: 'HEAD' }, title: 'local', updatedAt: '' };
  const titles = (entries: ReturnType<typeof recentEntries>) =>
    entries.map((entry) => (entry.kind === 'tour' ? entry.tour.title : `stack ${entry.stack.members.length}`));

  test("puts the viewer's PRs, local diffs, unknown authors and stacks they're in first", () => {
    const entries = recentEntries(
      [tour(1, 'me'), tour(2, 'ana'), local, tour(3), stack(10, 'ana', 'me'), stack(20, 'ana', 'bo')],
      new Set(),
    );
    const { mine, others } = splitByViewer(entries, 'me');
    expect(titles(mine)).toEqual(['#1', 'local', '#3', 'stack 2']);
    expect(titles(others)).toEqual(['#2', 'stack 2']);
  });

  test('splits nothing without a viewer', () => {
    const { mine, others } = splitByViewer(recentEntries([tour(2, 'ana')], new Set()), undefined);
    expect([titles(mine), titles(others)]).toEqual([['#2'], []]);
  });
});

describe('railSections', () => {
  const pr = (number: number, extra: Partial<RecentTour> = {}): RecentTour => ({
    ref: { kind: 'github-pr', owner: 'o', repo: 'r', number },
    title: `#${number}`,
    updatedAt: '',
    ...extra,
  });
  const member = (number: number, state: 'open' | 'merged') => ({
    number,
    title: '',
    state,
    baseRef: 'b',
    headRef: 'h',
  });
  const titles = (entries: ReturnType<typeof recentEntries>) =>
    entries.map((entry) => (entry.kind === 'tour' ? entry.tour.title : `stack ${entry.stack.members.length}`));

  test('orders review requests, then mine, then other open recent tours, each PR once', () => {
    const local: RecentTour = { ref: { kind: 'local', repo: '/r', target: 'HEAD' }, title: 'local', updatedAt: '' };
    const sections = railSections(
      {
        viewer: 'me',
        reviewRequested: [pr(1), pr(9)],
        authored: [
          pr(2, { stack: { owner: 'o', repo: 'r', base: 'main', members: [member(2, 'open'), member(3, 'open')] } }),
        ],
        tours: [pr(3), pr(1), pr(4, { state: 'merged' }), pr(5, { state: 'open' }), local],
      },
      new Set(['github:o/r#9']),
    );
    expect([titles(sections.reviewRequested), titles(sections.mine), titles(sections.recent)]).toEqual([
      ['#1'],
      ['stack 2'],
      ['#5', 'local'],
    ]);
  });

  test("drops a stack once none of its PRs is open, and splits recent tours by author without GitHub's lists", () => {
    const merged = { owner: 'o', repo: 'r', base: 'main', members: [member(6, 'merged'), member(7, 'merged')] };
    const sections = railSections(
      { viewer: 'me', tours: [pr(6, { stack: merged }), pr(8, { author: 'ana' }), pr(10, { author: 'me' })] },
      new Set(),
    );
    expect([titles(sections.reviewRequested), titles(sections.mine), titles(sections.recent)]).toEqual([
      [],
      ['#10'],
      ['#8'],
    ]);
  });
});

describe('findEntry', () => {
  test('finds the row that holds a PR: its own, or its stack', () => {
    const pr = (number: number, extra: Partial<RecentTour> = {}): RecentTour => ({
      ref: { kind: 'github-pr', owner: 'o', repo: 'r', number },
      title: `#${number}`,
      updatedAt: '',
      ...extra,
    });
    const member = (number: number) => ({ number, title: '', state: 'open' as const, baseRef: 'b', headRef: 'h' });
    const sections = railSections(
      {
        reviewRequested: [pr(1)],
        authored: [pr(2, { stack: { owner: 'o', repo: 'r', base: 'main', members: [member(2), member(3)] } })],
        tours: [],
      },
      new Set(),
    );
    expect(findEntry(sections, 'github:o/r#3')).toBe(sections.mine[0]);
    expect(findEntry(sections, 'github:o/r#1')).toBe(sections.reviewRequested[0]);
    expect(findEntry(sections, 'github:o/r#9')).toBeUndefined();
  });
});

describe('railAround', () => {
  const pr = (number: number, extra: Partial<RecentTour> = {}): RecentTour => ({
    ref: { kind: 'github-pr', owner: 'o', repo: 'r', number },
    title: `#${number}`,
    updatedAt: '',
    ...extra,
  });
  const member = (number: number) => ({ number, title: '', state: 'open' as const, baseRef: 'b', headRef: 'h' });
  const stack = (...numbers: number[]): Stack => ({
    owner: 'o',
    repo: 'r',
    base: 'main',
    members: numbers.map(member),
  });
  const titles = (entries: RecentEntry[]) =>
    entries.map((entry) => (entry.kind === 'tour' ? entry.tour.title : `stack ${entry.key}`));

  test("keeps the toured PR's row in place and drops the live stack's other rows", () => {
    const recent = { reviewRequested: [pr(2)], authored: [pr(3, { stack: stack(3, 4) }), pr(5)], tours: [] };
    const { sections, home } = railAround(recent, 'github:o/r#4', stack(2, 3, 4));
    expect(titles(sections.reviewRequested)).toEqual([]);
    expect(titles(sections.mine)).toEqual(['stack github:o/r#3', '#5']);
    expect(home).toBe(sections.mine[0]);
  });

  test('shows a recorded stack that overlaps the live one as its own tour', () => {
    const recent = { tours: [pr(3, { stack: stack(2, 3) })] };
    const { sections, home } = railAround(recent, 'github:o/r#1', stack(1, 2));
    expect(titles(sections.mine)).toEqual(['#3']);
    expect(home).toBeUndefined();
  });
});
