import { describe, expect, it } from 'vitest';
import { type AskEvent, emptyAnswer, parseAskRef, reduceAskEvent } from './ask.ts';
import { createHttpGlossClient } from './client.ts';

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

describe('GlossClient.ask', () => {
  const clientWith = (body: string) =>
    createHttpGlossClient({
      baseUrl: 'http://gloss.test',
      fetch: async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    });
  const collect = async (body: string) => {
    const events: AskEvent[] = [];
    for await (const event of clientWith(body).ask({ tour: {} as never, question: 'q' })) {
      events.push(event);
    }
    return events;
  };
  const sse = (...events: AskEvent[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');

  it('ends at the terminal event', async () => {
    const events = await collect(sse({ type: 'ask.delta', text: 'a' }, { type: 'ask.done', model: 'm', refs: [] }));
    expect(events.map((event) => event.type)).toEqual(['ask.delta', 'ask.done']);
  });

  it('fails when the stream ends before the answer does', async () => {
    await expect(collect(sse({ type: 'ask.delta', text: 'a' }))).rejects.toThrow('ended early');
  });
});
