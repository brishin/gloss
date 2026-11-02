import { describe, expect, it } from 'vitest';
import { pullAuthorsQuery } from './github.ts';

describe('pullAuthorsQuery', () => {
  it('asks for every PR in one query, aliased by position, with names quoted', () => {
    const query = pullAuthorsQuery([
      { kind: 'github-pr', owner: 'o', repo: 'r', number: 1 },
      { kind: 'github-pr', owner: 'a"b', repo: 'r.js', number: 22 },
    ]);
    expect(query).toBe(
      'query { p0: repository(owner: "o", name: "r") { pullRequest(number: 1) { author { login } } } ' +
        'p1: repository(owner: "a\\"b", name: "r.js") { pullRequest(number: 22) { author { login } } } }',
    );
  });
});
