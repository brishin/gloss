import { describe, expect, it } from 'vitest';
import { parseRules } from './rules.ts';

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
