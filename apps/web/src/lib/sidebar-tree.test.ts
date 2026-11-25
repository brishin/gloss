import type { FileSummary, GroupView, PullActivity, RecentTour, Stack, StackMember } from '@gloss/protocol';
import { describe, expect, test } from 'vitest';
import {
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

const activity = (extra: Partial<PullActivity> = {}): PullActivity => ({
  additions: 1,
  deletions: 1,
  updatedAt: '2026-11-24T00:00:00Z',
  reviewers: [],
  openThreads: 0,
  comments: { people: 0, bots: 0 },
  ...extra,
});

describe('railSections', () => {
  const pr = (number: number, extra: Partial<RecentTour> = {}): RecentTour => ({
    ref: { kind: 'github-pr', owner: 'o', repo: 'r', number },
    title: `#${number}`,
    updatedAt: '',
    ...extra,
  });
  const member = (number: number, state: 'open' | 'merged' | 'draft', extra: Partial<StackMember> = {}) => ({
    number,
    title: '',
    state,
    author: 'me',
    baseRef: 'b',
    headRef: 'h',
    ...extra,
  });
  const titles = (entries: ReturnType<typeof recentEntries>) =>
    entries.map((entry) => (entry.kind === 'tour' ? entry.tour.title : `stack ${entry.stack.members.length}`));

  test('splits the inbox by whose move it is, drafts apart, then other open tours', () => {
    const local: RecentTour = { ref: { kind: 'local', repo: '/r', target: 'HEAD' }, title: 'local', updatedAt: '' };
    const sections = railSections(
      {
        viewer: 'me',
        reviewRequested: [
          pr(1, { author: 'ana', activity: activity() }),
          pr(9, { author: 'ana', activity: activity() }),
        ],
        reviewed: [pr(11, { author: 'li', activity: activity({ reviewers: [{ login: 'me', state: 'approved' }] }) })],
        authored: [
          pr(2, {
            author: 'me',
            stack: {
              owner: 'o',
              repo: 'r',
              base: 'main',
              members: [
                member(2, 'open', { activity: activity({ reviewers: [{ login: 'ana', state: 'pending' }] }) }),
                member(3, 'open', { activity: activity({ checks: 'failing' }) }),
              ],
            },
          }),
          pr(12, { author: 'me', state: 'open', activity: activity({ reviewDecision: 'approved' }) }),
          pr(13, { author: 'me', state: 'draft', activity: activity() }),
        ],
        tours: [pr(3), pr(1), pr(4, { state: 'merged' }), pr(5, { state: 'open' }), local],
      },
      new Set(['github:o/r#9']),
    );
    expect([
      titles(sections.yourMove),
      titles(sections.waiting),
      titles(sections.drafts),
      titles(sections.recent),
    ]).toEqual([['#1', 'stack 2', '#12'], ['#11'], ['#13'], ['#5', 'local']]);
  });

  test('lists each section newest first, a stack by its newest PR', () => {
    const at = (day: number) => activity({ updatedAt: `2026-11-${day}T00:00:00Z` });
    const sections = railSections(
      {
        viewer: 'me',
        reviewRequested: [pr(1, { author: 'ana', activity: at(10) })],
        authored: [
          pr(2, { author: 'me', activity: at(12) }),
          pr(3, {
            author: 'me',
            stack: {
              owner: 'o',
              repo: 'r',
              base: 'main',
              members: [
                member(3, 'open', { activity: at(5) }),
                member(4, 'open', { activity: { ...at(20), checks: 'failing' } }),
              ],
            },
          }),
        ],
        tours: [
          pr(6, { state: 'open', updatedAt: '2026-11-01T00:00:00Z' }),
          pr(7, { state: 'open', updatedAt: '2026-11-02T00:00:00Z' }),
          pr(8, {
            updatedAt: '2026-11-03T00:00:00Z',
            stack: { owner: 'o', repo: 'r', base: 'main', members: [member(8, 'open'), member(9, 'open')] },
          }),
        ],
      },
      new Set(),
    );
    expect([titles(sections.yourMove), titles(sections.waiting), titles(sections.recent)]).toEqual([
      ['stack 2', '#1'],
      ['#2'],
      ['stack 2', '#7', '#6'],
    ]);
  });

  test("drops a stack once none of its PRs is open, and lists recent tours, the viewer's first, without GitHub's lists", () => {
    const merged = { owner: 'o', repo: 'r', base: 'main', members: [member(6, 'merged'), member(7, 'merged')] };
    const sections = railSections(
      { viewer: 'me', tours: [pr(6, { stack: merged }), pr(8, { author: 'ana' }), pr(10, { author: 'me' })] },
      new Set(),
    );
    expect([titles(sections.yourMove), titles(sections.waiting), titles(sections.recent)]).toEqual([
      [],
      [],
      ['#10', '#8'],
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
    expect(findEntry(sections, 'github:o/r#3')).toBe(sections.waiting[1]);
    expect(findEntry(sections, 'github:o/r#1')).toBe(sections.waiting[0]);
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
    expect(titles(sections.waiting)).toEqual(['stack github:o/r#3', '#5']);
    expect(home).toBe(sections.waiting[0]);
  });

  test.each([
    ['new to the rail', []],
    ['only in recent tours', [pr(6, { stack: stack(3, 4, 6) })]],
  ])("puts a PR %s in its stack's row", (_, tours) => {
    const recent = { reviewRequested: [pr(2)], authored: [pr(3, { stack: stack(3, 4) }), pr(5)], tours };
    const { sections, home } = railAround(recent, 'github:o/r#6', stack(3, 4, 6));
    expect(titles(sections.waiting)).toEqual(['#2', 'stack github:o/r#3', '#5']);
    expect(titles(sections.recent)).toEqual([]);
    expect(home).toBe(sections.waiting[1]);
  });

  test('shows a recorded stack that overlaps the live one as its own tour', () => {
    const recent = { tours: [pr(3, { stack: stack(2, 3) })] };
    const { sections, home } = railAround(recent, 'github:o/r#1', stack(1, 2));
    expect(titles(sections.recent)).toEqual(['#3']);
    expect(home).toBeUndefined();
  });
});
