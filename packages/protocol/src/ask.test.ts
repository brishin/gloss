import { describe, expect, it } from 'vitest';
import { type AskEvent, emptyAnswer, parseAskRef, reduceAskEvent } from './ask.ts';

describe('reduceAskEvent', () => {
  const log: AskEvent[] = [
    { type: 'ask.tool', id: 't1', name: 'read_file', target: 'a.ts', state: 'running' },
    { type: 'ask.delta', text: 'They share ' },
    { type: 'ask.tool', id: 't1', name: 'read_file', state: 'done' },
    { type: 'ask.delta', text: 'one download.' },
    { type: 'ask.done', model: 'm', refs: [{ fileId: 'f1', side: 'additions', line: 3 }] },
  ];

  it('builds the answer from its events, and a replay gives the same answer', () => {
    const answer = log.reduce(reduceAskEvent, emptyAnswer);
    expect(answer).toEqual({
      text: 'They share one download.',
      tools: [{ id: 't1', name: 'read_file', target: 'a.ts', state: 'done' }],
      state: 'done',
      model: 'm',
      refs: [{ fileId: 'f1', side: 'additions', line: 3 }],
    });
    expect(log.reduce(reduceAskEvent, emptyAnswer)).toEqual(answer);
  });

  it('ignores events after the answer ended', () => {
    const failed = reduceAskEvent(emptyAnswer, { type: 'ask.failed', message: 'boom' });
    expect(reduceAskEvent(failed, { type: 'ask.delta', text: 'late' })).toBe(failed);
    const stopped = { ...emptyAnswer, state: 'stopped' as const };
    expect(reduceAskEvent(stopped, { type: 'ask.delta', text: 'late' })).toBe(stopped);
  });
});

describe('parseAskRef', () => {
  it.each([
    ['f1a2:12', { fileId: 'f1a2', side: 'additions', line: 12 }],
    ['f1a2:-7', { fileId: 'f1a2', side: 'deletions', line: 7 }],
    ['https://example.com', undefined],
    ['f1a2', undefined],
    ['src/a.ts:12', undefined],
  ])('%s', (href, ref) => {
    expect(parseAskRef(href)).toEqual(ref);
  });
});
