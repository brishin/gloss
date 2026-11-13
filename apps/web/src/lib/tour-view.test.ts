import type { Decision, GroupView, LfsPointer, StackMember, TourState, Walkthrough } from '@gloss/protocol';
import { describe, expect, test } from 'vitest';
import {
  ago,
  decisionFlag,
  decisionsInOrder,
  defaultExpanded,
  evidenceFile,
  foldedChecks,
  hasWalkStop,
  lfsImageOids,
  lfsLabel,
  pathHome,
  pullStateDetail,
  sectionFlagCounts,
  shortPath,
  walkHomes,
} from './tour-view.ts';

const sha = (c: string) => c.repeat(64);
const lfs = (c: string, size: number) => ({ oid: sha(c), size });

const decision = (priority: Decision['priority'], extra: Partial<Decision> = {}): Decision => ({
  text: priority,
  priority,
  ...extra,
});

describe('decisionFlag', () => {
  test.each([
    ['urgent', 'severe'],
    ['high', 'investigate'],
    ['medium', 'investigate'],
    ['low', 'info'],
  ] as const)('%s reads as %s', (priority, level) => {
    expect(decisionFlag(decision(priority))).toBe(level);
  });
});

describe('sectionFlagCounts', () => {
  const group: GroupView = {
    key: 'auth',
    label: 'Auth',
    category: 'core',
    critical: true,
    fileIds: ['f1'],
    phase: 'resolved',
    synthetic: false,
    notes: {
      fileNotes: [{ fileId: 'f1', text: 'a' }],
      lineNotes: [
        { fileId: 'f1', hunkId: 'h1', side: 'additions', line: 3, text: 'b', critical: true },
        { fileId: 'f1', hunkId: 'h1', side: 'additions', line: 4, text: 'c' },
      ],
      riskNotes: [{ fileId: 'f1', risk: 'authCheck', text: 'd' }],
      decisions: [decision('medium', { fileId: 'f1' })],
    },
  };

  test('counts notes, risks, file decisions and section decisions by level', () => {
    const state = {
      decisions: [decision('urgent', { groupKey: 'auth' }), decision('low', { groupKey: 'other' }), decision('high')],
    } as TourState;
    expect(sectionFlagCounts(state, group)).toEqual({ severe: 2, warning: 1, investigate: 1, info: 2 });
  });

  test('a group without notes has no flags', () => {
    expect(sectionFlagCounts({} as TourState, { ...group, notes: undefined })).toEqual({
      severe: 0,
      warning: 0,
      investigate: 0,
      info: 0,
    });
  });
});

describe('description check', () => {
  test('folds medium and low gaps out of the decisions; high and urgent stay', () => {
    const check = (priority: Decision['priority']) => decision(priority, { source: 'description' });
    const state = { decisions: [check('low'), decision('medium'), check('high'), check('medium')] } as TourState;
    expect(decisionsInOrder(state, []).map((entry) => entry.decision)).toEqual([check('high'), decision('medium')]);
    expect(foldedChecks(state)).toEqual([check('medium'), check('low')]);
  });
});

describe('evidenceFile', () => {
  const files = [
    { id: 'f1', path: 'web/src/admin/SupportCompose.tsx' },
    { id: 'f2', path: 'server/support_threads.py' },
  ];
  test('finds the changed file a row names, by base name or path', () => {
    expect(evidenceFile(files, 'SupportCompose.tsx:118')).toEqual({ fileId: 'f1', label: 'SupportCompose.tsx:118' });
    expect(evidenceFile(files, 'server/support_threads.py:281, :367')).toEqual({
      fileId: 'f2',
      label: 'support_threads.py:281',
    });
  });
  test('leaves code the diff does not change unlinked', () => {
    expect(evidenceFile(files, 'RichTextEditor.tsx')).toBeUndefined();
    expect(evidenceFile(files, undefined)).toBeUndefined();
    expect(evidenceFile(files, 'Compose.tsx')).toBeUndefined();
  });
  test('prefers an exact path, and leaves a name two files share unlinked', () => {
    const twins = [
      { id: 'fx', path: 'fixtures/src/index.ts' },
      { id: 'f', path: 'src/index.ts' },
    ];
    expect(evidenceFile(twins, 'src/index.ts:20')?.fileId).toBe('f');
    expect(evidenceFile(twins, 'index.ts:20')).toBeUndefined();
  });
});

describe('pullStateDetail', () => {
  const now = Date.parse('2026-11-02T12:00:00Z');
  const pull = (fields: Partial<StackMember>): StackMember => ({
    number: 1,
    title: 't',
    state: 'open',
    baseRef: 'main',
    headRef: 'b',
    ...fields,
  });

  test.each([
    [{ since: '2026-11-02T11:59:30Z' }, 'opened just now'],
    [{ state: 'draft', since: '2026-10-31T12:00:00Z' }, 'opened 2 days ago'],
    [{ state: 'queued', queuePosition: 3, since: '2026-11-02T11:55:00Z' }, 'position 3, queued 5 minutes ago'],
    [{ state: 'merged', mergedBy: 'ann', since: '2026-11-02T09:00:00Z' }, 'by ann 3 hours ago'],
    [{ state: 'merged' }, ''],
    [{ state: 'closed', since: '2026-11-01T12:00:00Z' }, 'without merging yesterday'],
    [{}, ''],
  ] as const)('%o reads %s', (fields, text) => {
    expect(pullStateDetail(pull(fields), now)).toBe(text);
  });

  test('ago picks the largest whole unit', () => {
    expect(ago('2025-10-01T12:00:00Z', now)).toBe('last year');
    expect(ago('2026-11-02T12:00:00Z', now)).toBe('just now');
  });
});

