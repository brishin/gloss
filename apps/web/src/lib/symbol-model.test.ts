import type { Tour } from '@gloss/protocol';
import type { DiffPayload } from '@gloss/protocol';
import { expect, test } from 'vitest';
import { findInDiff, isSymbol, proseSymbol, wordAt } from './symbol-click.ts';
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

test('names in prose and where the diff shows them', () => {
  expect(proseSymbol('self._session_start')).toBe('_session_start');
  expect(proseSymbol('Foo.bar()')).toBe('bar');
  expect(proseSymbol('a + b')).toBeUndefined();
  expect(proseSymbol('return')).toBeUndefined();
  expect(isSymbol('id')).toBe(false);
  const hunk = { newStart: 10, patch: ' keep\n-load(old)\n+x = load(1)\n+reload()' };
  const diff = {
    files: [
      { id: 'a', hunks: [{ newStart: 1, patch: '+reload()' }] },
      { id: 'b', hunks: [hunk] },
    ],
  };
  expect(findInDiff(diff as unknown as DiffPayload, 'load')).toEqual({ fileId: 'b', line: 11 });
  expect(findInDiff(diff as unknown as DiffPayload, 'reload', 'b')).toEqual({ fileId: 'b', line: 12 });
  expect(findInDiff(diff as unknown as DiffPayload, 'missing')).toBeUndefined();
});
