import type { FileSummary, GroupView, RecentTour, Stack } from '@gloss/protocol';
import { describe, expect, test } from 'vitest';
import { byCategory, countViewed, filterGroups, recentEntries } from './sidebar-tree.ts';

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
