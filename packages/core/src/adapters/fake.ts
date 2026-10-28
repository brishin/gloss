import type * as v from 'valibot';
import type { JudgeAnswer, JudgeClient, JudgeQuestion, ModelClient, ModelRequest, ModelTier } from './types.ts';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

export interface FakeModelOptions {
  /** Answers per tier; a function sees the request so it can echo ids from the prompt. */
  answers: Partial<Record<ModelTier, ((request: ModelRequest<v.GenericSchema>) => unknown) | object>>;
  delayMs?: number;
}

/** A scripted `ModelClient` for tests and offline runs. Records every request. */
export function createFakeModelClient(
  options: FakeModelOptions,
): ModelClient & { calls: ModelRequest<v.GenericSchema>[] } {
  const calls: ModelRequest<v.GenericSchema>[] = [];
  return {
    calls,
    config: () => ({ define: 'fake/define', followup: 'fake/followup', notes: 'fake/notes' }),
    async prompt(request) {
      calls.push(request);
      await sleep(options.delayMs ?? 0, request.signal);
      const answer = options.answers[request.tier];
      if (answer === undefined) {
        throw new Error(`No fake answer for tier ${request.tier}`);
      }
      const data = typeof answer === 'function' ? (answer as (r: typeof request) => unknown)(request) : answer;
      return { data: data as never, model: `fake/${request.tier}` };
    },
  };
}

/** A scripted `JudgeClient`: `answer` decides each question for each file state. */
export function createFakeJudgeClient(
  answer: (state: Record<string, unknown>, id: string, question: JudgeQuestion) => JudgeAnswer,
  delayMs = 0,
): JudgeClient & { calls: number } {
  const client = {
    model: 'fake/jev',
    calls: 0,
    async judge({ state, questions, signal }: Parameters<JudgeClient['judge']>[0]) {
      client.calls++;
      await sleep(delayMs, signal);
      return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, answer(state, id, question)]));
    },
  };
  return client;
}
