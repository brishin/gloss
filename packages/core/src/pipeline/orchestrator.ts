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
import { Data, Effect, Option, Queue, Stream } from 'effect';
import type * as v from 'valibot';
import { JudgeClient, ModelClient, type ModelRequest } from '../adapters/types.ts';
import { type CacheKind, TourCache } from '../cache/store.ts';
import { hashOf } from '../hash.ts';
import { DiffSources } from '../sources/index.ts';
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
  /** Skip cache reads (writes still happen). */
  force?: boolean;
  concurrency?: { judge?: number; notes?: number };
}

/** A failure that ends the tour; it becomes a fatal `job.error`. Per-file and per-group failures are warnings instead. */
export class PipelineError extends Data.TaggedError('PipelineError')<{
  stage: Stage;
  code: string;
  message: string;
  cause?: unknown;
}> {}

export function tourCacheKey(sourceKey: string, fingerprint: string, models: ModelConfig): string {
  return hashOf({ kind: 'tour', PIPELINE_VERSION, PROMPTS_VERSION, QUESTIONS_VERSION, sourceKey, fingerprint, models });
}

export function diffCacheKey(sourceKey: string, fingerprint: string): string {
  return hashOf({ kind: 'diff', PIPELINE_VERSION, sourceKey, fingerprint });
}

/**
 * One tour as a stream of events. Stages, in order of what the reader sees: the diff and
 * heuristic groups (no model), then in parallel the LLM's group definitions and Jev's
 * per-file judgments, then placement by code, then per-group notes. Every model and Jev
 * request is cached by a hash of the exact request. Interrupting the stream's consumer
 * interrupts the pipeline, down to the `gh`/`git` child and the model call in flight.
 */
export function runTour(options: RunTourOptions): Stream.Stream<TourEventBody, PipelineError, Services> {
  return Stream.callback<TourEventBody, PipelineError, Services>((queue) =>
    tourProgram(options, (event) => Queue.offerUnsafe(queue, event)).pipe(Effect.andThen(Queue.end(queue))),
  );
}

/** What a tour needs; a `JudgeClient` is optional and read with `serviceOption`. */
export type Services = ModelClient | DiffSources | TourCache;

