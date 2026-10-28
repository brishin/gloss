import type {
  DiffPayload,
  FileChange,
  FileJudgment,
  GroupDefinition,
  ModelConfig,
  Placement,
  SourceRef,
  Stage,
  StageState,
  Tour,
  TourEventBody,
} from '@gloss/protocol';
import {
  initialTourState,
  PIPELINE_VERSION,
  reduceTourEvent,
  serializeRef,
  summarizeFile,
  SYNTHETIC_GROUPS,
  tourFromState,
} from '@gloss/protocol';
import type { JudgeClient, ModelClient } from '../adapters/types.ts';
import type { CacheStore } from '../cache/store.ts';
import { isAbortError, mapLimit, throwIfAborted } from '../concurrency.ts';
import { hashOf } from '../hash.ts';
import type { DiffSource } from '../sources/types.ts';
import { provisionalGroups } from './heuristics.ts';
import {
  fileState,
  FILE_QUESTIONS,
  groupQuestions,
  judgmentFromFileAnswers,
  judgmentFromGroupAnswers,
  QUESTIONS_VERSION,
} from './judge-questions.ts';
import { normalizeNotes } from './normalize.ts';
import { applyFollowup, placeFiles, type PlaceOutcome, reconcileListedFiles, resolveGroups } from './place.ts';
import {
  buildDefinePrompt,
  buildFollowupPrompt,
  buildNotesPrompt,
  DEFINE_SYSTEM,
  DefineSchema,
  DefineWithFilesSchema,
  FOLLOWUP_SYSTEM,
  FollowupSchema,
  NOTES_SYSTEM,
  NotesSchema,
  PROMPTS_VERSION,
} from './prompts.ts';

export interface RunTourOptions {
  ref: SourceRef;
  source: DiffSource;
  cache: CacheStore;
  model: ModelClient;
  /** Absent when no Jev key is configured: the LLM then lists files itself. */
  judge?: JudgeClient;
  emit: (event: TourEventBody) => void;
  signal: AbortSignal;
  /** Skip cache reads (writes still happen). */
  force?: boolean;
  concurrency?: { judge?: number; notes?: number };
}

export class PipelineError extends Error {
  readonly stage: Stage;
  readonly code: string;
  constructor(stage: Stage, code: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'PipelineError';
    this.stage = stage;
    this.code = code;
  }
}

export function tourCacheKey(sourceKey: string, fingerprint: string, models: ModelConfig): string {
  return hashOf({ kind: 'tour', PIPELINE_VERSION, PROMPTS_VERSION, QUESTIONS_VERSION, sourceKey, fingerprint, models });
}

export function diffCacheKey(sourceKey: string, fingerprint: string): string {
  return hashOf({ kind: 'diff', PIPELINE_VERSION, sourceKey, fingerprint });
}

/**
 * Runs one tour and streams it as events. Stages, in order of what the reader sees:
 * the diff and heuristic groups (no model), then in parallel the LLM's group definitions
 * and Jev's per-file judgments, then placement by code, then per-group notes.
 * Every model and Jev request is cached by a hash of the exact request.
 */
