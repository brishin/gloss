import type { PullState } from '@gloss/protocol';
import { describe, expect, test } from 'vitest';
import { MAX_STACK, type StackLookup, type StackPull, walkStack } from './github-stack.ts';

const pr = (
  number: number,
  baseRef: string,
  headRef: string,
  state: PullState = 'open',
  headInRepo = true,
): StackPull => ({ number, title: `PR ${number}`, state, baseRef, headRef, headInRepo });

/** A fake repo: `byHead` sees every state, `byBase` only open and draft PRs, as the gh lookup does. */
function lookup(pulls: StackPull[]): StackLookup {
  return {
    pull: async (number) => pulls.find((pull) => pull.number === number)!,
    byHead: async (branch) => pulls.filter((pull) => pull.headInRepo && pull.headRef === branch),
    byBase: async (branch) =>
      pulls.filter((pull) => pull.baseRef === branch && (pull.state === 'open' || pull.state === 'draft')),
  };
}

const numbers = async (start: number, pulls: StackPull[]) =>
  (await walkStack(start, lookup(pulls))).map((pull) => pull.number);

describe('walkStack', () => {
  const chain = [pr(1, 'main', 'a'), pr(2, 'a', 'b'), pr(3, 'b', 'c', 'draft')];

  test.each([
    ['from the bottom', 1],
    ['from the middle', 2],
    ['from the top', 3],
  ])('finds the whole chain %s', async (_, start) => {
    expect(await numbers(start, chain)).toEqual([1, 2, 3]);
  });

  test('a PR with no neighbours is a stack of one', async () => {
    expect(await numbers(5, [pr(5, 'main', 'solo'), ...chain])).toEqual([5]);
  });

  test('below, an open PR beats a merged one on the same branch', async () => {
    expect(await numbers(2, [pr(1, 'main', 'a', 'merged'), pr(4, 'main', 'a'), pr(2, 'a', 'b')])).toEqual([4, 2]);
  });

  test('below, keeps a merged PR when it is the only one', async () => {
    expect(await numbers(2, [pr(1, 'main', 'a', 'merged'), pr(2, 'a', 'b')])).toEqual([1, 2]);
  });

  test('above, skips closed PRs and takes the oldest open one when the stack forks', async () => {
    expect(await numbers(1, [pr(1, 'main', 'a'), pr(3, 'a', 'c'), pr(2, 'a', 'b'), pr(4, 'a', 'd', 'closed')])).toEqual(
      [1, 2],
    );
  });

  test('a fork PR from its main is not the base of PRs onto main here', async () => {
    expect(await numbers(5, [pr(5, 'main', 'main', 'open', false), pr(6, 'main', 'other')])).toEqual([5]);
  });

  test('members carry no walk-only fields', async () => {
    expect(Object.keys((await walkStack(1, lookup(chain)))[0]!).toSorted()).toEqual([
      'baseRef',
      'headRef',
      'number',
      'state',
      'title',
    ]);
  });

  test('stops on a cycle', async () => {
    expect(await numbers(1, [pr(1, 'b', 'a'), pr(2, 'a', 'b')])).toEqual([2, 1]);
  });

  test(`stops at ${MAX_STACK} members`, async () => {
    const long = Array.from({ length: 20 }, (_, i) => pr(i + 1, i === 0 ? 'main' : `b${i}`, `b${i + 1}`));
    const members = await numbers(1, long);
    expect(members).toHaveLength(MAX_STACK);
    expect(members[0]).toBe(1);
  });
});
