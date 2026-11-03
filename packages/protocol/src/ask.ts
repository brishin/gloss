import * as v from 'valibot';
import { TourSchema } from './tour.ts';

/** What a question is about, beyond the change as a whole: a group, a file, or lines of a file. */
export const AskContextSchema = v.object({
  groupKey: v.optional(v.string()),
  fileId: v.optional(v.string()),
  /** Line numbers on the new side (`additions`) or the old side (`deletions`) of the file. */
  side: v.optional(v.picklist(['additions', 'deletions'])),
  from: v.optional(v.number()),
  to: v.optional(v.number()),
});
export type AskContext = v.InferOutput<typeof AskContextSchema>;

/** One earlier question and the answer the reader saw. */
export const AskTurnSchema = v.object({
  question: v.string(),
  context: v.optional(AskContextSchema),
  answer: v.string(),
});
export type AskTurn = v.InferOutput<typeof AskTurnSchema>;

/**
 * `POST /api/ask`: a question about a finished tour. The backend reads the diff by `tour.diffId`
 * from its cache; the thread so far comes with the request, so the backend keeps no state.
 */
export const AskRequestSchema = v.object({
  tour: TourSchema,
  question: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
  context: v.optional(AskContextSchema),
  history: v.optional(v.array(AskTurnSchema), []),
});
export type AskRequest = v.InferInput<typeof AskRequestSchema>;

/** A line an answer cites, checked against the diff: `[label](fileId:line)` in the answer's text. */
export const AskRefSchema = v.object({
  fileId: v.string(),
  side: v.picklist(['additions', 'deletions']),
  line: v.number(),
});
export type AskRef = v.InferOutput<typeof AskRefSchema>;

export const AskEventSchema = v.variant('type', [
  v.object({ type: v.literal('ask.delta'), text: v.string() }),
  /** A tool the model ran while answering, e.g. reading a whole file. */
  v.object({
    type: v.literal('ask.tool'),
    id: v.string(),
    name: v.string(),
    target: v.optional(v.string()),
    state: v.picklist(['running', 'done', 'failed']),
  }),
  /** The answer is complete; `refs` are the citations in it that point at lines of the diff. */
  v.object({ type: v.literal('ask.done'), model: v.string(), refs: v.array(AskRefSchema) }),
  v.object({ type: v.literal('ask.failed'), message: v.string() }),
]);
export type AskEvent = v.InferOutput<typeof AskEventSchema>;

export function parseAskEvent(json: unknown): AskEvent {
  return v.parse(AskEventSchema, json);
}

export interface AskToolCall {
  id: string;
  name: string;
  target?: string;
  state: 'running' | 'done' | 'failed';
}

/** One answer as the reader sees it, built only by `reduceAskEvent`. */
export interface AskAnswer {
  text: string;
  tools: AskToolCall[];
  state: 'streaming' | 'done' | 'failed' | 'stopped';
  model?: string;
  refs: AskRef[];
  error?: string;
}

export const emptyAnswer: AskAnswer = { text: '', tools: [], state: 'streaming', refs: [] };

/** Pure and total, like `reduceTourEvent`: a replayed event log always gives the same answer. */
export function reduceAskEvent(answer: AskAnswer, event: AskEvent): AskAnswer {
  if (answer.state !== 'streaming') {
    return answer;
  }
  switch (event.type) {
    case 'ask.delta':
      return { ...answer, text: answer.text + event.text };
    case 'ask.tool': {
      const call: AskToolCall = { id: event.id, name: event.name, target: event.target, state: event.state };
      const known = answer.tools.some((tool) => tool.id === event.id);
      return {
        ...answer,
        tools: known
          ? answer.tools.map((tool) => (tool.id === event.id ? { ...call, target: call.target ?? tool.target } : tool))
          : [...answer.tools, call],
      };
    }
    case 'ask.done':
      return { ...answer, state: 'done', model: event.model, refs: event.refs };
    case 'ask.failed':
      return { ...answer, state: 'failed', error: event.message };
  }
}

/** The link target an answer uses for a cited line: `f1a2b3:42`, or `f1a2b3:-42` for a removed line. */
export const ASK_REF = /^(f[0-9a-f]+):(-?)(\d+)$/;

export function parseAskRef(href: string): AskRef | undefined {
  const match = ASK_REF.exec(href.trim());
  return match ? { fileId: match[1]!, side: match[2] ? 'deletions' : 'additions', line: Number(match[3]) } : undefined;
}
