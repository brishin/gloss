import { describe, expect, it } from 'vitest';
import { type AuthorsJson, githubPullAuthors, pullAuthorsQuery } from './github.ts';

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

describe('githubPullAuthors', () => {
  it('splits a batch GitHub refuses until only the missing PR is left out', async () => {
    const refs = [1, 2, 3, 4, 5].map((number) => ({ kind: 'github-pr' as const, owner: 'o', repo: 'r', number }));
    let calls = 0;
    const authors = await githubPullAuthors(refs, undefined, async (text) => {
      calls++;
      const numbers = [...text.matchAll(/number: (\d+)/g)].map((match) => Number(match[1]));
      if (numbers.includes(3)) {
        throw new Error('Could not resolve to a PullRequest');
      }
      return {
        data: Object.fromEntries(numbers.map((n, i) => [`p${i}`, { pullRequest: { author: { login: `u${n}` } } }])),
      } satisfies AuthorsJson;
    });
    expect([...authors]).toEqual([
      ['github:o/r#1', 'u1'],
      ['github:o/r#2', 'u2'],
      ['github:o/r#4', 'u4'],
      ['github:o/r#5', 'u5'],
    ]);
    expect(calls).toBe(5);
  });
});
