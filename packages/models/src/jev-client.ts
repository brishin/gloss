import type { ClassifierApi, ClassifierModel, ClassifierQuestion } from '@earendil-works/pi-ai';
import type { JudgeAnswer, JudgeClient } from '@gloss/core';
import { splitSpecifier } from './config.ts';
import { getModels } from './registry.ts';

/** TypeSafe's Jev through OpenRouter's System One endpoint, for users with only an OpenRouter key. */
const OPENROUTER_JEV = 'openrouter/~typesafe/jev-latest';

/** Bounded so a burst of per-file questions never trips TypeSafe's rate limit. */
const MAX_IN_FLIGHT = 16;

function findClassifier(specifier: string): ClassifierModel<ClassifierApi> | undefined {
  const { provider, id } = splitSpecifier(specifier);
  return getModels().getModelOfType('classifier', provider, id) as ClassifierModel<ClassifierApi> | undefined;
}

/**
 * The Jev judge, or `undefined` when no TypeSafe (or OpenRouter) key is configured: the
 * pipeline then lets the LLM place files itself. Calls run on the backend only:
 * TypeSafe refuses cross-origin browser requests.
 */
export async function createJevClient(specifier: string | null): Promise<JudgeClient | undefined> {
  if (!specifier) {
    return undefined;
  }
  const models = getModels();
  const candidates = [specifier, OPENROUTER_JEV];
  let chosen: { model: ClassifierModel<ClassifierApi>; specifier: string } | undefined;
  for (const candidate of candidates) {
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
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    model: chosen.specifier,
    async judge({ state, questions, signal }) {
      if (active >= MAX_IN_FLIGHT) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      active++;
      try {
        for (let attempt = 0; ; attempt++) {
          const result = await models.classify(
            model,
            { state: state as never, questions: questions as unknown as Record<string, ClassifierQuestion> },
            { signal },
          );
          if (result.stopReason === 'stop') {
            return result.answers as Record<string, JudgeAnswer>;
          }
          if (
            result.stopReason === 'aborted' ||
            attempt >= 3 ||
            !/429|529|rate|overload/i.test(result.errorMessage ?? '')
          ) {
            throw new Error(result.errorMessage ?? `Jev ${result.stopReason}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        }
      } finally {
        active--;
        waiting.shift()?.();
      }
    },
  };
}
