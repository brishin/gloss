import type { Decision, GroupView, StackMember, TourState } from '@gloss/protocol';
import { describe, expect, test } from 'vitest';
import { ago, decisionFlag, lfsLabel, pullStateDetail, sectionFlagCounts } from './tour-view.ts';

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
    [{ newSize: 82070 }, 'Stored with Git LFS · 80.1 KB'],
    [{ oldSize: 86536 }, 'Stored with Git LFS · 84.5 KB'],
    [{ oldSize: 132063, newSize: 84765 }, 'Stored with Git LFS · 129.0 KB → 82.8 KB'],
    [{ oldSize: 512, newSize: 512 }, 'Stored with Git LFS · 512 B'],
    [{}, 'Stored with Git LFS'],
  ])('%o', (sizes, label) => {
    expect(lfsLabel(sizes)).toBe(label);
  });
});
