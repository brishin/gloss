import type { SymbolEvent, SymbolPeek, SymbolRequest, Tour } from '@gloss/protocol';
import { emptySymbolPeek, reduceSymbolEvent } from '@gloss/protocol';

/**
 * Experiment: the card for a symbol the reader cmd-clicked in a diff. One card is open at a
 * time; finished cards are kept for the page's life, so a second click on the same symbol is instant.
 */

export interface SymbolClick {
  fileId: string;
  /** New-side line. */
  line: number;
  symbol: string;
  /** Where the card goes: the clicked word's left edge and bottom, in the page's coordinates. */
  left: number;
  top: number;
}

export interface SymbolModel {
  open?: SymbolClick & { key: string; peek: SymbolPeek };
  done: Readonly<Record<string, SymbolPeek>>;
}

export const emptySymbol: SymbolModel = { done: {} };

export type SymbolMsg =
  | ({ type: 'SymbolClicked' } & SymbolClick)
  /** `ms` is the time since the click, measured where the stream is read. */
  | { type: 'SymbolEventReceived'; key: string; event: SymbolEvent; ms: number }
  | { type: 'SymbolStreamFailed'; key: string; error: string }
  | { type: 'SymbolClosed' };

export type SymbolCmd =
  /** Streams one card. Keyed: a later `StartSymbol` or `StopSymbol` interrupts it. */
  { type: 'StartSymbol'; key: string; request: SymbolRequest } | { type: 'StopSymbol' };

const keyOf = (click: SymbolClick) => `${click.fileId}:${click.line}:${click.symbol}`;

/** `tour` is the finished tour, or undefined while it is still running (no card yet). */
export function updateSymbol(model: SymbolModel, msg: SymbolMsg, tour: Tour | undefined): [SymbolModel, SymbolCmd[]] {
  switch (msg.type) {
    case 'SymbolClicked': {
      if (!tour) {
        return [model, []];
      }
      const { type: _, ...click } = msg;
      const key = keyOf(click);
      const kept = model.done[key];
      if (kept) {
        return [{ ...model, open: { ...click, key, peek: kept } }, [{ type: 'StopSymbol' }]];
      }
      return [
        { ...model, open: { ...click, key, peek: emptySymbolPeek } },
        [
          {
            type: 'StartSymbol',
            key,
            request: { tour, fileId: click.fileId, line: click.line, symbol: click.symbol },
          },
        ],
      ];
    }
    case 'SymbolEventReceived': {
      if (model.open?.key !== msg.key) {
        return [model, []];
      }
      const peek = reduceSymbolEvent(model.open.peek, msg.event, msg.ms);
      return [
        {
          open: { ...model.open, peek },
          done: peek.state === 'done' ? { ...model.done, [msg.key]: peek } : model.done,
        },
        [],
      ];
    }
    case 'SymbolStreamFailed':
      return model.open?.key === msg.key && model.open.peek.state === 'loading'
        ? [{ ...model, open: { ...model.open, peek: { ...model.open.peek, state: 'failed', error: msg.error } } }, []]
        : [model, []];
    case 'SymbolClosed':
      return model.open ? [{ ...model, open: undefined }, [{ type: 'StopSymbol' }]] : [model, []];
  }
}