const tourProgram = Effect.fnUntraced(function* (
  options: RunTourOptions,
  emit: (event: TourEventBody) => void,
): Effect.fn.Return<Tour, PipelineError, Services> {
  const { ref } = options;
  const model = yield* ModelClient;
  const judge = Option.getOrUndefined(yield* Effect.serviceOption(JudgeClient));
  const cache = yield* TourCache;
  const source = (yield* DiffSources).make(ref);
  let state = initialTourState();
  const send = (event: TourEventBody) => {
    state = reduceTourEvent(state, event);
    emit(event);
  };
  const stage = (name: Stage, value: StageState, detail?: string) =>
    send({ type: 'stage.status', stage: name, state: value, detail });
  const warn = (warnStage: Stage, message: string, fileId?: string) =>
    send({ type: 'job.warning', stage: warnStage, message, fileId });
  const models: ModelConfig = { ...model.config(), judge: judge?.model };
  const sourceKey = serializeRef(ref);

  /** Returns the cached value for `request`, or runs `effect` and caches its result. */
  const cached = <T, E>(kind: CacheKind, request: unknown, effect: Effect.Effect<T, E>, modelId?: string) =>
    Effect.suspend(() => {
      const key = hashOf({ kind, request });
      const hit = options.force ? undefined : cache.get<T>(key);
      if (hit !== undefined) {
        return Effect.succeed({ value: hit, hit: true });
      }
      return effect.pipe(
        Effect.tap((value) => Effect.sync(() => cache.put(key, kind, value, modelId))),
        Effect.map((value) => ({ value, hit: false })),
      );
    });

  const prompt = <S extends v.GenericSchema>(request: ModelRequest<S>) =>
    model.prompt(request).pipe(Effect.map((response) => response.data));

  const sourceError = (cause: unknown) =>
    new PipelineError({ stage: 'fetch', code: 'source', message: messageOf(cause), cause });

  // Stage 0: fetch. A finished tour for this exact head and config replays at once.
  const fingerprint = yield* Effect.tryPromise({ try: (signal) => source.fingerprint(signal), catch: sourceError });
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
    const fetched = yield* Effect.tryPromise({ try: (signal) => source.fetch(signal), catch: sourceError });
    diff = { id: diffKey, ref, sourceKey, fingerprint, ...fetched };
    cache.put(diffKey, 'diff', diff);
  }
  const { meta, files } = diff;
  cache.recordRecent(ref, sourceKey, meta.title);
  send({ type: 'diff.ready', diffId: diff.id, meta, files: files.map(summarizeFile) });
  send({ type: 'groups.provisional', groups: provisionalGroups(files) });
  stage('fetch', 'done', `${files.length} files`);

  const finish = Effect.suspend(() => {
    const tour = tourFromState(state);
    if (!tour) {
      return Effect.fail(
        new PipelineError({
          stage: 'notes',
          code: 'incomplete',
          message: 'The tour finished without all of its parts.',
        }),
      );
    }
    cache.put(tourKey, 'tour', tour);
    send({ type: 'tour.complete', tour, cached: false });
    return Effect.succeed(tour);
  });

  if (files.length === 0) {
    send({ type: 'groups.resolved', groups: [] });
    for (const name of ['define', 'judge', 'place', 'notes'] as const) {
      stage(name, 'skipped', 'No changes');
    }
    return yield* finish;
  }

  const judgeConcurrency = options.concurrency?.judge ?? 8;

  const defineGroups = Effect.gen(function* () {
    const listFiles = !judge;
    stage('define', 'running');
    const definePrompt = buildDefinePrompt(meta, files, listFiles);
    const { value } = yield* cached(
      'define',
      { PROMPTS_VERSION, model: models.define, listFiles, prompt: definePrompt },
      prompt({
        tier: 'define',
        system: DEFINE_SYSTEM,
        prompt: definePrompt,
        result: listFiles ? DefineWithFilesSchema : DefineSchema,
        resultName: 'groups',
      }),
      models.define,
    ).pipe(
      Effect.catchTag('ModelError', (error) => {
        stage('define', 'failed');
        return Effect.fail(
          new PipelineError({
            stage: 'define',
            code: 'model',
            message: `Defining groups failed: ${error.message}`,
            cause: error,
          }),
        );
      }),
    );
    const definition = dedupeKeys(value);
    for (const group of definition.groups) {
      const { key, label, summary, category } = group;
      send({ type: 'group.defined', group: { key, label, summary, category } });
    }
    send({ type: 'tour.summary', overallSummary: definition.overallSummary, decisions: definition.decisions });
    send({ type: 'groups.defined', keys: definition.groups.map((group) => group.key) });
    stage('define', 'done', `${definition.groups.length} groups`);
    return definition;
  });

  /** Asks Jev about every file; a failed file is a warning, never the end of the tour. */
  const judgeEach = (
    client: JudgeClient['Service'],
    candidates: readonly FileChange[],
    kind: 'judge-file' | 'judge-group',
    ask: (state: Record<string, unknown>) => { request: unknown; run: Effect.Effect<FileJudgment, unknown> },
  ) =>
    Effect.forEach(
      candidates,
      (file) => {
        const { request, run } = ask(fileState(meta.title, file));
        return cached(kind, request, run, client.model).pipe(
          Effect.tap(({ value, hit }) =>
            Effect.sync(() =>
              send({ type: 'file.judged', fileId: file.id, judgment: value, source: hit ? 'cache' : 'jev' }),
            ),
          ),
          Effect.catch((error) =>
            Effect.sync(() => warn('judge', `Jev failed on ${file.path}: ${messageOf(error)}`, file.id)),
          ),
        );
      },
      { concurrency: judgeConcurrency, discard: true },
    );

  const judgeFiles = (client: JudgeClient['Service']) =>
    Effect.suspend(() => {
      stage('judge', 'running', `${files.length} files`);
      return judgeEach(client, files, 'judge-file', (fileState) => ({
        request: { QUESTIONS_VERSION, model: client.model, state: fileState },
        run: client.judge({ state: fileState, questions: FILE_QUESTIONS }).pipe(Effect.map(judgmentFromFileAnswers)),
      }));
    });

  const judgeGroupChoice = (client: JudgeClient['Service'], definitions: readonly GroupDefinition[]) => {
    const questions = groupQuestions(definitions);
    return judgeEach(
      client,
      files.filter((file) => file.generated !== 'gitattributes'),
      'judge-group',
      (fileState) => ({
        request: { QUESTIONS_VERSION, model: client.model, state: fileState, questions },
        run: client.judge({ state: fileState, questions }).pipe(Effect.map(judgmentFromGroupAnswers)),
      }),
    );
  };

  const followUp = (outcome: PlaceOutcome, definitions: readonly GroupDefinition[]) =>
    Effect.suspend((): Effect.Effect<Record<string, Placement>> => {
      if (outcome.uncertain.length === 0 || definitions.length === 0) {
        return Effect.succeed(applyFollowup(outcome, definitions, []));
      }
      const uncertain = new Set(outcome.uncertain);
      const pending = files.filter((file) => uncertain.has(file.id));
      stage('place', 'running', `Asking the model about ${pending.length} files`);
      const followupPrompt = buildFollowupPrompt(meta, definitions, pending);
      return cached(
        'followup',
        { PROMPTS_VERSION, model: models.followup, prompt: followupPrompt },
        prompt({
          tier: 'followup',
          system: FOLLOWUP_SYSTEM,
          prompt: followupPrompt,
          result: FollowupSchema,
          resultName: 'placements',
        }),
        models.followup,
      ).pipe(
        Effect.map(({ value }) => applyFollowup(outcome, definitions, value.placements)),
        Effect.catchTag('ModelError', (error) =>
          Effect.sync(() => {
            warn('place', `Follow-up placement failed: ${error.message}`);
            return applyFollowup(outcome, definitions, []);
          }),
        ),
      );
    });

  const writeNotes = (groups: ReturnType<typeof resolveGroups>) =>
    Effect.suspend(() => {
      const annotatable = groups.filter((group) => group.key !== SYNTHETIC_GROUPS.generated.key);
      if (annotatable.length === 0) {
        stage('notes', 'skipped');
        return Effect.void;
      }
      stage('notes', 'running', `${annotatable.length} groups`);
      const byId = new Map(files.map((file) => [file.id, file]));
      let failed = 0;
      return Effect.forEach(
        annotatable,
        (group) => {
          const members = group.fileIds.map((id) => byId.get(id)).filter((file): file is FileChange => !!file);
          const notesPrompt = buildNotesPrompt(
            meta,
            state.overallSummary,
            group,
            members,
            state.judgments,
            state.decisions,
          );
          return cached(
            'notes',
            { PROMPTS_VERSION, model: models.notes, prompt: notesPrompt },
            prompt({
              tier: 'notes',
              system: NOTES_SYSTEM,
              prompt: notesPrompt,
              result: NotesSchema,
              resultName: 'notes',
            }),
            models.notes,
          ).pipe(
            Effect.map(({ value, hit }) => {
              const { notes, warnings } = normalizeNotes(value, group, members);
              for (const message of warnings) {
                warn('notes', message);
              }
              send({ type: 'group.notes', groupKey: group.key, notes, source: hit ? 'cache' : 'llm' });
            }),
            Effect.catchTag('ModelError', (error) =>
              Effect.sync(() => {
                failed++;
                send({
                  type: 'job.error',
                  stage: 'notes',
                  code: 'model',
                  message: `Notes for "${group.label}" failed: ${error.message}`,
                  fatal: false,
                });
              }),
            ),
          );
        },
        { concurrency: options.concurrency?.notes ?? 3, discard: true },
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() =>
            stage(
              'notes',
              failed === annotatable.length ? 'failed' : 'done',
              failed ? `${failed} groups failed` : undefined,
            ),
          ),
        ),
      );
    });

  // Stage 1: the LLM defines groups while Jev judges each file.
  if (!judge) {
    stage('judge', 'skipped', 'No TypeSafe key: the LLM places files');
  }
  const [definition] = yield* Effect.all(
    [
      judge ? defineGroups.pipe(Effect.tap((defined) => judgeGroupChoice(judge, defined.groups))) : defineGroups,
      judge ? judgeFiles(judge) : Effect.void,
    ],
    { concurrency: 'unbounded' },
  );
  if (judge) {
    stage('judge', 'done');
  }

  // Stage 2: code places files; the LLM settles what Jev was unsure about.
  stage('place', 'running');
  let outcome: PlaceOutcome;
  if (!judge) {
    const listed = reconcileListedFiles(
      files,
      (definition.groups as (GroupDefinition & { fileIds?: string[] })[]).map((group) => ({
        ...group,
        fileIds: group.fileIds ?? [],
      })),
    );
    for (const id of listed.unknownIds) {
      warn('place', `The model listed an unknown file id: ${id}`);
    }
    outcome = listed;
  } else {
    outcome = placeFiles(files, definition.groups, state.judgments);
  }
  for (const [fileId, placement] of Object.entries(outcome.placements)) {
    send({ type: 'placement', fileId, placement });
  }
  // `resolveGroups` moves placements into unknown groups to `uncategorized` in this copy.
  const placements = { ...(yield* followUp(outcome, definition.groups)) };
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

  // Stage 3: notes per group, lead group first.
  yield* writeNotes(groups);
  return yield* finish;
});

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
