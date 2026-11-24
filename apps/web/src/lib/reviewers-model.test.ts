import type { StackMember } from '@gloss/protocol';
import { describe, expect, test } from 'vitest';
import { emptyReviewers, pickerRows, updateReviewers } from './reviewers-model.ts';

const ref = { owner: 'o', repo: 'r', number: 7 };
const pull: StackMember = {
  number: 7,
  title: 't',
  state: 'open',
  author: 'me',
  baseRef: 'main',
  headRef: 'x',
  reviewers: [{ login: 'octocat', state: 'commented' }],
  suggestedReviewers: [
    { login: 'defunkt', why: 'wrote' },
    { login: 'mojombo', why: 'reviewed' },
  ],
};

describe('updateReviewers', () => {
  test('an ask shows as pending at once and leaves the suggestions', () => {
    const next = updateReviewers(emptyReviewers, { type: 'ReviewerAdded', who: { login: 'defunkt' } }, ref, pull);
    expect(next.pull?.reviewers).toEqual([
      { login: 'octocat', state: 'commented' },
      { login: 'defunkt', state: 'pending' },
    ]);
    expect(next.pull?.suggestedReviewers).toEqual([{ login: 'mojombo', why: 'reviewed' }]);
    expect(next.cmds).toEqual([{ type: 'ChangeReviewers', ref, add: [{ login: 'defunkt' }] }]);
  });

  test('asking someone already reviewing sends nothing', () => {
    const next = updateReviewers(emptyReviewers, { type: 'ReviewerAdded', who: { login: 'octocat' } }, ref, pull);
    expect(next.cmds).toEqual([]);
    expect(next.pull).toBeUndefined();
  });

  test("GitHub's answer replaces both lists; a refusal keeps the error and fetches the PR again", () => {
    const result = { reviewers: [{ login: 'hubot', state: 'pending' as const }], suggestedReviewers: [] };
    expect(updateReviewers(emptyReviewers, { type: 'ReviewersChanged', result }, ref, pull).pull).toMatchObject(result);
    const failed = updateReviewers(emptyReviewers, { type: 'ReviewersFailed', error: 'no access' }, ref, pull);
    expect(failed.state.error).toBe('no access');
    expect(failed.refetch).toBe(true);
  });

  test('an answer for an older query is dropped', () => {
    const typed = updateReviewers(emptyReviewers, { type: 'ReviewerQueryChanged', query: 'moj' }, ref, pull);
    expect(typed.cmds).toEqual([{ type: 'SearchReviewers', ref, query: 'moj' }]);
    const stale = updateReviewers(typed.state, { type: 'ReviewersFound', query: 'mo', candidates: [] }, ref, pull);
    expect(stale.state.found).toBeUndefined();
  });
});

describe('serialized changes', () => {
  test('a pick while one is on its way waits, and only the last answer reaches the screen', () => {
    const first = updateReviewers(emptyReviewers, { type: 'ReviewerAdded', who: { login: 'defunkt' } }, ref, pull);
    const second = updateReviewers(first.state, { type: 'ReviewerAdded', who: { login: 'mojombo' } }, ref, first.pull);
    expect(second.cmds).toEqual([]);
    expect(second.pull?.reviewers?.map((one) => one.login)).toEqual(['octocat', 'defunkt', 'mojombo']);
    const early = { reviewers: [{ login: 'defunkt', state: 'pending' as const }], suggestedReviewers: [] };
    const answered = updateReviewers(second.state, { type: 'ReviewersChanged', result: early }, ref, second.pull);
    expect(answered.pull).toBeUndefined();
    expect(answered.cmds).toEqual([{ type: 'ChangeReviewers', ref, add: [{ login: 'mojombo' }] }]);
    const last = {
      reviewers: [
        { login: 'defunkt', state: 'pending' as const },
        { login: 'mojombo', state: 'pending' as const },
      ],
      suggestedReviewers: [],
    };
    const done = updateReviewers(answered.state, { type: 'ReviewersChanged', result: last }, ref, second.pull);
    expect(done.pull?.reviewers).toEqual(last.reviewers);
    expect(done.state.sending).toBe(false);
  });
});

describe('pickerRows', () => {
  test('matches for an earlier query are not offered', () => {
    const state = { ...emptyReviewers, query: 'bob', found: { query: 'alice', candidates: [{ login: 'alice' }] } };
    expect(pickerRows(pull, state).found).toEqual([]);
  });

  test('suggestions first, then matches not already shown, reviewing or the author', () => {
    const state = {
      ...emptyReviewers,
      query: 'mo',
      found: { query: 'mo', candidates: [{ login: 'mojombo' }, { login: 'mojodna' }, { login: 'me' }] },
    };
    expect(pickerRows(pull, state)).toEqual({
      suggested: [{ login: 'mojombo', why: 'reviewed' }],
      found: [{ login: 'mojodna' }],
    });
  });
});
