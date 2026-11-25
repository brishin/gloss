import type { PullActivity } from '@gloss/protocol';
import { describe, expect, test } from 'vitest';
import { ageOf, bestStand, compactCount, type PullFacts, standOf } from './dashboard.ts';

const activity = (extra: Partial<PullActivity> = {}): PullActivity => ({
  additions: 1,
  deletions: 1,
  updatedAt: '2026-11-24T00:00:00Z',
  reviewers: [],
  openThreads: 0,
  comments: { people: 0, bots: 0 },
  ...extra,
});

describe('standOf', () => {
  const mine = (extra: Partial<PullActivity>, state: PullFacts['state'] = 'open'): PullFacts => ({
    author: 'me',
    state,
    activity: activity(extra),
    requested: false,
  });
  const theirs = (extra: Partial<PullActivity>, requested = false): PullFacts => ({
    author: 'ana',
    state: 'open',
    activity: activity(extra),
    requested,
  });

  test.each<[string, PullFacts, [string, string, string | undefined]]>([
    ['a review asked of me', theirs({}, true), ['mine', 'Review requested', 'Review']],
    [
      'a push after my review',
      theirs({ viewerReviewedAt: '2026-11-20T00:00:00Z', pushedSinceReview: true }),
      ['mine', 'Pushed since your review', 'New push'],
    ],
    [
      'my approval with no push since',
      theirs({
        viewerReviewedAt: '2026-11-21T00:00:00Z',
        reviewers: [{ login: 'me', state: 'approved' }],
      }),
      ['theirs', 'You approved', undefined],
    ],
    [
      'failing checks first, with threads',
      mine({ checks: 'failing', openThreads: 2, reviewDecision: 'approved' }),
      ['mine', 'Checks failing · 2 open threads', 'Checks failing'],
    ],
    ['changes asked', mine({ reviewDecision: 'changes', openThreads: 1 }), ['mine', 'Changes requested', 'Changes']],
    ['open threads', mine({ openThreads: 1 }), ['mine', '1 open thread', '1 thread']],
    [
      'an approval with checks running',
      mine({ reviewDecision: 'approved', checks: 'pending' }),
      ['theirs', 'Approved · checks running', undefined],
    ],
    ['an approval', mine({ reviewDecision: 'approved' }), ['mine', 'Ready to merge', 'Approved']],
    ['the merge queue', mine({ reviewDecision: 'approved' }, 'queued'), ['theirs', 'In the merge queue', undefined]],
    [
      'reviewers asked',
      mine({ reviewers: [{ login: 'ana', state: 'pending' }] }),
      ['theirs', 'Waiting on review', undefined],
    ],
    ['nobody asked', mine({}), ['theirs', 'No reviewer requested', undefined]],
    ['a draft', mine({ checks: 'failing' }, 'draft'), ['draft', 'Draft', undefined]],
  ])('%s', (_, facts, [move, reason, short]) => {
    const stand = standOf(facts, 'me');
    expect([stand.move, stand.reason, stand.short]).toEqual([move, reason, short]);
  });

  test('knows nothing without inbox data, or once a PR is merged', () => {
    expect(standOf({ author: 'me', state: 'open', requested: false }, 'me').move).toBe('unknown');
    expect(standOf({ ...mine({ checks: 'failing' }), state: 'merged' }, 'me').move).toBe('unknown');
  });

  test('ranks others waiting on me above my own PRs', () => {
    const review = standOf(theirs({}, true), 'me');
    const failing = standOf(mine({ checks: 'failing' }), 'me');
    expect(bestStand([failing, review])).toBe(review);
  });
});

test('compactCount and ageOf', () => {
  expect([compactCount(999), compactCount(1000), compactCount(1650)]).toEqual(['999', '1k', '1.6k']);
  const now = Date.parse('2026-11-25T00:00:00Z');
  expect(
    ['2026-11-24T23:55:00Z', '2026-11-24T21:00:00Z', '2026-11-21T00:00:00Z', '2026-08-01T00:00:00Z'].map((iso) =>
      ageOf(iso, now),
    ),
  ).toEqual(['5m', '3h', '4d', '4mo']);
});
