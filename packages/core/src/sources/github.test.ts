import { describe, expect, it } from 'vitest';
import { githubPulls, type PullsJson, pullsQuery } from './github.ts';

describe('pullsQuery', () => {
  it('asks for every PR in one query, aliased by position, with names quoted', () => {
    const query = pullsQuery([
      { kind: 'github-pr', owner: 'o', repo: 'r', number: 1 },
      { kind: 'github-pr', owner: 'a"b', repo: 'r.js', number: 22 },
    ]);
    expect(query).toBe(
      'query { p0: repository(owner: "o", name: "r") { pullRequest(number: 1) { author { login } state isDraft isInMergeQueue } } ' +
        'p1: repository(owner: "a\\"b", name: "r.js") { pullRequest(number: 22) { author { login } state isDraft isInMergeQueue } } }',
    );
  });
});

describe('githubPulls', () => {
  it('splits a batch GitHub refuses until only the missing PR is left out', async () => {
    const refs = [1, 2, 3, 4, 5].map((number) => ({ kind: 'github-pr' as const, owner: 'o', repo: 'r', number }));
    let calls = 0;
    const pulls = await githubPulls(refs, undefined, async (text) => {
      calls++;
      const numbers = [...text.matchAll(/number: (\d+)/g)].map((match) => Number(match[1]));
      if (numbers.includes(3)) {
        throw new Error('Could not resolve to a PullRequest');
      }
      return {
        data: Object.fromEntries(
          numbers.map((n, i) => [
            `p${i}`,
            {
              pullRequest: {
                author: { login: `u${n}` },
                state: n === 5 ? 'MERGED' : 'OPEN',
                isDraft: n === 2,
                isInMergeQueue: n === 4,
              },
            },
          ]),
        ),
      } satisfies PullsJson;
    });
    expect([...pulls]).toEqual([
      ['github:o/r#1', { author: 'u1', state: 'open' }],
      ['github:o/r#2', { author: 'u2', state: 'draft' }],
      ['github:o/r#4', { author: 'u4', state: 'queued' }],
      ['github:o/r#5', { author: 'u5', state: 'merged' }],
    ]);
    expect(calls).toBe(5);
  });
});
