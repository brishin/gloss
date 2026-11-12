import type { FileChange, ReviewThread } from '@gloss/protocol';
import { describe, expect, test } from 'vitest';
import { emptyThreads, isFolded, placeThreads, type ThreadsModel, updateThreads } from './threads-model.ts';

const REF = { kind: 'github-pr', owner: 'o', repo: 'r', number: 1 } as const;
const comment = { id: 'c1', author: 'octocat', body: 'Why?', createdAt: '2026-11-10T00:00:00Z', url: 'u' };
const thread = (id: string, patch: Partial<ReviewThread> = {}): ReviewThread => ({
  id,
  path: 'a.ts',
  side: 'additions',
  line: 3,
  resolved: false,
  outdated: false,
  comments: [comment],
  ...patch,
});
const loaded: ThreadsModel = { ...emptyThreads, list: [thread('t1'), thread('t2', { resolved: true })] };

describe('updateThreads', () => {
  test('resolved and outdated threads start folded; a click flips any thread', () => {
    const [opened] = updateThreads(loaded, { type: 'ThreadFoldToggled', threadId: 't2' }, REF);
    expect(isFolded(loaded, loaded.list![0]!)).toBe(false);
    expect(isFolded(loaded, loaded.list![1]!)).toBe(true);
    expect(isFolded(opened, opened.list![1]!)).toBe(false);
    expect(isFolded(loaded, thread('t3', { outdated: true }))).toBe(true);
  });

  test('a reply goes out once, trimmed, and lands on its thread', () => {
    let [model, cmds] = updateThreads(loaded, { type: 'ReplyStarted', threadId: 't1' }, REF);
    [model] = updateThreads(model, { type: 'ReplyChanged', body: '  Because.  ' }, REF);
    [model, cmds] = updateThreads(model, { type: 'ReplySubmitted' }, REF);
    expect(cmds).toEqual([{ type: 'ReplyToThread', ref: REF, threadId: 't1', body: 'Because.' }]);
    expect(updateThreads(model, { type: 'ReplySubmitted' }, REF)[1]).toEqual([]);
    const reply = { ...comment, id: 'c2', body: 'Because.' };
    [model] = updateThreads(model, { type: 'ReplySent', threadId: 't1', comment: reply }, REF);
    expect(model.list![0]!.comments).toEqual([comment, reply]);
    expect(model.replying).toBeUndefined();
    expect(model.busy.size).toBe(0);
  });

  test('words written while a reply is on its way stay in the box', () => {
    let [model] = updateThreads(loaded, { type: 'ReplyStarted', threadId: 't1' }, REF);
    [model] = updateThreads(model, { type: 'ReplyChanged', body: 'First.' }, REF);
    [model] = updateThreads(model, { type: 'ReplySubmitted' }, REF);
    [model] = updateThreads(model, { type: 'ReplyChanged', body: 'First. And more.' }, REF);
    [model] = updateThreads(model, { type: 'ReplySent', threadId: 't1', comment: { ...comment, id: 'c2' } }, REF);
    expect(model.replying).toEqual({ threadId: 't1', body: 'First. And more.' });
  });

  test('a refused reply keeps the words and shows why on the thread', () => {
    let [model] = updateThreads(loaded, { type: 'ReplyStarted', threadId: 't1' }, REF);
    [model] = updateThreads(model, { type: 'ReplyChanged', body: 'x' }, REF);
    [model] = updateThreads(model, { type: 'ReplySubmitted' }, REF);
    [model] = updateThreads(model, { type: 'ThreadActionFailed', threadId: 't1', error: 'No access' }, REF);
    expect(model.replying).toEqual({ threadId: 't1', body: 'x' });
    expect(model.error).toEqual({ threadId: 't1', message: 'No access' });
  });

  test('resolve flips the thread once GitHub agrees; without a PR nothing is sent', () => {
    const [sending, cmds] = updateThreads(loaded, { type: 'ThreadResolveClicked', threadId: 't2' }, REF);
    expect(cmds).toEqual([{ type: 'ResolveThread', ref: REF, threadId: 't2', resolved: false }]);
    const [done] = updateThreads(sending, { type: 'ThreadResolved', threadId: 't2', resolved: false }, REF);
    expect(done.list![1]!.resolved).toBe(false);
    expect(isFolded(done, done.list![1]!)).toBe(false);
    expect(updateThreads(loaded, { type: 'ThreadResolveClicked', threadId: 't1' }, undefined)[1]).toEqual([]);
  });
});

describe('placeThreads', () => {
  const file = {
    id: 'f',
    hunks: [
      {
        id: 'h',
        header: '@@ -1,3 +1,3 @@',
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        patch: ' a\n-b\n+c\n d',
      },
    ],
  } as unknown as FileChange;

  test('a thread on a line the diff shows sits under it; any other goes with the file', () => {
    const { onLines, onFile } = placeThreads(
      [
        thread('new', { line: 2 }),
        thread('old', { side: 'deletions', line: 2 }),
        thread('context', { line: 3 }),
        thread('far', { line: 40 }),
        thread('gone', { line: undefined, outdated: true }),
      ],
      file,
    );
    expect(onLines.map((t) => t.id)).toEqual(['new', 'old', 'context']);
    expect(onFile.map((t) => t.id)).toEqual(['far', 'gone']);
  });
});
