import { describe, expect, it } from 'vitest';
import { githubPulls, inboxTours, type PullsJson, pullsQuery } from './github.ts';

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

describe('inboxTours', () => {
  const node = (number: number, base: string, head: string, repo = 'r') => ({
    number,
    title: `#${number}`,
    state: 'OPEN' as const,
    isDraft: number === 3,
    isInMergeQueue: false,
    updatedAt: '2026-11-02T00:00:00Z',
    author: { login: 'me' },
    baseRefName: base,
    headRefName: head,
    repository: { owner: { login: 'o' }, name: repo },
  });

  it('chains PRs on each other into one stack, bottom first, and leaves the rest alone', () => {
    const tours = inboxTours([
      node(3, 'b', 'c'),
      node(9, 'main', 'x'),
      node(1, 'main', 'a'),
      node(2, 'a', 'b'),
      node(4, 'a', 'b', 'other'),
    ]);
    expect(tours.map((tour) => [tour.title, tour.state, tour.stack?.members.map((m) => m.number)])).toEqual([
      ['#3', 'draft', [1, 2, 3]],
      ['#9', 'open', undefined],
      ['#1', 'open', [1, 2, 3]],
      ['#2', 'open', [1, 2, 3]],
      ['#4', 'open', undefined],
    ]);
    expect(tours[0]!.stack?.base).toBe('main');
  });

  it('stops at a cycle of branches', () => {
    expect(inboxTours([node(1, 'b', 'a'), node(2, 'a', 'b')]).map((tour) => tour.stack?.members.length)).toEqual([
      2, 2,
    ]);
  });
});
