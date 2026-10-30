import type { Decision, GroupView, TourState } from '@gloss/protocol';
import { describe, expect, test } from 'vitest';
import { decisionFlag, sectionFlagCounts } from './tour-view.ts';

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
