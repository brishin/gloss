import type { PullMerge, StackMember } from '@gloss/protocol';
import { describe, expect, test } from 'vitest';
import { aboutTime, emptyMerge, mergeView, updateMerge } from './merge-model.ts';

const merge = (patch: Partial<PullMerge> = {}): PullMerge => ({
  id: 'PR_1',
  headOid: 'abc',
  status: 'clean',
  checks: { passed: 14, failed: 0, pending: 0, failing: [] },
  methods: ['squash', 'merge', 'rebase'],
  queue: false,
  canAuto: true,
  canBypass: false,
  ...patch,
});
const pull = (patch: Partial<PullMerge> = {}, more: Partial<StackMember> = {}): StackMember => ({
  number: 99,
  title: 'T',
  state: 'open',
  baseRef: 'main',
  headRef: 'x',
  reviewDecision: 'approved',
  reviewers: [{ login: 'octocat', state: 'approved' }],
  merge: merge(patch),
  ...more,
});
const ref = { owner: 'o', repo: 'r', number: 99 };
const buttons = (view: ReturnType<typeof mergeView>) =>
  view.buttons.map((button) => `${button.action}:${button.label}`);

describe('mergeView', () => {
  test.each([
    // [what, merge, more, buttons, methods]
    ['a clean PR merges now with the usual method', {}, {}, ['ready:Squash and merge'], true],
    ['failing optional checks still merge', { status: 'unstable' }, {}, ['ready:Squash and merge'], true],
    ['a blocked PR merges once ready', { status: 'blocked' }, {}, ['ready:Merge when ready'], true],
    [
      'an admin may also merge past the rules',
      { status: 'blocked', canBypass: true },
      {},
      ['now:Bypass and merge', 'ready:Merge when ready'],
      true,
    ],
    ['conflicts leave nothing to press', { status: 'conflicts' }, {}, [], false],
    ['a queued base joins the queue', { queue: true, queueSize: 3 }, {}, ['ready:Add to queue'], false],
    [
      'a blocked PR joins the queue once ready',
      { queue: true, status: 'blocked' },
      {},
      ['ready:Add when ready'],
      false,
    ],
    [
      'a queued PR can leave',
      { queue: true },
      { state: 'queued', queuePosition: 2 },
      ['dequeue:Remove from queue'],
      false,
    ],
    ['auto-merge on can be cancelled', { status: 'blocked', auto: true }, {}, ['cancel:Cancel auto-merge'], false],
    ['one allowed method has nothing to pick', { methods: ['squash'] }, {}, ['ready:Squash and merge'], false],
  ] as const)('%s', (_, patch, more, expected, methods) => {
    const view = mergeView(pull(patch as Partial<PullMerge>, more as Partial<StackMember>), emptyMerge);
    expect(buttons(view)).toEqual(expected);
    expect(view.methods).toBe(methods);
  });

  test('says what is left: failing checks by name, the review, the base', () => {
    const view = mergeView(
      pull(
        { status: 'blocked', checks: { passed: 12, failed: 2, pending: 0, failing: ['e2e', 'lint', 'types'] } },
        { reviewDecision: undefined, reviewers: [] },
      ),
      emptyMerge,
    );
    expect(view.rows).toEqual([
      { tone: 'bad', text: '2 of 14 checks failed', detail: 'e2e, lint' },
      { tone: 'ok', text: 'No conflicts with main' },
    ]);
  });

  test('a review is the wait when checks are green', () => {
    const view = mergeView(pull({ status: 'blocked' }, { reviewDecision: undefined, reviewers: [] }), emptyMerge);
    expect(view.rows.map((row) => row.text)).toContain('Waiting on a required review');
  });

  test('the queue line: size and estimate before, place once queued', () => {
    expect(mergeView(pull({ queue: true, queueSize: 3, queueEta: 840 }), emptyMerge).rows.at(-1)).toEqual({
      tone: 'info',
      text: '3 PRs in the main queue',
      end: 'about 14 min',
    });
    expect(
      mergeView(
        pull({ queue: true, queueSize: 4, queueEta: 540 }, { state: 'queued', queuePosition: 2 }),
        emptyMerge,
      ).rows.at(-1)?.text,
    ).toBe('2nd of 4 in the main queue');
  });

  test('the picked method names the button', () => {
    expect(buttons(mergeView(pull(), { ...emptyMerge, method: 'rebase' }))).toEqual(['ready:Rebase and merge']);
  });
});

describe('updateMerge', () => {
  test('opening reads the PR again, once', () => {
    expect(updateMerge(emptyMerge, { type: 'MergeOpened' }, ref, pull(), 'abc').refetch).toBe(true);
    expect(updateMerge({ ...emptyMerge, open: true }, { type: 'MergeOpened' }, ref, pull(), 'abc').refetch).toBe(false);
  });

  test('a merge sends the picked method and the head the tour read', () => {
    const next = updateMerge(
      { ...emptyMerge, method: 'merge' },
      { type: 'MergeClicked', action: 'ready' },
      ref,
      pull(),
      'seen',
    );
    expect(next.cmds).toEqual([{ type: 'MergePull', ref, action: 'ready', method: 'merge', headOid: 'seen' }]);
    expect(next.state.sending).toBe('ready');
    // A second press while one is on its way sends nothing.
    expect(updateMerge(next.state, { type: 'MergeClicked', action: 'ready' }, ref, pull(), 'seen').cmds).toEqual([]);
  });

  test('a refusal keeps the panel open with the reason and reads the PR again', () => {
    const next = updateMerge(
      { ...emptyMerge, sending: 'ready' },
      { type: 'MergeFailed', error: 'Head moved' },
      ref,
      pull(),
      'abc',
    );
    expect(next.state).toMatchObject({ open: true, error: 'Head moved', sending: undefined });
    expect(next.refetch).toBe(true);
  });

  test('a merged PR closes the panel and replaces the PR', () => {
    const merged = { ...pull(), state: 'merged' as const, merge: undefined };
    const next = updateMerge({ open: true, sending: 'ready' }, { type: 'MergeDone', pull: merged }, ref, pull(), 'abc');
    expect(next.state.open).toBe(false);
    expect(next.pull).toBe(merged);
  });
});

test('aboutTime', () => {
  expect([aboutTime(20), aboutTime(540), aboutTime(7200)]).toEqual(['under a minute', 'about 9 min', 'about 2 h']);
});
