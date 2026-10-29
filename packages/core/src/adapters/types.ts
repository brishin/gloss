import type { ModelConfig } from '@gloss/protocol';
import { Context, Data, type Effect } from 'effect';
import type * as v from 'valibot';

export type ModelTier = 'define' | 'followup' | 'notes';

export interface ModelUsage {
  input: number;
  output: number;
  cost: number;
}

export interface ModelRequest<S extends v.GenericSchema> {
  tier: ModelTier;
  /** Stable instructions; kept identical across calls so provider prompt caches hit. */
  system: string;
  prompt: string;
  /** Validated structured result; field descriptions double as instructions to the model. */
  result: S;
  /** Short name of the result, e.g. "groups"; adapters use it to name the submit tool. */
  resultName: string;
  /** Streamed model text/reasoning, for progress only. */
  onDelta?: (delta: { kind: 'text' | 'reasoning'; text: string }) => void;
}

export interface ModelResponse<T> {
  data: T;
  model: string;
  usage?: ModelUsage;
}

/** A model call that failed or returned no valid result. Interruption is not an error. */
export class ModelError extends Data.TaggedError('ModelError')<{ message: string; cause?: unknown }> {}

/** A Jev call that failed after its retries. */
export class JudgeError extends Data.TaggedError('JudgeError')<{ message: string; cause?: unknown }> {}

/** The LLM seam: the pipeline depends only on this, never on an SDK. */
export class ModelClient extends Context.Service<
  ModelClient,
  {
    /** `provider/model` per tier; part of every cache key. */
    config(): Pick<ModelConfig, 'define' | 'followup' | 'notes'>;
    prompt<S extends v.GenericSchema>(
      request: ModelRequest<S>,
    ): Effect.Effect<ModelResponse<v.InferOutput<S>>, ModelError>;
  }
>()('@gloss/core/ModelClient') {}

/** Jev-style typed questions; `bool` maps to TypeSafe's `noul`. Criteria shapes are passed through as written. */
export interface JudgeQuestion {
  type: 'choice' | 'bool' | 'score';
  instructions: string | Record<string, unknown>;
  criteria?: unknown;
}

/** A picture Jev looks at together with the state; the state can name it as `<image-N>`, counted from 1. */
export interface JudgeImage {
  data: string;
  mimeType: 'image/png' | 'image/jpeg';
}

export type JudgeAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; confidence: number }
  | { type: 'bool'; probability: number };

/**
 * A classifier that answers typed questions about one state with calibrated probabilities
 * (TypeSafe Jev). Optional: without it the LLM places files itself.
 */
export class JudgeClient extends Context.Service<
  JudgeClient,
  {
    readonly model: string;
    judge(request: {
      state: Record<string, unknown>;
      questions: Record<string, JudgeQuestion>;
      /** Base64 pictures, read before the state. Only clients whose model takes images accept them. */
      images?: readonly JudgeImage[];
    }): Effect.Effect<Record<string, JudgeAnswer>, JudgeError>;
  }
>()('@gloss/core/JudgeClient') {}
