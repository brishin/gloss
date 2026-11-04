import type { PullState } from '@gloss/protocol';
import { describe, expect, test } from 'vitest';
import {
  isOpen,
  MAX_STACK,
  type StackLookup,
  type StackPull,
  walkStack,
  reviewDecisionOf,
  reviewersOf,
} from './github-stack.ts';
import { pullState } from './github.ts';

const pr = (
  number: number,
  baseRef: string,
  headRef: string,
  state: PullState = 'open',
  headInRepo = true,
): StackPull => ({ number, title: `PR ${number}`, state, baseRef, headRef, headInRepo });

/** A fake repo: `byHead` sees every state, `byBase` only open PRs, as the gh lookup does. */
function lookup(pulls: StackPull[]): StackLookup {
  return {
    trunk: async () => 'main',
    pull: async (number) => pulls.find((pull) => pull.number === number)!,
    byHead: async (branch) => pulls.filter((pull) => pull.headInRepo && pull.headRef === branch),
    byBase: async (branch) => pulls.filter((pull) => pull.baseRef === branch && isOpen(pull.state)),
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

  test('a PR promoting main into a release branch is not under PRs onto main', async () => {
    const promote = pr(1, 'release', 'main', 'merged', true);
    expect(await numbers(2, [promote, pr(2, 'main', 'feature')])).toEqual([2]);
    expect(await numbers(1, [promote, pr(2, 'main', 'feature')])).toEqual([1]);
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

  test('only the PR asked about keeps since, mergedBy, queuePosition and reviewers', async () => {
    const detail = {
      since: '2026-11-02T00:00:00Z',
      mergedBy: 'a',
      queuePosition: 2,
      reviewers: [{ login: 'r', state: 'approved' as const }],
    };
    const pulls = [
      { ...pr(1, 'main', 'a', 'merged'), ...detail },
      { ...pr(2, 'a', 'b'), ...detail },
    ];
    const [below, current] = await walkStack(2, lookup(pulls));
    expect(below).not.toHaveProperty('since');
    expect(current).toMatchObject(detail);
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

describe('reviewersOf', () => {
  const review = (login: string, state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING') => ({
    author: { login },
    state,
  });
  const user = (login: string) => ({ requestedReviewer: { login } });

  test('reviews first, then pending requests, teams by org/slug', () => {
    expect(
      reviewersOf(
        [review('a', 'CHANGES_REQUESTED'), review('b', 'APPROVED'), review('c', 'COMMENTED')],
        [user('d'), { requestedReviewer: { combinedSlug: 'org/web' } }],
      ),
    ).toEqual([
      { login: 'a', state: 'changes' },
      { login: 'b', state: 'approved' },
      { login: 'c', state: 'commented' },
      { login: 'd', state: 'pending' },
      { login: 'org/web', team: true, state: 'pending' },
    ]);
  });

  test('a re-requested reviewer is pending, once', () => {
    expect(reviewersOf([review('a', 'APPROVED')], [user('a')])).toEqual([{ login: 'a', state: 'pending' }]);
  });

  test('leaves out dismissed and draft reviews, the author, and requests with no reviewer', () => {
    expect(
      reviewersOf(
        [review('a', 'DISMISSED'), review('b', 'PENDING'), review('me', 'COMMENTED')],
        [{ requestedReviewer: null }],
        'me',
      ),
    ).toEqual([]);
  });
});

describe('pullState', () => {
  test.each([
    [{ open: true, merged: false }, 'open'],
    [{ open: true, merged: false, draft: true }, 'draft'],
    [{ open: true, merged: false, queued: true }, 'queued'],
    [{ open: true, merged: false, draft: true, queued: true }, 'queued'],
    [{ open: false, merged: true }, 'merged'],
    [{ open: false, merged: true, queued: true }, 'merged'],
    [{ open: false, merged: false }, 'closed'],
    [{ open: false, merged: false, draft: true }, 'closed'],
  ] as const)('%o is %s', (flags, state) => {
    expect(pullState(flags)).toBe(state);
  });

  test('a queued PR below is preferred over a merged one, like an open one', async () => {
    const pulls = [pr(1, 'main', 'a', 'queued'), pr(2, 'main', 'a', 'merged'), pr(3, 'a', 'b')];
    expect(await numbers(3, pulls)).toEqual([1, 3]);
  });
});

describe('reviewDecisionOf', () => {
  const approved = { login: 'a', state: 'approved' as const };
  const changes = { login: 'b', state: 'changes' as const };
  const pending = { login: 'c', state: 'pending' as const };

  test.each([
    ['GitHub approved', 'APPROVED', [], 'approved'],
    ['GitHub wants changes', 'CHANGES_REQUESTED', [approved], 'changes'],
    ['GitHub still requires review, whatever the reviews say', 'REVIEW_REQUIRED', [approved], undefined],
    ['no rules: a change request wins', null, [approved, changes], 'changes'],
    ['no rules: an approval', null, [approved, pending], 'approved'],
    ['no rules, no reviews', null, [pending], undefined],
  ] as const)('%s', (_, decision, reviewers, expected) => {
    expect(reviewDecisionOf(decision, reviewers)).toBe(expected);
  });
});
