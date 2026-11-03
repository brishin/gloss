import type { AskAnswer, AskContext, AskEvent, AskRef, AskRequest, AskTurn, Tour } from '@gloss/protocol';
import { emptyAnswer, reduceAskEvent } from '@gloss/protocol';

/**
 * The Ask panel's part of the tour page's Elm program: the reader's questions about a finished
 * tour and the answers of the model that wrote it. `updateAsk` is pure; the tour page's `update`
 * hands it the ask messages and runs the commands it returns.
 */

export interface AskTurnView {
  id: string;
  question: string;
  context?: AskContext;
  answer: AskAnswer;
}

export interface AskModel {
  open: boolean;
  draft: string;
  /** What the next question is about (lines picked in the diff); cleared once it is asked. */
  context?: AskContext;
  turns: readonly AskTurnView[];
  /** The diff the turns were asked on: they are saved and loaded per diff. */
  diffId?: string;
  /** The model the reader picked (`provider/model`); the backend's default until they pick one. */
  model?: string;
}

export const emptyAsk: AskModel = { open: false, draft: '', turns: [] };

export type AskMsg =
  | { type: 'AskToggled' }
  | { type: 'AskOpened'; context?: AskContext }
  | { type: 'AskClosed' }
  | { type: 'AskDraftChanged'; draft: string }
  | { type: 'AskContextCleared' }
  | { type: 'AskSubmitted' }
  | { type: 'AskEventReceived'; turnId: string; event: AskEvent }
  | { type: 'AskStreamFailed'; turnId: string; error: string }
  | { type: 'AskStopClicked' }
  | { type: 'AskModelPicked'; model: string }
  | { type: 'AskLoaded'; diffId: string; turns: readonly AskTurnView[]; model?: string };

export type AskCmd =
  /** Streams one answer. Keyed: a later `StartAsk` or `StopAsk` interrupts it. */
  | { type: 'StartAsk'; turnId: string; request: AskRequest }
  | { type: 'StopAsk' }
  | { type: 'FocusAsk' }
  | { type: 'LoadAsk'; diffId: string }
  | { type: 'SaveAsk'; diffId: string; turns: readonly AskTurnView[] }
  /** The picked model is kept for every tour, not per diff. */
  | { type: 'SaveAskModel'; model: string };

const streaming = (ask: AskModel) => ask.turns.some((turn) => turn.answer.state === 'streaming');

/** Turns worth keeping: an answer that is still streaming is saved as stopped, so a reload never shows it hanging. */
export function savedTurns(turns: readonly AskTurnView[]): AskTurnView[] {
  return turns.map((turn) =>
    turn.answer.state === 'streaming' ? { ...turn, answer: { ...turn.answer, state: 'stopped' } } : turn,
  );
}

/** The thread so far as the backend reads it: answered turns only. */
export function history(turns: readonly AskTurnView[]): AskTurn[] {
  return turns
    .filter((turn) => turn.answer.text.trim() && turn.answer.state !== 'failed')
    .map((turn) => ({ question: turn.question, context: turn.context, answer: turn.answer.text }));
}

/** Whether a link in an answer is a citation the backend checked against the diff. */
export function checkedRef(answer: AskAnswer, ref: AskRef | undefined): AskRef | undefined {
  return ref && answer.refs.find((r) => r.fileId === ref.fileId && r.side === ref.side && r.line === ref.line);
}

function stopStreaming(ask: AskModel): AskModel {
  return {
    ...ask,
    turns: ask.turns.map((turn) =>
      turn.answer.state === 'streaming' ? { ...turn, answer: { ...turn.answer, state: 'stopped' } } : turn,
    ),
  };
}

function save(ask: AskModel): AskCmd[] {
  return ask.diffId ? [{ type: 'SaveAsk', diffId: ask.diffId, turns: savedTurns(ask.turns) }] : [];
}

