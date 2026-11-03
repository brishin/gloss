import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { DecisionRuleSetsSchema, parseRules, rulesFor } from './rules.ts';

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
    { files: '\\.py$', rules: ['Python only', 'Everywhere'] },
    { files: '^apps/web/', rules: ['Web only'] },
    { files: '(', rules: ['Broken pattern'] },
  ];
  it.each([
    ['no files: only unscoped rules', [], ['Everywhere']],
    ['a match in any path applies the set', ['README.md', 'api/views.py'], ['Everywhere', 'Python only']],
    ['matched against the whole path', ['apps/web/src/x.tsx'], ['Everywhere', 'Web only']],
    ['no match', ['apps/api/web.ts'], ['Everywhere']],
  ])('%s', (_, paths, rules) => {
    expect(rulesFor(sets, paths)).toEqual(rules);
  });
});

describe('DecisionRuleSetsSchema', () => {
  it('refuses a pattern that does not compile, an empty set and too many rules', () => {
    expect(v.is(DecisionRuleSetsSchema, [{ files: '\\.py$', rules: ['A'] }])).toBe(true);
    expect(v.is(DecisionRuleSetsSchema, [{ files: '(', rules: ['A'] }])).toBe(false);
    expect(v.is(DecisionRuleSetsSchema, [{ rules: [] }])).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => `Flag ${i}`);
    expect(v.is(DecisionRuleSetsSchema, [{ rules: many.slice(0, 11) }, { rules: many.slice(11) }])).toBe(false);
  });
});
