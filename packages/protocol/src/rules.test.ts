import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { DecisionRuleSetsSchema, parseRules, rowsFromSets, rulesFor, setsFromRows } from './rules.ts';

describe('parseRules', () => {
  it.each([
    ['one rule per line', 'Flag A\nFlag B', ['Flag A', 'Flag B']],
    [
      'list markers dropped',
      '- Flag A\n* Flag B\n• Flag C\n1. Flag D\n2) Flag E',
      ['Flag A', 'Flag B', 'Flag C', 'Flag D', 'Flag E'],
    ],
    ['blank lines and repeats left out', '\n- Flag A\n\n  flag a  \r\nFlag   B\n', ['Flag A', 'Flag B']],
    ['a dash inside a rule kept', 'Flag a re-try count', ['Flag a re-try count']],
    ['nothing', '  \n- \n', []],
  ])('%s', (_, text, rules) => {
    expect(parseRules(text)).toEqual(rules);
  });
});

describe('rulesFor', () => {
  const sets = [
    { rules: ['Everywhere'] },
    { files: '*.py', rules: ['Python only', 'Everywhere'] },
    { files: 'apps/web/**', rules: ['Web only'] },
    { files: '[z-a]', rules: ['Broken glob'] },
  ];
  it.each([
    ['no files: only unscoped rules', [], ['Everywhere']],
    [
      'a set matching some paths names them',
      ['README.md', 'api/views.py'],
      ['Everywhere', 'Python only (only in api/views.py)'],
    ],
    ['a set matching every path needs no scope', ['api/views.py'], ['Everywhere', 'Python only']],
    ['a glob with a slash anchored at the root', ['apps/web/src/x.tsx'], ['Everywhere', 'Web only']],
    ['no match', ['lib/apps/web/x.ts'], ['Everywhere']],
  ])('%s', (_, paths, rules) => {
    expect(rulesFor(sets, paths)).toEqual(rules);
  });

  it('counts the matching paths past six', () => {
    const paths = ['README.md', ...Array.from({ length: 8 }, (_, i) => `m${i}.py`)];
    expect(rulesFor([{ files: '*.py', rules: ['Python only'] }], paths)).toEqual([
      'Python only (only in m0.py, m1.py, m2.py, m3.py, m4.py, m5.py and 2 more files matching *.py)',
    ]);
  });
});

describe('DecisionRuleSetsSchema', () => {
  it('refuses a long files glob, an empty set and too many rules', () => {
    expect(v.is(DecisionRuleSetsSchema, [{ files: '*.py', rules: ['A'] }])).toBe(true);
    expect(v.is(DecisionRuleSetsSchema, [{ files: 'x'.repeat(401), rules: ['A'] }])).toBe(false);
    expect(v.is(DecisionRuleSetsSchema, [{ rules: [] }])).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => `Flag ${i}`);
    expect(v.is(DecisionRuleSetsSchema, [{ rules: many.slice(0, 11) }, { rules: many.slice(11) }])).toBe(false);
  });
});

describe('rule rows', () => {
  it('save as sets by pattern, in first-seen order, and read back as the same rows', () => {
    const rows = [
      { text: 'A' },
      { text: 'B', files: '*.py' },
      { text: ' ' },
      { text: 'C', files: '  ' },
      { text: 'A' },
      { text: 'D', files: '*.py' },
    ];
    const { sets, refs } = setsFromRows(rows);
    expect(sets).toEqual([{ rules: ['A', 'C'] }, { files: '*.py', rules: ['B', 'D'] }]);
    expect(refs).toEqual([
      { set: 0, rule: 0 },
      { set: 1, rule: 0 },
      undefined,
      { set: 0, rule: 1 },
      undefined,
      { set: 1, rule: 1 },
    ]);
    expect(rowsFromSets(sets)).toEqual([
      { text: 'A' },
      { text: 'C' },
      { text: 'B', files: '*.py' },
      { text: 'D', files: '*.py' },
    ]);
  });
});
