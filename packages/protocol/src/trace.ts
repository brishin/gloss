import * as v from 'valibot';

/** The kinds of step a tour runs; `notes` runs once per group. */
export const StepKindSchema = v.picklist([
  'fetch',
  'define',
  'sketch',
  'callstack',
  'judge-files',
  'judge-groups',
  'judge-visual',
  'place',
  'followup',
  'notes',
]);
export type StepKind = v.InferOutput<typeof StepKindSchema>;

export const TraceStepSchema = v.object({
  /** Stable within a tour: the kind, plus `:groupKey` for notes. */
  id: v.string(),
  kind: StepKindSchema,
  /** What the step is about beyond its kind, e.g. the group a notes call annotates. */
  subject: v.optional(v.string()),
  /** Ids of the steps whose output this one reads: the edges of the pipeline's DAG. */
  inputs: v.array(v.string()),
  state: v.picklist(['running', 'done', 'failed']),
  /** Milliseconds from the start of the run that produced it. */
  startMs: v.number(),
  endMs: v.optional(v.number()),
  model: v.optional(v.string()),
  /** The answer came from the cache, not a fresh call. */
  cached: v.optional(v.boolean()),
  usage: v.optional(v.object({ input: v.number(), output: v.number() })),
  /** One line on what the step produced, e.g. "3 groups". */
  summary: v.optional(v.string()),
  system: v.optional(v.string()),
  prompt: v.optional(v.string()),
  /** Which step each part of `prompt` came from: `from` holds from line `line` (0-based) to the next section. */
  sections: v.optional(v.array(v.object({ line: v.number(), from: v.string() }))),
  /** The step's result as the model or Jev returned it (before normalizing), or what code decided. */
  output: v.optional(v.unknown()),
  /** What normalizing changed, or why the step failed. */
  warnings: v.optional(v.array(v.string())),
});
export type TraceStep = v.InferOutput<typeof TraceStepSchema>;

/** `GET /api/tours/:id/trace`: the steps so far, in start order. `done` once the job has ended. */
export const TraceSchema = v.object({ steps: v.array(TraceStepSchema), done: v.boolean() });
export type Trace = v.InferOutput<typeof TraceSchema>;
