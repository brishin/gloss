import { Effect } from 'effect';
import type * as v from 'valibot';
import {
  type JudgeAnswer,
  JudgeClient,
  type JudgeQuestion,
  ModelClient,
  ModelError,
  type ChatRequest,
  type ModelRequest,
  type ModelTier,
} from './types.ts';

export interface FakeModelOptions {
  /** Answers per tier; a function sees the request so it can echo ids from the prompt. */
  answers: Partial<Record<ModelTier, ((request: ModelRequest<v.GenericSchema>) => unknown) | object>>;
  delayMs?: number;
  /** The chat answer; each word streams as its own text event. */
  chat?: (request: ChatRequest) => string;
}

/** A scripted `ModelClient` for tests and offline runs. Records every request. */
export function createFakeModelClient(
  options: FakeModelOptions,
): ModelClient['Service'] & { calls: ModelRequest<v.GenericSchema>[]; chats: ChatRequest[] } {
  const calls: ModelRequest<v.GenericSchema>[] = [];
  const chats: ChatRequest[] = [];
  return {
    calls,
    chats,
    chat: (request) =>
      Effect.gen(function* () {
        chats.push(request);
        if (!options.chat) {
          return yield* new ModelError({ message: 'No fake chat answer' });
        }
        const text = options.chat(request);
        for (const word of text.match(/\S+\s*/g) ?? []) {
          if (options.delayMs) {
            yield* Effect.sleep(options.delayMs / 10);
          }
          request.onEvent?.({ type: 'text', text: word });
        }
        return { text, model: request.model };
      }),
    config: () => ({ define: 'fake/define', followup: 'fake/followup', notes: 'fake/notes', small: 'fake/small' }),
    prompt: (request) =>
      Effect.gen(function* () {
        calls.push(request);
        if (options.delayMs) {
          yield* Effect.sleep(options.delayMs);
        }
        const answer = options.answers[request.tier];
        if (answer === undefined) {
          return yield* new ModelError({ message: `No fake answer for tier ${request.tier}` });
        }
        const data = typeof answer === 'function' ? (answer as (r: typeof request) => unknown)(request) : answer;
        return { data: data as never, model: `fake/${request.tier}` };
      }),
  };
}

/** A scripted `JudgeClient`: `answer` decides each question for each file state. */
export function createFakeJudgeClient(
  answer: (state: Record<string, unknown>, id: string, question: JudgeQuestion) => JudgeAnswer,
  delayMs = 0,
): JudgeClient['Service'] & { calls: number } {
  const client = {
    model: 'fake/jev',
    calls: 0,
    judge: ({ state, questions }: Parameters<JudgeClient['Service']['judge']>[0]) =>
      Effect.gen(function* () {
        client.calls++;
        if (delayMs) {
          yield* Effect.sleep(delayMs);
        }
        return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, answer(state, id, question)]));
      }),
  };
  return client;
}
