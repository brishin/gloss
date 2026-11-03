import type { AskEvent, Tour } from '@gloss/protocol';
import { initialTourState } from '@gloss/protocol';
import { describe, expect, test } from 'vitest';
import { type AskModel, askForDiff, emptyAsk, history, updateAsk } from './ask-model.ts';
import { initialModel, keyToMsg, type Model, update } from './tour-model.ts';

const TOUR = { diffId: 'd1', models: { define: 'p/m', followup: 'p/m', notes: 'p/m' } } as Tour;

const ask = (overrides: Partial<AskModel> = {}): AskModel => ({ ...emptyAsk, diffId: 'd1', open: true, ...overrides });

function asked(draft = 'Why?'): AskModel {
  return updateAsk(ask({ draft }), { type: 'AskSubmitted' }, TOUR)[0];
}

describe('updateAsk', () => {
  test('a question starts a turn and its answer, with the thread so far and the lines it is about', () => {
    const context = { fileId: 'f1', side: 'additions' as const, from: 3, to: 5 };
    const earlier = { id: '1', question: 'Who?', answer: { text: 'Me.', tools: [], state: 'done' as const, refs: [] } };
    const [next, cmds] = updateAsk(ask({ draft: ' Why? ', context, turns: [earlier] }), { type: 'AskSubmitted' }, TOUR);
    expect(next.draft).toBe('');
    expect(next.context).toBeUndefined();
    expect(next.turns.at(-1)).toMatchObject({ id: '2', question: 'Why?', context, answer: { state: 'streaming' } });
    expect(cmds).toEqual([
      {
        type: 'StartAsk',
        turnId: '2',
        request: { tour: TOUR, question: 'Why?', context, history: [{ question: 'Who?', answer: 'Me.' }] },
      },
    ]);
  });

  test('a picked model is kept, sent with each question, and wins over a saved one', () => {
    const [picked, cmds] = updateAsk(ask(), { type: 'AskModelPicked', model: 'p/large' }, TOUR);
    expect(cmds).toEqual([{ type: 'SaveAskModel', model: 'p/large' }, { type: 'FocusAsk' }]);
    const [, start] = updateAsk({ ...picked, draft: 'Why?' }, { type: 'AskSubmitted' }, TOUR);
    expect(start[0]).toMatchObject({ type: 'StartAsk', request: { model: 'p/large' } });
    const loaded = (model: AskModel) =>
      updateAsk(model, { type: 'AskLoaded', diffId: 'd1', turns: [], model: 'p/small' }, TOUR)[0].model;
    expect(loaded(ask())).toBe('p/small');
    expect(loaded(picked)).toBe('p/large');
  });

  test('nothing is asked while the tour runs, while an answer streams, or with a blank draft', () => {
    expect(updateAsk(ask({ draft: 'Why?' }), { type: 'AskSubmitted' }, undefined)[1]).toEqual([]);
    expect(updateAsk(ask({ draft: '  ' }), { type: 'AskSubmitted' }, TOUR)[1]).toEqual([]);
    expect(updateAsk({ ...asked(), draft: 'And?' }, { type: 'AskSubmitted' }, TOUR)[1]).toEqual([]);
  });

  test('events build the answer; its end saves the thread', () => {
    const events: AskEvent[] = [
      { type: 'ask.delta', text: 'Because.' },
      { type: 'ask.done', model: 'p/m', refs: [] },
    ];
    let model = asked();
    const saved = events.flatMap((event) => {
      const [next, cmds] = updateAsk(model, { type: 'AskEventReceived', turnId: '1', event }, TOUR);
      model = next;
      return cmds;
    });
    expect(model.turns[0]!.answer).toMatchObject({ text: 'Because.', state: 'done', model: 'p/m' });
    expect(saved).toEqual([{ type: 'SaveAsk', diffId: 'd1', turns: model.turns }]);
  });

  test('stop interrupts the answer and keeps what was written', () => {
    const streaming = updateAsk(
      asked(),
      { type: 'AskEventReceived', turnId: '1', event: { type: 'ask.delta', text: 'Part' } },
      TOUR,
    )[0];
    const [stopped, cmds] = updateAsk(streaming, { type: 'AskStopClicked' }, TOUR);
    expect(stopped.turns[0]!.answer).toMatchObject({ text: 'Part', state: 'stopped' });
    expect(cmds[0]).toEqual({ type: 'StopAsk' });
    expect(history(stopped.turns)).toEqual([{ question: 'Why?', answer: 'Part', context: undefined }]);
  });

  test('a failed stream fails its answer, which is left out of the thread sent later', () => {
    const [failed] = updateAsk(asked(), { type: 'AskStreamFailed', turnId: '1', error: 'offline' }, TOUR);
    expect(failed.turns[0]!.answer).toMatchObject({ state: 'failed', error: 'offline' });
    expect(history(failed.turns)).toEqual([]);
  });

  test('a saved thread loads for its own diff, unless a question beat it', () => {
    const turns = asked().turns;
    expect(updateAsk(ask(), { type: 'AskLoaded', diffId: 'd1', turns }, TOUR)[0].turns).toBe(turns);
    expect(updateAsk(ask(), { type: 'AskLoaded', diffId: 'd2', turns }, TOUR)[0].turns).toEqual([]);
    const busy = asked('Mine');
    expect(updateAsk(busy, { type: 'AskLoaded', diffId: 'd1', turns }, TOUR)[0]).toBe(busy);
  });

  test('a new diff starts its own thread and stops an answer in flight', () => {
    const [next, cmds] = askForDiff(asked(), 'd2');
    expect(next).toMatchObject({ diffId: 'd2', turns: [], open: true });
    expect(cmds).toEqual([{ type: 'StopAsk' }, { type: 'LoadAsk', diffId: 'd2' }]);
    expect(askForDiff(next, 'd2')).toEqual([next, []]);
  });
});

describe('Ask keys', () => {
  const REF = { kind: 'github-pr', owner: 'o', repo: 'r', number: 1 } as const;
  const page = (status: 'running' | 'complete', open = false): Model => ({
    ...initialModel(REF, {}),
    tour: { ...initialTourState(), status },
    ask: { ...emptyAsk, open },
    navOpen: true,
  });

  test('q opens the panel once the tour is done, and Escape closes it before the nav', () => {
    expect(keyToMsg(page('running'), 'q')).toBeUndefined();
    expect(keyToMsg(page('complete'), 'q')).toEqual({ type: 'AskToggled' });
    expect(keyToMsg(page('complete', true), 'Escape')).toEqual({ type: 'AskClosed' });
    expect(keyToMsg(page('complete'), 'Escape')).toEqual({ type: 'NavClosed' });
  });

  test('Ask in a comment box asks about its lines with its text', () => {
    const start = {
      ...page('complete'),
      review: {
        ...page('complete').review,
        composing: { fileId: 'f1', side: 'additions' as const, line: 9, startLine: 7, body: '' },
      },
    };
    const [opened, cmds] = update(start, { type: 'CommentAsked' });
    expect(opened.review.composing).toBeUndefined();
    expect(opened.ask).toMatchObject({ open: true, context: { fileId: 'f1', side: 'additions', from: 7, to: 9 } });
    expect(cmds).toContainEqual({ type: 'FocusAsk' });
  });
});
