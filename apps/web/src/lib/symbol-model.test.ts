import type { Tour } from '@gloss/protocol';
import { expect, test } from 'vitest';
import { wordAt } from './symbol-click.ts';
import { emptySymbol, updateSymbol } from './symbol-model.ts';

const tour = { diffId: 'd' } as Tour;
const click = { type: 'SymbolClicked', fileId: 'f', line: 7, symbol: 'load', left: 0, top: 0 } as const;

test('a click starts one card, its events fill it, and a second click on it is answered from the page', () => {
  const [opened, cmds] = updateSymbol(emptySymbol, click, tour);
  expect(cmds).toEqual([
    { type: 'StartSymbol', key: 'f:7:load', request: { tour, fileId: 'f', line: 7, symbol: 'load' } },
  ]);
  const [led] = updateSymbol(
    opened,
    { type: 'SymbolEventReceived', key: 'f:7:load', event: { type: 'symbol.lead', lead: 'A' }, ms: 900 },
    tour,
  );
  expect(led.open?.peek).toMatchObject({ state: 'loading', lead: 'A', at: { lead: 900 } });
  const [done] = updateSymbol(
    led,
    {
      type: 'SymbolEventReceived',
      key: 'f:7:load',
      event: { type: 'symbol.done', card: { symbol: 'load', lead: 'B' }, model: 'm', ms: 1 },
      ms: 1500,
    },
    tour,
  );
  expect(done.open?.peek).toMatchObject({ state: 'done', lead: 'B', at: { lead: 900, done: 1500 } });
  const [closed] = updateSymbol(done, { type: 'SymbolClosed' }, tour);
  const [again, none] = updateSymbol(closed, click, tour);
  expect(again.open?.peek.state).toBe('done');
  expect(none).toEqual([{ type: 'StopSymbol' }]);
});

test('no card while the tour runs, and events for a closed card are dropped', () => {
  expect(updateSymbol(emptySymbol, click, undefined)).toEqual([emptySymbol, []]);
  const event = { type: 'SymbolEventReceived', key: 'x', event: { type: 'symbol.lead', lead: 'A' }, ms: 1 } as const;
  expect(updateSymbol(emptySymbol, event, tour)[0]).toBe(emptySymbol);
});

test('the identifier under a caret', () => {
  expect(wordAt('self._session_start if x', 8)).toEqual({ word: '_session_start', start: 5 });
  expect(wordAt('a = b', 2)).toBeUndefined();
});