export async function runTour(options: RunTourOptions): Promise<Tour> {
  const { ref, source, cache, model, judge, signal } = options;
  let state = initialTourState();
  const send = (event: TourEventBody) => {
    state = reduceTourEvent(state, event);
    options.emit(event);
  };
  const stage = (name: Stage, value: StageState, detail?: string) =>
    send({ type: 'stage.status', stage: name, state: value, detail });
  const models: ModelConfig = { ...model.config(), judge: judge?.model };
  const sourceKey = serializeRef(ref);

  /** Returns the cached value for `request`, or runs `fn` and caches its result. */
  async function cached<T>(
    kind: Parameters<CacheStore['put']>[1],
    request: unknown,
    fn: () => Promise<T>,
    modelId?: string,
  ) {
    const key = hashOf({ kind, request });
    if (!options.force) {
      const hit = cache.get<T>(key);
      if (hit !== undefined) {
        return { value: hit, hit: true };
      }
    }
    const value = await fn();
    cache.put(key, kind, value, modelId);
    return { value, hit: false };
  }

  // Stage 0: fetch. A finished tour for this exact head and config replays at once.
  let fingerprint: string;
  try {
    fingerprint = await source.fingerprint(signal);
  } catch (error) {
    throw new PipelineError('fetch', 'source', error instanceof Error ? error.message : String(error), error);
  }
  const tourKey = tourCacheKey(sourceKey, fingerprint, models);
  const cachedTour = options.force ? undefined : cache.get<Tour>(tourKey);
  send({ type: 'job.started', ref, sourceKey, pipelineVersion: PIPELINE_VERSION, models, cached: !!cachedTour });
  if (cachedTour) {
    cache.recordRecent(ref, sourceKey, cachedTour.meta.title);
    send({ type: 'tour.complete', tour: cachedTour, cached: true });
    return cachedTour;
  }

  stage('fetch', 'running');
  const diffKey = diffCacheKey(sourceKey, fingerprint);
  let diff = options.force ? undefined : cache.get<DiffPayload>(diffKey);
  if (!diff) {
    try {
      const fetched = await source.fetch(signal);
      diff = { id: diffKey, ref, sourceKey, fingerprint, ...fetched };
    } catch (error) {
      throw new PipelineError('fetch', 'source', error instanceof Error ? error.message : String(error), error);
    }
    cache.put(diffKey, 'diff', diff);
  }
  const { meta, files } = diff;
  cache.recordRecent(ref, sourceKey, meta.title);
  send({ type: 'diff.ready', diffId: diff.id, meta, files: files.map(summarizeFile) });
  send({ type: 'groups.provisional', groups: provisionalGroups(files) });
  stage('fetch', 'done', `${files.length} files`);
  throwIfAborted(signal);

  if (files.length === 0) {
    send({ type: 'groups.resolved', groups: [] });
    for (const name of ['define', 'judge', 'place', 'notes'] as const) {
      stage(name, 'skipped', 'No changes');
    }
    return finish();
  }

  // Stage 1: the LLM defines groups while Jev judges each file.
  const withFiles = !judge;
  const defineTask = defineGroups(withFiles);
  const fileJudgeTask = judge ? judgeFiles(judge) : Promise.resolve();
  if (!judge) {
    stage('judge', 'skipped', 'No TypeSafe key: the LLM places files');
  }
  const groupJudgeTask = defineTask.then((definition) =>
    judge ? judgeGroupChoice(judge, definition.groups) : undefined,
  );
  const [definition] = await Promise.all([defineTask, fileJudgeTask, groupJudgeTask]);
  if (judge) {
    stage('judge', 'done');
  }
  throwIfAborted(signal);

  // Stage 2: code places files; the LLM settles what Jev was unsure about.
  stage('place', 'running');
  let outcome: PlaceOutcome;
  if (withFiles) {
    const listed = reconcileListedFiles(
      files,
      (definition.groups as (GroupDefinition & { fileIds?: string[] })[]).map((group) => ({
        ...group,
        fileIds: group.fileIds ?? [],
      })),
    );
    for (const id of listed.unknownIds) {
      send({ type: 'job.warning', stage: 'place', message: `The model listed an unknown file id: ${id}` });
    }
    outcome = listed;
  } else {
    outcome = placeFiles(files, definition.groups, state.judgments);
  }
  for (const [fileId, placement] of Object.entries(outcome.placements)) {
    send({ type: 'placement', fileId, placement });
  }
  // `resolveGroups` moves placements into unknown groups to `uncategorized` in this copy.
  const placements = { ...(await followUp(outcome, definition.groups)) };
  const groups = resolveGroups(files, definition.groups, placements, state.judgments);
  for (const file of files) {
    const placement = placements[file.id]!;
    const current = state.placements[file.id];
    if (current?.groupKey !== placement.groupKey || current.reason !== placement.reason) {
      send({ type: 'placement', fileId: file.id, placement });
    }
  }
  send({ type: 'groups.resolved', groups });
  stage('place', 'done');
  throwIfAborted(signal);

  // Stage 3: notes per group, lead group first.
  await writeNotes(groups);
  return finish();

  function finish(): Tour {
    const tour = tourFromState(state);
    if (!tour) {
      throw new PipelineError('notes', 'incomplete', 'The tour finished without all of its parts.');
    }
    cache.put(tourKey, 'tour', tour);
    send({ type: 'tour.complete', tour, cached: false });
    return tour;
  }

  async function defineGroups(listFiles: boolean) {
    stage('define', 'running');
    const prompt = buildDefinePrompt(meta, files, listFiles);
    const schema = listFiles ? DefineWithFilesSchema : DefineSchema;
    try {
      const { value } = await cached(
        'define',
        { PROMPTS_VERSION, model: models.define, listFiles, prompt },
        async () =>
          (
            await model.prompt({
              tier: 'define',
              system: DEFINE_SYSTEM,
              prompt,
              result: schema,
              resultName: 'groups',
              signal,
            })
          ).data,
        models.define,
      );
      const definition = dedupeKeys(value);
      for (const group of definition.groups) {
        const { key, label, summary, category } = group;
        send({ type: 'group.defined', group: { key, label, summary, category } });
      }
      send({ type: 'tour.summary', overallSummary: definition.overallSummary });
      send({ type: 'groups.defined', keys: definition.groups.map((group) => group.key) });
      stage('define', 'done', `${definition.groups.length} groups`);
      return definition;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      stage('define', 'failed');
      throw new PipelineError('define', 'model', `Defining groups failed: ${messageOf(error)}`, error);
    }
  }

  async function judgeFiles(client: JudgeClient) {
    stage('judge', 'running', `${files.length} files`);
    await mapLimit(files, options.concurrency?.judge ?? 8, async (file) => {
      throwIfAborted(signal);
      try {
        const state = fileState(meta.title, file);
        const { value, hit } = await cached(
          'judge-file',
          { QUESTIONS_VERSION, model: client.model, state },
          async () => judgmentFromFileAnswers(await client.judge({ state, questions: FILE_QUESTIONS, signal })),
          client.model,
        );
        send({ type: 'file.judged', fileId: file.id, judgment: value, source: hit ? 'cache' : 'jev' });
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        send({
          type: 'job.warning',
          stage: 'judge',
          fileId: file.id,
          message: `Jev failed on ${file.path}: ${messageOf(error)}`,
        });
      }
    });
  }

  async function judgeGroupChoice(client: JudgeClient, definitions: readonly GroupDefinition[]) {
    const questions = groupQuestions(definitions);
    const candidates = files.filter((file) => file.generated !== 'gitattributes');
    await mapLimit(candidates, options.concurrency?.judge ?? 8, async (file) => {
      throwIfAborted(signal);
      try {
        const state = fileState(meta.title, file);
        const { value, hit } = await cached(
          'judge-group',
          { QUESTIONS_VERSION, model: client.model, state, questions },
          async () => judgmentFromGroupAnswers(await client.judge({ state, questions, signal })),
          client.model,
        );
        send({ type: 'file.judged', fileId: file.id, judgment: value, source: hit ? 'cache' : 'jev' });
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        send({
          type: 'job.warning',
          stage: 'judge',
          fileId: file.id,
          message: `Jev failed on ${file.path}: ${messageOf(error)}`,
        });
      }
    });
  }

  async function followUp(
    outcome: PlaceOutcome,
    definitions: readonly GroupDefinition[],
  ): Promise<Record<string, Placement>> {
    if (outcome.uncertain.length === 0 || definitions.length === 0) {
      return applyFollowup(outcome, definitions, []);
    }
    const uncertain = new Set(outcome.uncertain);
    const pending = files.filter((file) => uncertain.has(file.id));
    send({
      type: 'stage.status',
      stage: 'place',
      state: 'running',
      detail: `Asking the model about ${pending.length} files`,
    });
    const prompt = buildFollowupPrompt(meta, definitions, pending);
    try {
      const { value } = await cached(
        'followup',
        { PROMPTS_VERSION, model: models.followup, prompt },
        async () =>
          (
            await model.prompt({
              tier: 'followup',
              system: FOLLOWUP_SYSTEM,
              prompt,
              result: FollowupSchema,
              resultName: 'placements',
              signal,
            })
          ).data,
        models.followup,
      );
      return applyFollowup(outcome, definitions, value.placements);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      send({ type: 'job.warning', stage: 'place', message: `Follow-up placement failed: ${messageOf(error)}` });
      return applyFollowup(outcome, definitions, []);
    }
  }

  async function writeNotes(groups: readonly ReturnType<typeof resolveGroups>[number][]) {
    const annotatable = groups.filter((group) => group.key !== SYNTHETIC_GROUPS.generated.key);
    if (annotatable.length === 0) {
      stage('notes', 'skipped');
      return;
    }
    stage('notes', 'running', `${annotatable.length} groups`);
    const byId = new Map(files.map((file) => [file.id, file]));
    let failed = 0;
    await mapLimit(annotatable, options.concurrency?.notes ?? 3, async (group) => {
      throwIfAborted(signal);
      const members = group.fileIds.map((id) => byId.get(id)).filter((file): file is FileChange => !!file);
      const judgments: Record<string, FileJudgment> = state.judgments;
      const prompt = buildNotesPrompt(meta, state.overallSummary, group, members, judgments);
      try {
        const { value, hit } = await cached(
          'notes',
          { PROMPTS_VERSION, model: models.notes, prompt },
          async () =>
            (
              await model.prompt({
                tier: 'notes',
                system: NOTES_SYSTEM,
                prompt,
                result: NotesSchema,
                resultName: 'notes',
                signal,
              })
            ).data,
          models.notes,
        );
        const { notes, warnings } = normalizeNotes(value, group, members);
        for (const message of warnings) {
          send({ type: 'job.warning', stage: 'notes', message });
        }
        send({ type: 'group.notes', groupKey: group.key, notes, source: hit ? 'cache' : 'llm' });
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        failed++;
        send({
          type: 'job.error',
          stage: 'notes',
          code: 'model',
          message: `Notes for "${group.label}" failed: ${messageOf(error)}`,
          fatal: false,
        });
      }
    });
    stage('notes', failed === annotatable.length ? 'failed' : 'done', failed ? `${failed} groups failed` : undefined);
  }
}

/** Models occasionally repeat a key; later duplicates get a numeric suffix so placement stays unambiguous. */
function dedupeKeys<T extends { overallSummary: string; groups: (GroupDefinition & Record<string, unknown>)[] }>(
  definition: T,
): T {
  const seen = new Set<string>(
    Object.values(SYNTHETIC_GROUPS)
      .map((group) => group.key)
      // The LLM may reuse these: placement routes into its own tests/docs groups anyway.
      .filter((key) => key !== 'tests' && key !== 'guidance'),
  );
  const groups = definition.groups.map((group) => {
    let key = group.key.trim() || 'group';
    for (let n = 2; seen.has(key); n++) {
      key = `${group.key}-${n}`;
    }
    seen.add(key);
    return { ...group, key };
  });
  return { ...definition, groups };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
