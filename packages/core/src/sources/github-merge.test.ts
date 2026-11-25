import type { MergeRequest, PullMerge } from '@gloss/protocol';
import { describe, expect, test } from 'vitest';
import { mergeCall } from './github-merge.ts';

const merge = (patch: Partial<PullMerge> = {}): PullMerge => ({
  id: 'PR_1',
  headOid: 'abc',
  status: 'clean',
  checks: { passed: 3, failed: 0, pending: 0, failing: [] },
  method: 'squash',
  queue: false,
  canAuto: true,
  canBypass: false,
  ...patch,
});
const ask = (action: MergeRequest['action'], patch: Partial<MergeRequest> = {}): MergeRequest => ({
  owner: 'o',
  repo: 'r',
  number: 1,
  action,
  headOid: 'abc',
  ...patch,
});
const mutation = (call: { query: string }) => /\{\s*(\w+)\(/.exec(call.query)?.[1];

describe('mergeCall', () => {
  test.each([
    // [action, status, queue, mutation]
    ['ready', 'clean', false, 'mergePullRequest'],
    ['ready', 'unstable', false, 'mergePullRequest'],
    ['ready', 'blocked', false, 'enablePullRequestAutoMerge'],
    ['ready', 'behind', false, 'enablePullRequestAutoMerge'],
    ['ready', 'clean', true, 'enqueuePullRequest'],
    ['ready', 'blocked', true, 'enablePullRequestAutoMerge'],
    ['now', 'blocked', false, 'mergePullRequest'],
    ['now', 'blocked', true, 'enqueuePullRequest'],
    ['cancel', 'blocked', false, 'disablePullRequestAutoMerge'],
    ['dequeue', 'clean', true, 'dequeuePullRequest'],
  ] as const)('%s on a %s PR (queue: %s) sends %s', (action, status, queue, expected) => {
    expect(mutation(mergeCall(ask(action), merge({ status, queue })))).toBe(expected);
  });

  test('sends the default method, and the head the reader saw', () => {
    expect(mergeCall(ask('ready'), merge()).vars).toEqual({ id: 'PR_1', method: 'SQUASH', head: 'abc' });
  });

  test('a queue gets no method, and the seen head guards every merge', () => {
    expect(mergeCall(ask('ready'), merge({ queue: true })).vars).toEqual({ id: 'PR_1', head: 'abc' });
  });
});