describe('lfsLabel', () => {
  test.each([
    [{ new: lfs('a', 82070) }, 'Stored with Git LFS · 80.1 KB'],
    [{ old: lfs('a', 86536) }, 'Stored with Git LFS · 84.5 KB'],
    [{ old: lfs('a', 132063), new: lfs('b', 84765) }, 'Stored with Git LFS · 129.0 KB → 82.8 KB'],
    [{ old: lfs('a', 512), new: lfs('b', 512) }, 'Stored with Git LFS · 512 B'],
  ])('%o', (pointer, label) => {
    expect(lfsLabel(pointer)).toBe(label);
  });
});

describe('LFS images', () => {
  const file = (path: string, pointer?: LfsPointer) => ({
    id: path,
    path,
    status: 'modified' as const,
    additions: 3,
    deletions: 3,
    isBinary: false,
    truncated: false,
    hunkIds: [],
    lfs: pointer,
  });
  const pointer = { old: lfs('a', 1), new: lfs('b', 2) };

  test('an LFS image opens even when generated; other LFS files start collapsed', () => {
    expect(defaultExpanded(file('snap/home.png', pointer), true, false)).toBe(true);
    expect(defaultExpanded(file('snap/home.png', pointer), true, true)).toBe(false);
    expect(defaultExpanded(file('model.bin', pointer), false, false)).toBe(false);
    expect(defaultExpanded(file('home.png'), false, false)).toBe(true);
  });

  test('prefetches both sides of each LFS image, and nothing else', () => {
    expect(
      lfsImageOids([
        file('a.PNG', pointer),
        file('b.bin', pointer),
        file('c.svg', { new: lfs('c', 3) }),
        file('d.png'),
      ]),
    ).toEqual([sha('a'), sha('b'), sha('c')]);
  });
});

describe("the walkthrough read in the groups' walks", () => {
  const section = { points: [] };
  const none = { fileNotes: [], lineNotes: [], riskNotes: [] };
  const group = (key: string, fileIds: string[], walked: boolean) =>
    ({ key, fileIds, notes: walked ? { ...none, section } : none }) as unknown as GroupView;
  const at = (fileId: string) => ({ fileId, hunkId: 'h', from: 1, to: 20 });
  const walk = (decision: number, fileId?: string) => ({ decision, snippets: fileId ? [at(fileId)] : [] });
  const tour = (walkthrough: unknown, notes: string) =>
    ({ walkthrough, stages: { notes: { state: notes } } }) as unknown as Pick<TourState, 'walkthrough' | 'stages'>;
  const steps = [{ excerpts: [at('f1'), at('f3')] }, { excerpts: [at('f3')] }];

  test('a decision is read in the group that holds its first snippet, once that group has a walk', () => {
    const walkthrough = { decisions: [walk(0, 'f1'), walk(2, 'f3'), walk(3)], frames: [], steps: [] };
    const groups = [group('a', ['f1', 'f2'], true), group('b', ['f3'], false)];
    expect([...walkHomes(tour(walkthrough, 'done'), groups)]).toEqual([[0, 'a']]);
  });

  test('the code path is read in the group with a walk that holds most of its excerpts', () => {
    const walkthrough = { decisions: [], frames: [], steps };
    expect(pathHome(tour(walkthrough, 'done'), [group('a', ['f1'], true), group('b', ['f3'], true)])).toBe('b');
    expect(pathHome(tour(walkthrough, 'done'), [group('a', ['f1'], true), group('b', ['f3'], false)])).toBe('a');
    expect(pathHome(tour(walkthrough, 'done'), [group('a', ['f1'], false)])).toBeUndefined();
    expect(shortPath(walkthrough as never as Pick<Walkthrough, 'frames' | 'steps'>).steps[1]!.excerpts).toEqual([
      { ...at('f3'), to: 8 },
    ]);
  });

  test.each([
    // While the walks are written, nothing is a stop of its own: each decision moves into its group.
    ['running', [true, true], [walk(0, 'f1')], [], false],
    ['done', [true, true], [walk(0, 'f1'), walk(1, 'f3')], steps, false],
    // A group whose walk failed leaves its decision to the walkthrough stop.
    ['done', [true, false], [walk(0, 'f1'), walk(1, 'f3')], [], true],
    // A tour from before walks existed keeps the whole walkthrough.
    ['done', [false, false], [walk(0, 'f1')], [], true],
    ['done', [false, false], [], steps, true],
    ['failed', [false, false], [walk(0, 'f1')], [], true],
  ] as const)('notes %s, walks %j: a walkthrough stop', (notes, [a, b], decisions, path, expected) => {
    const groups = [group('a', ['f1'], a), group('b', ['f3'], b)];
    expect(hasWalkStop(tour({ decisions, frames: [], steps: path }, notes), groups)).toBe(expected);
  });

  test('no walkthrough, no stop', () => {
    expect(hasWalkStop(tour(undefined, 'done'), [])).toBe(false);
  });
});
