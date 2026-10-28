import * as v from 'valibot';
import { DiffMetaSchema, FileSummarySchema } from './diff.ts';
import { SourceRefSchema } from './source-ref.ts';
import {
  DecisionSchema,
  FileJudgmentSchema,
  GroupDefinitionSchema,
  GroupNotesSchema,
  ModelConfigSchema,
  PlacementSchema,
  ResolvedGroupSchema,
  TourSchema,
} from './tour.ts';

export const StageSchema = v.picklist(['fetch', 'define', 'judge', 'place', 'notes']);
export type Stage = v.InferOutput<typeof StageSchema>;
export const STAGES: readonly Stage[] = StageSchema.options;

export const StageStateSchema = v.picklist(['pending', 'running', 'done', 'skipped', 'failed']);
export type StageState = v.InferOutput<typeof StageStateSchema>;

export const ProvisionalGroupSchema = v.object({
  ...GroupDefinitionSchema.entries,
  fileIds: v.array(v.string()),
});
export type ProvisionalGroup = v.InferOutput<typeof ProvisionalGroupSchema>;

const event = <const T extends string, const E extends v.ObjectEntries>(type: T, entries: E) =>
  v.object({ type: v.literal(type), ...entries });

/**
 * Everything a tour job says, in order. Later events refine earlier ones (a `placement`
 * for a file replaces its previous one); `reduceTourEvent` is the only interpretation.
 */
export const TourEventBodySchema = v.variant('type', [
  event('job.started', {
    ref: SourceRefSchema,
    sourceKey: v.string(),
    pipelineVersion: v.string(),
    models: ModelConfigSchema,
    cached: v.boolean(),
  }),
  event('diff.ready', { diffId: v.string(), meta: DiffMetaSchema, files: v.array(FileSummarySchema) }),
  event('groups.provisional', { groups: v.array(ProvisionalGroupSchema) }),
  event('stage.status', {
    stage: StageSchema,
    state: StageStateSchema,
    detail: v.optional(v.string()),
    progress: v.optional(v.object({ done: v.number(), total: v.number() })),
  }),
  event('group.defined', { group: GroupDefinitionSchema }),
  event('groups.defined', { keys: v.array(v.string()) }),
  event('tour.summary', { overallSummary: v.string(), decisions: v.optional(v.array(DecisionSchema)) }),
  event('file.judged', {
    fileId: v.string(),
    judgment: FileJudgmentSchema,
    source: v.picklist(['jev', 'cache']),
  }),
  event('placement', { fileId: v.string(), placement: PlacementSchema }),
  event('groups.resolved', { groups: v.array(ResolvedGroupSchema) }),
  event('group.notes', {
    groupKey: v.string(),
    notes: GroupNotesSchema,
    source: v.picklist(['llm', 'cache']),
  }),
  event('job.warning', {
    stage: v.optional(StageSchema),
    message: v.string(),
    fileId: v.optional(v.string()),
  }),
  event('job.error', {
    stage: v.optional(StageSchema),
    code: v.string(),
    message: v.string(),
    fatal: v.boolean(),
  }),
  event('job.aborted', { reason: v.picklist(['client', 'no-subscribers', 'superseded']) }),
  event('tour.complete', { tour: TourSchema, cached: v.boolean() }),
]);
export type TourEventBody = v.InferOutput<typeof TourEventBodySchema>;
export type TourEventType = TourEventBody['type'];

export const EnvelopeSchema = v.object({
  /** Dense from 1 within a job; the SSE `id`, so `Last-Event-ID` resumes after it. */
  seq: v.number(),
  jobId: v.string(),
  at: v.string(),
});

export const TourEventSchema = v.intersect([EnvelopeSchema, TourEventBodySchema]);
export type TourEvent = v.InferOutput<typeof EnvelopeSchema> & TourEventBody;

/** Events after which a job sends nothing more. */
export function isTerminal(event: TourEventBody): boolean {
  return event.type === 'tour.complete' || event.type === 'job.aborted' || (event.type === 'job.error' && event.fatal);
}
