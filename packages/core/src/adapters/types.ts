import type { ModelConfig } from '@gloss/protocol';
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
  signal?: AbortSignal;
  /** Streamed model text/reasoning, for progress only. */
  onDelta?: (delta: { kind: 'text' | 'reasoning'; text: string }) => void;
}

export interface ModelResponse<T> {
  data: T;
  model: string;
  usage?: ModelUsage;
}

/** The LLM seam: the pipeline depends only on this, never on an SDK. */
export interface ModelClient {
  /** `provider/model` per tier; part of every cache key. */
  config(): Pick<ModelConfig, 'define' | 'followup' | 'notes'>;
  prompt<S extends v.GenericSchema>(request: ModelRequest<S>): Promise<ModelResponse<v.InferOutput<S>>>;
}

/** Jev-style typed questions; `bool` maps to TypeSafe's `noul`. Criteria shapes are passed through as written. */
export interface JudgeQuestion {
  type: 'choice' | 'bool' | 'score';
  instructions: string | Record<string, unknown>;
  criteria?: unknown;
}

export type JudgeAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; confidence: number }
  | { type: 'bool'; probability: number };

/** A classifier that answers typed questions about one state with calibrated probabilities (TypeSafe Jev). */
export interface JudgeClient {
  readonly model: string;
  judge(request: {
    state: Record<string, unknown>;
    questions: Record<string, JudgeQuestion>;
    signal?: AbortSignal;
  }): Promise<Record<string, JudgeAnswer>>;
}
