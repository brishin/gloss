import type { SymbolUses } from '@gloss/protocol';
import type { ReactNode } from 'react';
import type { SymbolModel } from '../lib/symbol-model.ts';

/** `code` in backticks, as the model writes names in the lead and effect. */
function inline(text: string): ReactNode[] {
  return text.split(/`([^`]+)`/).map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part));
}

/** "15 calls in 13 files"; a loose count says "about". */
export function usesLine(uses: SymbolUses): string {
  if (uses.count === 1) {
    return 'used only here';
  }
  const noun = uses.calls === uses.count ? 'calls' : 'uses';
  return `${uses.exact ? '' : 'about '}${uses.count} ${noun} in ${uses.files} ${uses.files === 1 ? 'file' : 'files'}`;
}

function place(path: string, line: number) {
  const cut = path.lastIndexOf('/');
  return (
    <span className="sym-loc">
      {path.slice(path.lastIndexOf('/', cut - 1) + 1, cut + 1)}
      <b>{path.slice(cut + 1)}</b>:{line}
    </span>
  );
}

/** The lines without the indent they all share. */
function dedent(lines: readonly string[]): string[] {
  const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length));
  return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0));
}

const seconds = (ms: number | undefined) => (ms === undefined ? '' : `${(ms / 1000).toFixed(1)} s`);

/**
 * Experiment: the card under a cmd-clicked symbol. The uses line shows first (counted from the
 * code), then what the model is reading, then the lead as it streams, then the rest.
 */
export function SymbolPeek({ open }: { open: NonNullable<SymbolModel['open']> }) {
  const { peek, symbol } = open;
  const card = peek.card;
  const lead = card?.lead ?? peek.lead;
  const times = [
    peek.at.uses !== undefined && `uses ${seconds(peek.at.uses)}`,
    peek.at.lead !== undefined && `lead ${seconds(peek.at.lead)}`,
    peek.at.done !== undefined && `card ${seconds(peek.at.done)}`,
  ].filter(Boolean);
  return (
    <div className="sym sym-peek" style={{ left: open.left, top: open.top }} role="dialog" aria-label={symbol}>
      <div className="sym-head">
        <span className="sym-name">{symbol}</span>
        {card?.definition && <span className="sym-up">line {card.definition.line}</span>}
      </div>
      {lead ? <div>{inline(lead)}</div> : peek.state === 'loading' && <div className="sym-wait" aria-hidden="true" />}
      {peek.uses && (
        <div>
          <span className="sym-label">{usesLine(peek.uses)}</span>
          {peek.uses.summary && <div>{inline(peek.uses.summary)}</div>}
        </div>
      )}
      {card?.rows && (
        <div className="sym-io">
          <span className="sym-label">{card.rows.label}</span>
          {card.rows.items.map((item, index) => [
            <code key={`v${index}`} className={item.code ? undefined : 'sym-plain'}>
              {item.value}
            </code>,
            <span key={`w${index}`} className="where">
              {item.where}
            </span>,
          ])}
        </div>
      )}
      {card?.excerpt && (
        <div>
          <div className="sym-code-loc">{place(card.excerpt.path, card.excerpt.from)}</div>
          <div className="sym-code">
            {dedent(card.excerpt.lines).map((line, index) => (
              <div key={index} className="sym-row">
                <i>{card.excerpt!.from + index}</i>
                <span>{line}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {card?.effect && <div>{inline(card.effect)}</div>}
      {peek.state === 'failed' && <div className="sym-muted">{peek.error ?? 'The card failed.'}</div>}
      {(peek.state === 'loading' || times.length > 0) && (
        <div className="sym-foot">
          {peek.state === 'loading' ? (peek.reading ?? 'Reading the code') + '…' : times.join(' · ')}
        </div>
      )}
    </div>
  );
}