/** `tour` is the finished tour, or undefined while it is still running (nothing can be asked yet). */
export function updateAsk(ask: AskModel, msg: AskMsg, tour: Tour | undefined): [AskModel, AskCmd[]] {
  switch (msg.type) {
    case 'AskToggled':
      return ask.open ? [{ ...ask, open: false }, []] : [{ ...ask, open: true }, [{ type: 'FocusAsk' }]];
    case 'AskOpened':
      return [{ ...ask, open: true, context: msg.context ?? ask.context }, [{ type: 'FocusAsk' }]];
    case 'AskClosed':
      return ask.open ? [{ ...ask, open: false }, []] : [ask, []];
    case 'AskDraftChanged':
      return [{ ...ask, draft: msg.draft }, []];
    case 'AskContextCleared':
      return [{ ...ask, context: undefined }, []];
    case 'AskSubmitted': {
      const question = ask.draft.trim();
      if (!question || !tour || streaming(ask)) {
        return [ask, []];
      }
      const turn: AskTurnView = {
        id: String(ask.turns.length + 1),
        question,
        context: ask.context,
        answer: emptyAnswer,
      };
      const request: AskRequest = {
        tour,
        question,
        context: ask.context,
        history: history(ask.turns),
        ...(ask.model ? { model: ask.model } : {}),
      };
      return [
        { ...ask, draft: '', context: undefined, turns: [...ask.turns, turn] },
        [{ type: 'StartAsk', turnId: turn.id, request }],
      ];
    }
    case 'AskEventReceived': {
      const turns = ask.turns.map((turn) =>
        turn.id === msg.turnId ? { ...turn, answer: reduceAskEvent(turn.answer, msg.event) } : turn,
      );
      const next = { ...ask, turns };
      const ended = msg.event.type === 'ask.done' || msg.event.type === 'ask.failed';
      return [next, ended ? save(next) : []];
    }
    case 'AskStreamFailed': {
      const turns = ask.turns.map((turn) =>
        turn.id === msg.turnId && turn.answer.state === 'streaming'
          ? { ...turn, answer: { ...turn.answer, state: 'failed' as const, error: msg.error } }
          : turn,
      );
      const next = { ...ask, turns };
      return [next, save(next)];
    }
    case 'AskStopClicked': {
      if (!streaming(ask)) {
        return [ask, []];
      }
      const next = stopStreaming(ask);
      return [next, [{ type: 'StopAsk' }, ...save(next)]];
    }
    case 'AskModelPicked':
      return msg.model === ask.model
        ? [ask, []]
        : [{ ...ask, model: msg.model }, [{ type: 'SaveAskModel', model: msg.model }, { type: 'FocusAsk' }]];
    case 'AskLoaded': {
      // A model picked while loading wins, and so does a thread already started on this diff.
      const model = ask.model ?? msg.model;
      if (msg.diffId !== ask.diffId || ask.turns.length) {
        return [model === ask.model ? ask : { ...ask, model }, []];
      }
      return [{ ...ask, model, turns: msg.turns }, []];
    }
  }
}

/** A new diff (a new tour, or a re-run on new commits) has its own thread. */
export function askForDiff(ask: AskModel, diffId: string): [AskModel, AskCmd[]] {
  if (ask.diffId === diffId) {
    return [ask, []];
  }
  return [
    { ...stopStreaming(ask), diffId, turns: [], context: undefined },
    [...(streaming(ask) ? [{ type: 'StopAsk' } as const] : []), { type: 'LoadAsk', diffId }],
  ];
}

/** The lines a context is about, for the panel: `repos.ts 108–114`. */
export function contextLabel(context: AskContext | undefined, files: readonly { id: string; path: string }[]) {
  const file = context?.fileId ? files.find((candidate) => candidate.id === context.fileId) : undefined;
  if (!context || !file) {
    return undefined;
  }
  const name = file.path.split('/').at(-1) ?? file.path;
  const lines =
    context.from === undefined
      ? ''
      : context.to !== undefined && context.to !== context.from
        ? ` ${context.from}–${context.to}`
        : ` ${context.from}`;
  return { name, lines, path: file.path };
}
