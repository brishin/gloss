import * as v from 'valibot';
import { TourSchema } from './tour.ts';

/**
 * `POST /api/symbol` (experiment): a card for one symbol the reviewer clicked in a finished
 * tour's diff. The backend reads the diff by `tour.diffId` from its cache and the code from its clone.
 */
export const SymbolRequestSchema = v.object({
  tour: TourSchema,
  fileId: v.string(),
  /** New-side line of the click. */
  line: v.number(),
  symbol: v.pipe(v.string(), v.regex(/^[A-Za-z_$][\w$]*$/), v.maxLength(120)),
});
export type SymbolRequest = v.InferInput<typeof SymbolRequestSchema>;

/** How often the symbol is used at the head, counted on the backend from the code, not by the model. */
export const SymbolUsesSchema = v.object({
  count: v.number(),
  files: v.number(),
  calls: v.number(),
  /** False when other things of the same name may be counted. */
  exact: v.boolean(),
  /** How the uses differ, in the model's words; comes with the finished card. */
  summary: v.optional(v.string()),
});
export type SymbolUses = v.InferOutput<typeof SymbolUsesSchema>;

export const SymbolCardViewSchema = v.object({
  symbol: v.string(),
  lead: v.string(),
  rows: v.optional(
    v.object({
      label: v.string(),
      items: v.array(v.object({ value: v.string(), where: v.string(), code: v.boolean() })),
    }),
  ),
  excerpt: v.optional(v.object({ path: v.string(), from: v.number(), lines: v.array(v.string()) })),
  uses: v.optional(SymbolUsesSchema),
  effect: v.optional(v.string()),
  definition: v.optional(v.object({ path: v.string(), line: v.number(), inDiff: v.boolean() })),
});
export type SymbolCardView = v.InferOutput<typeof SymbolCardViewSchema>;

export const SymbolEventSchema = v.variant('type', [
  /** Sent before the model starts: the count is ready as soon as the code is searched. */
  v.object({ type: v.literal('symbol.uses'), uses: SymbolUsesSchema }),
  /** The model is reading: a file or a search, in a few words. */
  v.object({ type: v.literal('symbol.reading'), what: v.string() }),
  /** The lead as the model writes it, ahead of the rest of the card. */
  v.object({ type: v.literal('symbol.lead'), lead: v.string() }),
  v.object({ type: v.literal('symbol.done'), card: SymbolCardViewSchema, model: v.string(), ms: v.number() }),
  v.object({ type: v.literal('symbol.failed'), message: v.string() }),
]);
export type SymbolEvent = v.InferOutput<typeof SymbolEventSchema>;

export function parseSymbolEvent(json: unknown): SymbolEvent {
  return v.parse(SymbolEventSchema, json);
}

/** One card as the reader sees it, built only by `reduceSymbolEvent`. */
export interface SymbolPeek {
  state: 'loading' | 'done' | 'failed';
  uses?: SymbolUses;
  reading?: string;
  lead?: string;
  card?: SymbolCardView;
  /** When the uses line, the lead and the whole card arrived, in ms from the click, for the experiment. */
  at: { uses?: number; lead?: number; done?: number };
  error?: string;
}

export const emptySymbolPeek: SymbolPeek = { state: 'loading', at: {} };

export function reduceSymbolEvent(peek: SymbolPeek, event: SymbolEvent, ms?: number): SymbolPeek {
  switch (event.type) {
    case 'symbol.uses':
      return { ...peek, uses: event.uses, at: { ...peek.at, uses: peek.at.uses ?? ms } };
    case 'symbol.reading':
      return { ...peek, reading: event.what };
    case 'symbol.lead':
      return { ...peek, lead: event.lead, at: { ...peek.at, lead: peek.at.lead ?? ms } };
    case 'symbol.done':
      return {
        ...peek,
        state: 'done',
        card: event.card,
        lead: event.card.lead,
        uses: event.card.uses ?? peek.uses,
        reading: undefined,
        at: { ...peek.at, done: ms },
      };
    case 'symbol.failed':
      return { ...peek, state: 'failed', error: event.message, reading: undefined };
  }
}
