import type { ClassifierApi, ClassifierModel, ClassifierQuestion } from '@earendil-works/pi-ai';
import { type JudgeAnswer, JudgeClient, JudgeError } from '@gloss/core';
import { Effect, Schedule, Semaphore } from 'effect';
import { splitSpecifier } from './config.ts';
import { getModels } from './registry.ts';

/** TypeSafe's Jev through OpenRouter's System One endpoint, for users with only an OpenRouter key. */
const OPENROUTER_JEV = 'openrouter/~typesafe/jev-latest';

/** Bounded so a burst of per-file questions never trips TypeSafe's rate limit. */
const MAX_IN_FLIGHT = 16;

/** A rate limit or overload is worth a retry; anything else fails the file at once. */
class Overloaded extends JudgeError {}

function findClassifier(specifier: string): ClassifierModel<ClassifierApi> | undefined {
  const { provider, id } = splitSpecifier(specifier);
  return getModels().getModelOfType('classifier', provider, id) as ClassifierModel<ClassifierApi> | undefined;
}

/**
 * The Jev judge, or `undefined` when no TypeSafe (or OpenRouter) key is configured: the
 * pipeline then lets the LLM place files itself. Calls run on the backend only:
 * TypeSafe refuses cross-origin browser requests.
 */
export async function createJevClient(specifier: string | null): Promise<JudgeClient['Service'] | undefined> {
  if (!specifier) {
    return undefined;
  }
  const models = getModels();
  let chosen: { model: ClassifierModel<ClassifierApi>; specifier: string } | undefined;
  for (const candidate of [specifier, OPENROUTER_JEV]) {
    const model = findClassifier(candidate);
    if (model && (await models.checkAuth(model.provider))) {
      chosen = { model, specifier: candidate };
      break;
    }
  }
  if (!chosen) {
    return undefined;
  }
  const { model } = chosen;
  const permits = Semaphore.makeUnsafe(MAX_IN_FLIGHT);

  const classifyOnce = (request: Parameters<JudgeClient['Service']['judge']>[0]) =>
    Effect.tryPromise({
      try: (signal) =>
        models.classify(
          model,
          {
            state: request.state as never,
            questions: request.questions as unknown as Record<string, ClassifierQuestion>,
          },
          { signal },
        ),
      catch: (cause) => new JudgeError({ message: cause instanceof Error ? cause.message : String(cause), cause }),
    }).pipe(
      Effect.flatMap((result) => {
        if (result.stopReason === 'stop') {
          return Effect.succeed(result.answers as Record<string, JudgeAnswer>);
        }
        const message = result.errorMessage ?? `Jev ${result.stopReason}`;
        return Effect.fail(
          result.stopReason !== 'aborted' && /429|529|rate|overload/i.test(message)
            ? new Overloaded({ message })
            : new JudgeError({ message }),
        );
      }),
    );

  return {
    model: chosen.specifier,
    judge: (request) =>
      classifyOnce(request).pipe(
        permits.withPermits(1),
        Effect.retry({
          schedule: Schedule.exponential('1 second'),
          times: 3,
          while: (error) => error instanceof Overloaded,
        }),
      ),
  };
}
