import type {
  Affected,
  Decision,
  DiffPayload,
  FileChange,
  FileJudgment,
  GroupDefinition,
  GroupNotes,
  ModelConfig,
  Placement,
  ResolvedGroup,
  SourceRef,
  Stage,
  StageState,
  Tour,
  TourEventBody,
  TraceStep,
  Visual,
} from '@gloss/protocol';
import {
  type DecisionRuleSet,
  initialTourState,
  PIPELINE_VERSION,
  reduceTourEvent,
  rulesFor,
  serializeRef,
  summarizeFile,
  SYNTHETIC_GROUPS,
  tourFromState,
} from '@gloss/protocol';
import { Data, Effect, Fiber, FiberSet, Option, Queue, type Scope, Stream } from 'effect';
import type * as v from 'valibot';
import {
  DecisionRules,
  type JudgeAnswer,
  JudgeClient,
  type JudgeQuestion,
  ModelClient,
  type ModelRequest,
} from '../adapters/types.ts';
import { type CacheKind, TourCache } from '../cache/store.ts';
import { hashOf } from '../hash.ts';
import {
  DiffSources,
  EMPTY_REPO_CONFIG,
  findImporters,
  importQueries,
  readRepoFile,
  RepoClones,
  RepoConfigs,
  readTreeFile,
  searchRepo,
} from '../sources/index.ts';
import { callerTree, countCallers, renderCallerTree } from './callers.ts';
import { provisionalGroups } from './heuristics.ts';
import {
  fileState,
  FILE_QUESTIONS,
  groupQuestions,
  judgmentFromFileAnswers,
  judgmentFromGroupAnswers,
  pickVisuals,
  QUESTIONS_VERSION,
  visualQuestions,
  visualState,
} from './judge-questions.ts';
import {
  normalizeDecisionGroups,
  normalizeNotes,
  normalizeSketch,
  normalizeVisuals,
  normalizeWalkthrough,
} from './normalize.ts';
import { applyFollowup, placeFiles, type PlaceOutcome, reconcileListedFiles, resolveGroups } from './place.ts';
import {
  AFFECTED_SYSTEM,
  AFFECTED_VERSION,
  AffectedResultSchema,
  buildAffectedPrompt,
  buildDefinePrompt,
  buildFollowupPrompt,
  buildNotesPrompt,
  buildCallPathPrompt,
  buildDescriptionCheckPrompt,
  buildSketchPrompt,
  buildWalkthroughPrompt,
  CALL_PATH_SYSTEM,
  CallPathResultSchema,
  DEFINE_SYSTEM,
  flaggedRisks,
  DefineSchema,
  DefineWithFilesSchema,
  FOLLOWUP_SYSTEM,
  FollowupSchema,
  NOTES_SYSTEM,
  NotesSchema,
  PROMPTS_VERSION,
  DESCRIPTION_CHECK_SYSTEM,
  quotedGaps,
  DESCRIPTION_CHECK_VERSION,
  DescriptionCheckSchema,
  SKETCH_SYSTEM,
  SketchSchema,
  WALKTHROUGH_SYSTEM,
  WalkthroughResultSchema,
} from './prompts.ts';
import { codeSearcher, fileReader, importerFinder } from './read-file.ts';
import {
  buildKeyStopsPrompt,
  buildSectionPrompt,
  contractFlags,
  HUNK_QUESTIONS,
  HUNK_WIDE_QUESTIONS,
  type HunkScore,
  hunkCut,
  hunkState,
  KEY_STOPS_SYSTEM,
  KeyStopsResultSchema,
  normalizeKeyStops,
  normalizeSection,
  SECTION_SYSTEM,
  SECTIONS_KEY,
  SECTIONS_VERSION,
  SectionResultSchema,
  skippableHunks,
  uncoveredKeyHunks,
  keyScore,
  supportsChange,
  walkedGroups,
} from './sections.ts';
import { createTracer, judgePrompt, promptSections } from './trace.ts';
import { visualPng } from './visual-image.ts';

export interface RunTourOptions {
  ref: SourceRef;
  /** Skip cache reads (writes still happen). */
  force?: boolean;
  concurrency?: { judge?: number; notes?: number };
  /** Called with each new or changed pipeline step, for the debug view (`trace.ts`). */
  onStep?: (step: TraceStep) => void;
}

/** A failure that ends the tour; it becomes a fatal `job.error`. Per-file and per-group failures are warnings instead. */
export class PipelineError extends Data.TaggedError('PipelineError')<{
  stage: Stage;
  code: string;
  message: string;
  cause?: unknown;
}> {}

/** The rule sets join the key only when there are some, so tours cached before rules existed still hit. */
export function tourCacheKey(
  sourceKey: string,
  fingerprint: string,
  models: ModelConfig,
  rules: readonly DecisionRuleSet[] = [],
): string {
  return hashOf({
    kind: 'tour',
    PIPELINE_VERSION,
    PROMPTS_VERSION,
    DESCRIPTION_CHECK_VERSION,
    AFFECTED_VERSION,
    QUESTIONS_VERSION,
    SECTIONS_KEY,
    sourceKey,
    fingerprint,
    models,
    ...(rules.length ? { rules } : {}),
  });
}

/**
 * Importer lookups before the affected call. Grepping a clone or the local repository is cheap,
 * so each changed file's importers are followed up to where they are mounted; GitHub's code
 * search (when a PR's head cannot be fetched) allows about 10 searches a minute, so it looks up
 * fewer and only direct importers.
 */
const GREP_LOOKUPS = 10;
const GREP_TREE = { depth: 3, fanout: 5, budget: 20 };
const GITHUB_LOOKUPS = 6;

/** The trace of the run that produced a cached tour, so its debug view outlives the job. */
export function traceCacheKey(tourKey: string): string {
  return hashOf({ kind: 'trace', tourKey });
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

/** What a tour needs; a `JudgeClient`, `DecisionRules` and `RepoConfigs` are optional and read with `serviceOption`. */
export type Services = ModelClient | DiffSources | TourCache | RepoClones;

const tourProgram = Effect.fnUntraced(function* (
  options: RunTourOptions,
  emit: (event: TourEventBody) => void,
): Effect.fn.Return<Tour, PipelineError, Services | Scope.Scope> {
  const { ref } = options;
  const model = yield* ModelClient;
  const judge = Option.getOrUndefined(yield* Effect.serviceOption(JudgeClient));
  const cache = yield* TourCache;
  const rulesService = Option.getOrUndefined(yield* Effect.serviceOption(DecisionRules));
  const userRuleSets: readonly DecisionRuleSet[] = rulesService ? yield* rulesService.get : [];
  const repoConfigs = Option.getOrUndefined(yield* Effect.serviceOption(RepoConfigs));
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
  // The tour's tiers only: they are part of the tour's cache key.
  const { define, followup, notes } = model.config();
  const models: ModelConfig = { define, followup, notes, judge: judge?.model };
  const trace = createTracer(options.onStep);
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

  /** A model call for trace step `stepId`, which records the call's usage. */
  const prompt = <S extends v.GenericSchema>(stepId: string, request: ModelRequest<S>) =>
    model.prompt(request).pipe(
      Effect.map((response) => {
        const { usage } = response;
        trace.patch(stepId, {
          model: response.model,
          ...(usage ? { usage: { input: usage.input, output: usage.output } } : {}),
        });
        return response.data;
      }),
    );

  const sourceError = (cause: unknown) =>
    new PipelineError({ stage: 'fetch', code: 'source', message: messageOf(cause), cause });

  // Stage 0: fetch. A finished tour for this exact head and config replays at once.
  // The org's and repository's configs are read beside the fingerprint, so they add no wait. Rule
  // sets merge broadest first (org, repo, user), so the user's own rules are the last word.
  const [fingerprint, repoConfig] = yield* Effect.all(
    [
      Effect.tryPromise({ try: (signal) => source.fingerprint(signal), catch: sourceError }),
      repoConfigs ? repoConfigs.get(ref, { revalidate: options.force }) : Effect.succeed(EMPTY_REPO_CONFIG),
    ],
    { concurrency: 2 },
  );
  const ruleSets = [...repoConfig.decisionRules, ...userRuleSets];
  const tourKey = tourCacheKey(sourceKey, fingerprint, models, ruleSets);
  const cachedTour = options.force ? undefined : cache.get<Tour>(tourKey);
  send({ type: 'job.started', ref, sourceKey, pipelineVersion: PIPELINE_VERSION, models, cached: !!cachedTour });
  if (cachedTour) {
    for (const step of cache.get<TraceStep[]>(traceCacheKey(tourKey)) ?? []) {
      options.onStep?.(step);
    }
    cache.recordRecent(ref, sourceKey, cachedTour.meta.title, cachedTour.meta.author);
    send({ type: 'tour.complete', tour: cachedTour, cached: true });
    return cachedTour;
  }

  stage('fetch', 'running');
  trace.begin('fetch', 'fetch', { inputs: [] });
  const diffKey = diffCacheKey(sourceKey, fingerprint);
  let diff = options.force ? undefined : cache.get<DiffPayload>(diffKey);
  if (!diff) {
    const fetched = yield* Effect.tryPromise({ try: (signal) => source.fetch(signal), catch: sourceError }).pipe(
      Effect.tapError((error) => Effect.sync(() => trace.end('fetch', { warnings: [error.message] }, 'failed'))),
    );
    diff = { id: diffKey, ref, sourceKey, fingerprint, ...fetched };
    cache.put(diffKey, 'diff', diff);
  }
  const { meta, files } = diff;
  cache.recordRecent(ref, sourceKey, meta.title, meta.author);
  send({ type: 'diff.ready', diffId: diff.id, meta, files: files.map(summarizeFile) });
  send({ type: 'groups.provisional', groups: provisionalGroups(files) });
  stage('fetch', 'done', `${files.length} files`);
  trace.end('fetch', {
    summary: `${files.length} files`,
    output: files.map((file) => `${file.id} ${file.status} ${file.path} +${file.additions} -${file.deletions}`),
  });

  // `read_file` reads run in the tour's scope, so stopping the tour stops their git/gh calls too.
  const runRead = yield* FiberSet.makeRuntimePromise<never>();
  const tourDiff = diff;
  /** A fresh `read_file` tool for one model call: any file at the head, for code its prompt cuts off. */
  const reader = () =>
    fileReader(tourDiff, (path) => runRead(Effect.tryPromise((signal) => readRepoFile(tourDiff, path, signal))));

  /**
   * The walkthrough runs beside placement and notes, in the stream's scope so it outlives the
   * visual pick and stops with the tour; the tour waits for it before it finishes.
   */
  let walking: Fiber.Fiber<void> | undefined;
  let mapping: Fiber.Fiber<void> | undefined;
  let checking: Fiber.Fiber<void> | undefined;
  const finish = Effect.suspend(() =>
    Effect.all(
      [walking, mapping, checking].map((fiber) => (fiber ? Fiber.join(fiber) : Effect.void)),
      {
        discard: true,
      },
    ),
  ).pipe(Effect.andThen(() => complete));

  /** Sends the summary again with one part changed: the description check and the visual pick land at different times. */
  const resend = (patch: { decisions?: Decision[]; visuals?: Visual[] }) =>
    send({
      type: 'tour.summary',
      overallSummary: state.overallSummary ?? '',
      decisions: state.decisions ?? [],
      visuals: state.visuals,
      ...patch,
    });
  const complete = Effect.suspend(() => {
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
    cache.put(traceCacheKey(tourKey), 'trace', trace.steps());
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

  /**
   * The description check runs after define on the same model and adds change-wide decisions
   * where the diff disagrees with the description, skipping gaps define's decisions already make.
   * A failed call is a warning.
   */
  const checkDescription = (listed: readonly Decision[]) =>
    Effect.suspend(() => {
      const checkPrompt = buildDescriptionCheckPrompt(meta, files, listed);
      trace.begin('description-check', 'description-check', {
        inputs: ['fetch', 'define'],
        model: models.define,
        system: DESCRIPTION_CHECK_SYSTEM,
        prompt: checkPrompt,
        sections: promptSections(checkPrompt, { 'Decisions the tour lists': 'define' }),
      });
      return cached(
        'description-check',
        { DESCRIPTION_CHECK_VERSION, model: models.define, prompt: checkPrompt },
        prompt('description-check', {
          tier: 'define',
          system: DESCRIPTION_CHECK_SYSTEM,
          prompt: checkPrompt,
          result: DescriptionCheckSchema,
          resultName: 'descriptionCheck',
        }),
        models.define,
      ).pipe(
        Effect.map(({ value, hit }): Decision[] => {
          const quoted = value.claims.length ? quotedGaps(meta, value.decisions) : [];
          const unquoted = value.claims.length ? value.decisions.length - quoted.length : 0;
          // The model names the sentence that already admits a gap; such a gap is no surprise to the reviewer.
          const decisions = quoted.filter((gap) => !gap.admittedBy.trim());
          const admitted = quoted.length - decisions.length;
          trace.end('description-check', {
            cached: hit,
            output: value,
            summary: `${decisions.length ? `${decisions.length} gaps` : 'agrees'}${unquoted ? `, ${unquoted} unquoted dropped` : ''}${admitted ? `, ${admitted} admitted dropped` : ''}`,
          });
          return decisions.map(({ text, priority }) => ({ text, priority, source: 'description' as const }));
        }),
        Effect.catchTag('ModelError', (error) =>
          Effect.sync((): Decision[] => {
            warn('define', `Checking the description failed: ${error.message}`);
            trace.end('description-check', { warnings: [error.message] }, 'failed');
            return [];
          }),
        ),
      );
    });

  /**
   * Who meets the change differently: one call on the define model beside define, given who
   * imports the changed shared code, with find_importers, search_code and read_file to follow it
   * further. A failed call is a warning.
   */
  const mapAffected = Effect.gen(function* () {
    // Who imports the changed shared files and bumped packages, looked up before the call. A PR's
    // head is fetched into a shallow clone first (seconds), beside define.
    const tree = yield* (yield* RepoClones).tree(tourDiff);
    const seen = new Set(files.map((file) => file.path));
    const found = yield* Effect.forEach(
      importQueries(files, tree ? GREP_LOOKUPS : GITHUB_LOOKUPS),
      (query) =>
        (tree
          ? callerTree(
              {
                importers: (next) => Effect.tryPromise((signal) => findImporters(tourDiff, tree, next, signal)),
                read: (path) => Effect.tryPromise((signal) => readTreeFile(tree, path, signal)),
              },
              query,
              GREP_TREE,
              seen,
            ).pipe(
              Effect.map((nodes) => [
                { label: query.label, lines: renderCallerTree(nodes), count: countCallers(nodes) },
              ]),
            )
          : Effect.tryPromise((signal) => findImporters(tourDiff, tree, query, signal)).pipe(
              Effect.map((lines) => [{ label: query.label, lines, count: lines.length }]),
            )
        ).pipe(Effect.orElseSucceed(() => [])),
      // One at a time, so a file reached from two changed files shows under the first.
      { concurrency: 1 },
    ).pipe(Effect.map((all) => all.flat()));
    const affectedPrompt = buildAffectedPrompt(meta, files, found);
    trace.begin('affected', 'affected', {
      inputs: ['fetch'],
      model: models.define,
      system: AFFECTED_SYSTEM,
      prompt: affectedPrompt,
      sections: promptSections(affectedPrompt),
    });
    const reading = reader();
    const searching = codeSearcher(tourDiff, (text, path) =>
      runRead(Effect.tryPromise((signal) => searchRepo(tourDiff, tree, text, path, signal))),
    );
    const finding = importerFinder((query) =>
      runRead(Effect.tryPromise((signal) => findImporters(tourDiff, tree, query, signal))),
    );
    const reads = () =>
      readFields([
        ...found.map(({ label, count }) => `found ${count} importers of ${label}`),
        ...finding.reads(),
        ...searching.reads(),
        ...reading.reads(),
      ]);
    return yield* cached(
      'affected',
      // Its tools read the repository, so the same prompt on another tree is another request.
      { AFFECTED_VERSION, model: models.define, prompt: affectedPrompt, sourceKey, fingerprint },
      prompt('affected', {
        tier: 'define',
        system: AFFECTED_SYSTEM,
        prompt: affectedPrompt,
        result: AffectedResultSchema,
        resultName: 'affected',
        tools: [finding.tool, searching.tool, reading.tool],
      }),
      models.define,
    ).pipe(
      Effect.map(({ value, hit }) => {
        // What changes first; what should not change after it.
        const affected: Affected[] = value.surfaces
          .map(({ surface, audience, effect, what, evidence }) => ({
            surface,
            audience,
            effect,
            what,
            ...(evidence.trim() ? { evidence: evidence.trim() } : {}),
          }))
          .toSorted((a, b) => Number(a.effect === 'unchanged') - Number(b.effect === 'unchanged'));
        send({ type: 'tour.affected', affected });
        trace.end('affected', {
          cached: hit,
          output: value,
          ...reads(),
          summary: `${affected.length} surfaces`,
        });
      }),
      Effect.catchTag('ModelError', (error) =>
        Effect.sync(() => {
          warn('define', `Mapping what the change affects failed: ${error.message}`);
          trace.end('affected', { ...reads(), warnings: [error.message] }, 'failed');
        }),
      ),
    );
  });

  const defineGroups = Effect.gen(function* () {
    const listFiles = !judge;
    stage('define', 'running');
    const definePrompt = buildDefinePrompt(
      meta,
      files,
      listFiles,
      rulesFor(
        ruleSets,
        files.map((file) => file.path),
      ),
    );
    trace.begin('define', 'define', {
      inputs: ['fetch'],
      model: models.define,
      system: DEFINE_SYSTEM,
      prompt: definePrompt,
      sections: promptSections(definePrompt),
    });
    const { value, hit } = yield* cached(
      'define',
      { PROMPTS_VERSION, model: models.define, listFiles, prompt: definePrompt },
      prompt('define', {
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
        trace.end('define', { warnings: [error.message] }, 'failed');
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
    const { visuals, warnings } = normalizeVisuals(definition.visuals);
    for (const message of warnings) {
      warn('define', message);
    }
    const defined = normalizeDecisionGroups(
      definition.decisions,
      definition.groups.map((group) => group.key),
    );
    const decisions = defined;
    // The description check runs beside the rest of the tour; its gaps go last when they land, so
    // the walkthrough's decision numbers still point at define's.
    checking = yield* Effect.forkScoped(
      checkDescription(defined).pipe(
        Effect.flatMap((gaps) =>
          gaps.length
            ? Effect.sync(() => resend({ decisions: [...(state.decisions ?? defined), ...gaps] }))
            : Effect.void,
        ),
      ),
    );
    // With Jev, the picture waits for its pick; without, the first data visual shows until the sketch lands.
    send({
      type: 'tour.summary',
      overallSummary: definition.overallSummary,
      decisions,
      visuals: judge ? undefined : visuals.slice(0, 1),
    });
    send({ type: 'groups.defined', keys: definition.groups.map((group) => group.key) });
    stage('define', 'done', `${definition.groups.length} groups`);
    trace.end('define', {
      cached: hit,
      output: value,
      summary: `${definition.groups.length} groups`,
      ...(warnings.length ? { warnings } : {}),
    });
    return { ...definition, decisions, visuals, definePrompt };
  });

  /**
   * The hand-drawn candidate, from its own call on the define model: as a slot of the define
   * call it came out as a shallow overview. A failed call is a warning; the data visuals remain.
   */
  const drawSketch = (definition: {
    overallSummary: string;
    decisions: NonNullable<Tour['decisions']>;
    definePrompt: string;
  }) =>
    Effect.suspend(() => {
      const sketchPrompt = buildSketchPrompt(definition.definePrompt, definition.overallSummary, definition.decisions);
      trace.begin('sketch', 'sketch', {
        inputs: ['define'],
        model: models.define,
        system: SKETCH_SYSTEM,
        prompt: sketchPrompt,
        sections: promptSections(sketchPrompt, { 'The tour so far': 'define' }),
      });
      return cached(
        'sketch',
        { PROMPTS_VERSION, model: models.define, prompt: sketchPrompt },
        prompt('sketch', {
          tier: 'define',
          system: SKETCH_SYSTEM,
          prompt: sketchPrompt,
          result: SketchSchema,
          resultName: 'sketch',
        }),
        models.define,
      ).pipe(
        Effect.map(({ value, hit }) => {
          const { visual, warnings } = normalizeSketch(value);
          for (const message of warnings) {
            warn('define', message);
          }
          trace.end('sketch', {
            cached: hit,
            output: value,
            summary: visual ? value.form : 'dropped',
            ...(warnings.length ? { warnings } : {}),
          });
          return visual;
        }),
        Effect.catchTag('ModelError', (error) =>
          Effect.sync(() => {
            warn('define', `Drawing the sketch failed: ${error.message}`);
            trace.end('sketch', { warnings: [error.message] }, 'failed');
            return undefined;
          }),
        ),
      );
    });

  /** The sketch joins the data visuals as the first candidate, then Jev (or the order) picks. */
  const showVisual = (definition: Effect.Success<typeof defineGroups>) =>
    drawSketch(definition).pipe(
      Effect.flatMap((sketch) => {
        const visuals = sketch ? [sketch, ...definition.visuals] : definition.visuals;
        if (judge) {
          return chooseVisual(judge, { ...definition, visuals });
        }
        return sketch ? Effect.sync(() => resend({ visuals: [sketch] })) : Effect.void;
      }),
    );

  /**
   * Jev looks at each candidate drawn as a PNG (or reads its spec when one fails to draw)
   * and picks the one to show, or none. A failed call falls back to the model's first.
   */
  const chooseVisual = (
    client: JudgeClient['Service'],
    definition: { overallSummary: string; decisions: NonNullable<Tour['decisions']>; visuals: readonly Visual[] },
  ) =>
    Effect.suspend(() => {
      const { overallSummary, decisions, visuals } = definition;
      if (visuals.length === 0) {
        return Effect.void;
      }
      const pngs = visuals.map(visualPng);
      const images = pngs.every((png) => png)
        ? pngs.map((png) => ({ data: Buffer.from(png!).toString('base64'), mimeType: 'image/png' as const }))
        : undefined;
      const judgeState = visualState(meta.title, overallSummary, decisions, visuals, !!images);
      const questions = visualQuestions(visuals.length, !!images);
      const show = (shown: Visual[]) => resend({ visuals: shown });
      const visualPrompt = [
        judgePrompt(
          questions,
          visuals.map((visual, i) => `candidate ${i + 1}: ${visual.kind}`),
        ),
        '',
        '## Candidates',
        JSON.stringify(judgeState, null, 2),
      ].join('\n');
      trace.begin('judge-visual', 'judge-visual', {
        inputs: ['sketch', 'define'],
        model: client.model,
        prompt: visualPrompt,
        sections: promptSections(visualPrompt, { Questions: 'judge-visual', States: 'define', Candidates: 'sketch' }),
      });
      return cached(
        'judge-visual',
        { QUESTIONS_VERSION, model: client.model, state: judgeState, questions, images: images && hashOf(images) },
        client.judge({ state: judgeState, questions, ...(images ? { images } : {}) }),
        client.model,
      ).pipe(
        Effect.map(({ value, hit }) => {
          const shown = pickVisuals(
            visuals.map((visual) => visual.kind),
            value,
          ).map((i) => visuals[i]!);
          trace.end('judge-visual', {
            cached: hit,
            output: value,
            summary: shown.length ? `${shown.map((visual) => visual.kind).join(' + ')} shown` : 'none shown',
          });
          show(shown);
        }),
        Effect.catchTag('JudgeError', (error) =>
          Effect.sync(() => {
            warn('judge', `Jev could not pick a visual: ${error.message}`);
            trace.end('judge-visual', { warnings: [error.message] }, 'failed');
            show(visuals.slice(0, 1));
          }),
        ),
      );
    });

  /**
   * One walkthrough call on the define model, traced and cached, with `read_file`. `end` closes
   * its trace step once the answer is normalized; a failed call is only a warning (undefined).
   */
  const askWalk = <S extends v.GenericSchema>(
    kind: 'walkthrough' | 'callpath',
    system: string,
    walkPrompt: string,
    result: S,
  ) =>
    Effect.suspend(() => {
      trace.begin(kind, kind, {
        inputs: ['define'],
        model: models.define,
        system,
        prompt: walkPrompt,
        sections: promptSections(walkPrompt, { 'The tour so far': 'define' }),
      });
      const reading = reader();
      return cached(
        kind,
        { PROMPTS_VERSION, model: models.define, prompt: walkPrompt },
        prompt(kind, { tier: 'define', system, prompt: walkPrompt, result, resultName: kind, tools: [reading.tool] }),
        models.define,
      ).pipe(
        Effect.map(({ value, hit }) => ({
          value,
          end: (summary: string, warnings: string[]) =>
            trace.end(kind, {
              cached: hit,
              output: value,
              ...readFields(reading.reads()),
              summary,
              ...(warnings.length ? { warnings } : {}),
            }),
        })),
        Effect.catchTag('ModelError', (error) =>
          Effect.sync(() => {
            warn('define', `Writing the ${kind === 'callpath' ? 'call path' : 'walkthrough'} failed: ${error.message}`);
            trace.end(kind, { ...readFields(reading.reads()), warnings: [error.message] }, 'failed');
            return undefined;
          }),
        ),
      );
    });

  /**
   * The walkthrough: two calls on the define model once groups are defined, each with a numbered
   * diff so snippets, trees and excerpts can point at lines. One reads each change-wide decision
   * in code (none without decisions); the other walks the change's call path, which is dropped
   * when the decisions' trees already walk it. Asked in one call, the model left the path empty.
   * The normalizer drops what has no code to show; the overview still lists the decisions.
   */
  const writeWalkthrough = (overallSummary: string, decisions: NonNullable<Tour['decisions']>) =>
    Effect.all(
      [
        decisions.length
          ? askWalk(
              'walkthrough',
              WALKTHROUGH_SYSTEM,
              buildWalkthroughPrompt(meta, files, overallSummary, decisions),
              WalkthroughResultSchema,
            )
          : Effect.succeed(undefined),
        askWalk(
          'callpath',
          CALL_PATH_SYSTEM,
          buildCallPathPrompt(meta, files, overallSummary, decisions),
          CallPathResultSchema,
        ),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([walk, path]) => {
        const { walkthrough, warnings } = normalizeWalkthrough(
          { ...walk?.value, ...path?.value },
          files,
          decisions.length,
        );
        for (const message of warnings) {
          warn('define', message);
        }
        const onPath = (message: string) => message.includes('call path');
        walk?.end(
          walkthrough ? `${walkthrough.decisions.length} of ${decisions.length} decisions` : 'none',
          warnings.filter((message) => !onPath(message)),
        );
        path?.end(walkthrough?.steps.length ? `${walkthrough.steps.length} steps` : 'none', warnings.filter(onPath));
        if (walkthrough) {
          send({ type: 'tour.walkthrough', walkthrough });
        }
      }),
    );

  /** Asks Jev about every file; a failed file is a warning, never the end of the tour. */
  const judgeEach = (
    client: JudgeClient['Service'],
    candidates: readonly FileChange[],
    kind: 'judge-file' | 'judge-group',
    step: { id: 'judge-files' | 'judge-groups'; inputs: string[]; questions: Record<string, JudgeQuestion> },
    ask: (state: Record<string, unknown>) => { request: unknown; run: Effect.Effect<FileJudgment, unknown> },
  ) =>
    Effect.suspend(() => {
      const askedPrompt = judgePrompt(
        step.questions,
        candidates.map((file) => `${file.id} ${file.path}: title, path, status, diff`),
      );
      trace.begin(step.id, step.id, {
        inputs: step.inputs,
        model: client.model,
        prompt: askedPrompt,
        sections: promptSections(askedPrompt, { Questions: step.id === 'judge-groups' ? 'define' : step.id }),
      });
      const output: Record<string, FileJudgment> = {};
      const warnings: string[] = [];
      let hits = 0;
      return Effect.forEach(
        candidates,
        (file) => {
          const { request, run } = ask(fileState(meta.title, file));
          return cached(kind, request, run, client.model).pipe(
            Effect.tap(({ value, hit }) =>
              Effect.sync(() => {
                output[file.path] = value;
                hits += hit ? 1 : 0;
                send({ type: 'file.judged', fileId: file.id, judgment: value, source: hit ? 'cache' : 'jev' });
              }),
            ),
            Effect.catch((error) =>
              Effect.sync(() => {
                warnings.push(`${file.path}: ${messageOf(error)}`);
                warn('judge', `Jev failed on ${file.path}: ${messageOf(error)}`, file.id);
              }),
            ),
          );
        },
        { concurrency: judgeConcurrency, discard: true },
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const flagged = Object.values(output).filter((judgment) => flaggedRisks(judgment).length).length;
            trace.end(step.id, {
              cached: hits > 0 && hits === candidates.length,
              output,
              summary: `${candidates.length} files${flagged ? `, ${flagged} flagged` : ''}`,
              ...(warnings.length ? { warnings } : {}),
            });
          }),
        ),
      );
    });

  const judgeFiles = (client: JudgeClient['Service']) =>
    Effect.suspend(() => {
      stage('judge', 'running', `${files.length} files`);
      return judgeEach(
        client,
        files,
        'judge-file',
        { id: 'judge-files', inputs: ['fetch'], questions: FILE_QUESTIONS },
        (fileState) => ({
          request: { QUESTIONS_VERSION, model: client.model, state: fileState },
          run: client.judge({ state: fileState, questions: FILE_QUESTIONS }).pipe(Effect.map(judgmentFromFileAnswers)),
        }),
      );
    });

  const judgeGroupChoice = (client: JudgeClient['Service'], definitions: readonly GroupDefinition[]) => {
    const questions = groupQuestions(definitions);
    return judgeEach(
      client,
      files.filter((file) => file.generated !== 'gitattributes'),
      'judge-group',
      { id: 'judge-groups', inputs: ['define'], questions },
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
      trace.begin('followup', 'followup', {
        inputs: ['place', 'define'],
        model: models.followup,
        system: FOLLOWUP_SYSTEM,
        prompt: followupPrompt,
        sections: promptSections(followupPrompt, { Groups: 'define', 'Files to place': 'place' }),
      });
      return cached(
        'followup',
        { PROMPTS_VERSION, model: models.followup, prompt: followupPrompt },
        prompt('followup', {
          tier: 'followup',
          system: FOLLOWUP_SYSTEM,
          prompt: followupPrompt,
          result: FollowupSchema,
          resultName: 'placements',
        }),
        models.followup,
      ).pipe(
        Effect.map(({ value, hit }) => {
          trace.end('followup', { cached: hit, output: value, summary: `${value.placements.length} files placed` });
          return applyFollowup(outcome, definitions, value.placements);
        }),
        Effect.catchTag('ModelError', (error) =>
          Effect.sync(() => {
            warn('place', `Follow-up placement failed: ${error.message}`);
            trace.end('followup', { warnings: [error.message] }, 'failed');
            return applyFollowup(outcome, definitions, []);
          }),
        ),
      );
    });

  /**
   * What Jev says of each hunk of a group, for its walk (`sections.ts`): two calls per hunk, since
   * the skip question scores lower when the wider ones are asked beside it. A failed call leaves
   * its hunk unscored: open and unflagged.
   */
  const judgeHunks = (client: JudgeClient['Service'], members: readonly FileChange[], group: ResolvedGroup) => {
    const context = { summary: state.overallSummary ?? '', group: `${group.label}: ${group.summary}` };
    const ask = (hunkQuestion: Record<string, unknown>, questions: Record<string, JudgeQuestion>) =>
      cached(
        'judge-file',
        { kind: 'hunk', model: client.model, state: hunkQuestion, questions },
        client.judge({ state: hunkQuestion, questions }),
        client.model,
      );
    const p = (answer: JudgeAnswer | undefined) => (answer?.type === 'bool' ? answer.probability : undefined);
    return Effect.forEach(
      members
        .filter((file) => !file.isBinary && !file.truncated)
        .flatMap((file) => file.hunks.map((hunk) => ({ file, hunk }))),
      ({ file, hunk }) =>
        Effect.all(
          [
            ask(hunkState(meta.title, file, hunk), HUNK_QUESTIONS),
            ask(hunkState(meta.title, file, hunk, context), HUNK_WIDE_QUESTIONS),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(([{ value: alone }, { value: wide }]): HunkScore => ({
            fileId: file.id,
            hunkId: hunk.id,
            // Jev read only the start of a hunk over the cap, so its skip answer does not count.
            ...(hunkCut(hunk) ? {} : { skip: p(alone.skip) }),
            contract: p(wide.contract),
            key: p(wide.key),
          })),
          Effect.catch((error) =>
            Effect.sync((): HunkScore => {
              warn('judge', `Jev failed on a hunk of ${file.path}: ${messageOf(error)}`, file.id);
              return { fileId: file.id, hunkId: hunk.id };
            }),
          ),
        ),
      { concurrency: judgeConcurrency },
    );
  };
  /** One traced, cached call for a group's walk; a failed call is only a warning (undefined). */
  const askSections = <S extends v.GenericSchema>(
    stepId: string,
    subject: string,
    system: string,
    sectionPrompt: string,
    result: S,
  ) =>
    Effect.suspend(() => {
      trace.begin(stepId, 'notes', {
        subject,
        inputs: ['define'],
        model: models.notes,
        system,
        prompt: sectionPrompt,
      });
      const reading = reader();
      return cached(
        'notes',
        { SECTIONS_VERSION, kind: 'section', model: models.notes, system, prompt: sectionPrompt },
        prompt(stepId, {
          tier: 'notes',
          system,
          prompt: sectionPrompt,
          result,
          resultName: 'walk',
          tools: [reading.tool],
        }),
        models.notes,
      ).pipe(
        Effect.map(({ value, hit }) => {
          trace.end(stepId, { cached: hit, output: value, ...readFields(reading.reads()) });
          return value as v.InferOutput<S> | undefined;
        }),
        Effect.catchTag('ModelError', (error) =>
          Effect.sync(() => {
            warn('notes', `Writing the walk for ${subject} failed: ${error.message}`);
            trace.end(stepId, { ...readFields(reading.reads()), warnings: [error.message] }, 'failed');
            return undefined;
          }),
        ),
      );
    });
  /**
   * One group's walk (`sections.ts`), from its diff and the notes just written for it. It waits
   * for the walkthrough: the change-wide decisions whose code is in this group are read here,
   * placed among the group's own stops, and so is the code path when most of it is here. `before`
   * are the groups read before this one, `support` what Jev said of the groups that support the
   * change, once it is in.
   *
   * A group that only supports the change (`walkedGroups`: tests, docs, config) gets no walk: no
   * call, no folds, its notes and diffs as they are.
   */
  const walkGroup = (
    group: ResolvedGroup,
    members: readonly FileChange[],
    notes: GroupNotes,
    before: readonly ResolvedGroup[],
    all: readonly ResolvedGroup[],
    support: Fiber.Fiber<ReadonlyMap<string, readonly HunkScore[]>>,
  ) =>
    Effect.suspend(() => (walking ? Fiber.join(walking) : Effect.void)).pipe(
      Effect.flatMap(() => Fiber.join(support)),
      Effect.flatMap((scored) => {
        const key = new Map([...scored].flatMap(([id, scores]) => [[id, keyScore(scores)] as const]));
        const walked = walkedGroups(
          all,
          files,
          new Map([...key].filter((entry): entry is [string, number] => entry[1] !== undefined)),
        );
        if (!walked.includes(group)) {
          return Effect.succeed(undefined);
        }
        const walks = state.walkthrough?.decisions ?? [];
        const excerpts = (state.walkthrough?.steps ?? []).flatMap((step) => step.excerpts);
        const shownInTour = [...walks.flatMap((walk) => walk.snippets), ...excerpts];
        const homeOf = (fileId: string | undefined) =>
          fileId === undefined ? undefined : walked.find((other) => other.fileIds.includes(fileId));
        // The code path is read in the walked group that holds most of its excerpts.
        const counts = new Map<string, number>();
        for (const excerpt of excerpts) {
          const home = homeOf(excerpt.fileId);
          if (home) {
            counts.set(home.key, (counts.get(home.key) ?? 0) + 1);
          }
        }
        const pathHome = [...counts].toSorted((a, b) => b[1] - a[1])[0]?.[0];
        const pathHere =
          pathHome === group.key ? excerpts.filter((excerpt) => group.fileIds.includes(excerpt.fileId)) : [];
        // A change-wide decision is read where its code is: the group of its first snippet in a walked
        // group. One shown only in docs or tests is read where the decision points, else with the code
        // path, else in the first walked group, so the page needs no walkthrough stop for it.
        const wideHome = (walk: (typeof walks)[number]) =>
          (
            walk.snippets.map((snippet) => homeOf(snippet.fileId)).find(Boolean) ??
            homeOf(state.decisions?.[walk.decision]?.fileId) ??
            walked.find((other) => other.key === pathHome) ??
            walked[0]
          )?.key;
        const wideHere = walks.filter((walk) => wideHome(walk) === group.key);
        return Effect.all(
          [
            // A supporting group's hunks are scored already.
            scored.has(group.key)
              ? Effect.succeed(scored.get(group.key))
              : judge
                ? judgeHunks(judge, members, group)
                : Effect.succeed(undefined),
            askSections(
              `section:${group.key}`,
              `${group.label} (walk)`,
              SECTION_SYSTEM,
              buildSectionPrompt(
                meta,
                state.overallSummary,
                state.decisions ?? [],
                group,
                members,
                notes,
                before,
                wideHere,
                pathHere,
                new Map(files.map((file) => [file.id, file.path])),
              ),
              SectionResultSchema,
            ),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.flatMap(([scores, value]) => {
            if (!value) {
              return Effect.succeed(undefined);
            }
            const normalized = normalizeSection(value, group, members, notes, {
              wideHere,
              pathHere,
              shownInTour,
              ...(scores ? { hunks: { skip: skippableHunks(scores), contract: contractFlags(scores) } } : {}),
            });
            normalized.warnings.forEach((message) => warn('notes', message));
            // The first section has nothing before it to tie to.
            const { intro, ...untied } = normalized.section;
            const section = before.length === 0 || !intro ? untied : { intro, ...untied };
            // A key hunk nothing points at gets a chance at a stop of its own, in one small follow-up call.
            const missed = scores && normalized.covered ? uncoveredKeyHunks(scores, section, normalized.covered) : [];
            if (missed.length === 0) {
              return Effect.succeed(section);
            }
            const titles = section.points.flatMap((entry) =>
              entry.kind === 'wide'
                ? (walks.find((walk) => walk.decision === entry.wide)?.title ?? [])
                : entry.title || entry.why,
            );
            return askSections(
              `section-key:${group.key}`,
              `${group.label} (key hunks)`,
              KEY_STOPS_SYSTEM,
              buildKeyStopsPrompt(meta, state.overallSummary, group, members, titles, missed),
              KeyStopsResultSchema,
            ).pipe(
              Effect.map((extra) => {
                const added = extra ? normalizeKeyStops(extra, group, members, missed) : [];
                if (added.length === 0) {
                  return section;
                }
                // The stop says more than a flag on the same hunk would.
                const reached = new Set(added.flatMap((entry) => entry.snippets.map((s) => `${s.fileId}:${s.hunkId}`)));
                const { hunkFlags, ...rest } = section;
                const flags = hunkFlags?.filter((flag) => !reached.has(`${flag.fileId}:${flag.hunkId}`));
                return {
                  ...rest,
                  points: [...section.points, ...added],
                  ...(flags?.length ? { hunkFlags: flags } : {}),
                };
              }),
            );
          }),
        );
      }),
    );

  const writeNotes = (groups: ReturnType<typeof resolveGroups>, placedBy: 'place' | 'followup') =>
    Effect.suspend(() => {
      const annotatable = groups.filter((group) => group.key !== SYNTHETIC_GROUPS.generated.key);
      if (annotatable.length === 0) {
        stage('notes', 'skipped');
        return Effect.void;
      }
      stage('notes', 'running', `${annotatable.length} groups`);
      const byId = new Map(files.map((file) => [file.id, file]));
      let failed = 0;
      const walks: Fiber.Fiber<void>[] = [];
      const membersOf = (group: ResolvedGroup) =>
        group.fileIds.map((id) => byId.get(id)).filter((file): file is FileChange => !!file);
      // Whether a group that supports the change still gets a walk is up to Jev (`walkedGroups`). Its
      // hunks are scored beside the notes, so the answer is in before any walk starts.
      const scoreSupport = Effect.forEach(
        judge ? annotatable.filter((group) => supportsChange(group, files)) : [],
        (group) =>
          judgeHunks(judge!, membersOf(group), group).pipe(Effect.map((scores) => [group.key, scores] as const)),
        { concurrency: 'unbounded' },
      ).pipe(Effect.map((entries): ReadonlyMap<string, readonly HunkScore[]> => new Map(entries)));
      // The description check's gaps are in the decision list before any notes prompt is built, so
      // every group's prompt lists them whatever the timing. The check is done by now on most tours.
      return Effect.forkScoped(scoreSupport).pipe(
        Effect.tap(() => (checking ? Fiber.join(checking) : Effect.void)),
        Effect.flatMap((support) =>
          Effect.forEach(
            annotatable,
            (group) =>
              Effect.suspend(() => {
                const members = membersOf(group);
                const notesPrompt = buildNotesPrompt(
                  meta,
                  state.overallSummary,
                  group,
                  members,
                  state.judgments,
                  state.decisions,
                  // Only the rules whose files pattern matches one of this group's files.
                  rulesFor(
                    ruleSets,
                    members.map((file) => file.path),
                  ),
                );
                const stepId = `notes:${group.key}`;
                trace.begin(stepId, 'notes', {
                  subject: group.label,
                  inputs: [placedBy, 'define', ...(judge ? ['judge-files'] : [])],
                  model: models.notes,
                  system: NOTES_SYSTEM,
                  prompt: notesPrompt,
                  sections: promptSections(notesPrompt, {
                    Overall: 'define',
                    'Change-wide decisions': 'define',
                    'This group': 'define',
                    'Flagged risks': judge ? 'judge-files' : 'define',
                    Files: placedBy,
                  }),
                });
                const reading = reader();
                return cached(
                  'notes',
                  { PROMPTS_VERSION, model: models.notes, prompt: notesPrompt },
                  prompt(stepId, {
                    tier: 'notes',
                    system: NOTES_SYSTEM,
                    prompt: notesPrompt,
                    result: NotesSchema,
                    resultName: 'notes',
                    tools: [reading.tool],
                  }),
                  models.notes,
                ).pipe(
                  Effect.flatMap(({ value, hit }) => {
                    const { notes, warnings } = normalizeNotes(value, group, members);
                    for (const message of warnings) {
                      warn('notes', message);
                    }
                    const count = value.fileNotes.length + value.lineNotes.length + value.riskNotes.length;
                    trace.end(stepId, {
                      cached: hit,
                      output: value,
                      ...readFields(reading.reads()),
                      summary: `${count} notes`,
                      ...(warnings.length ? { warnings } : {}),
                    });
                    const source = hit ? ('cache' as const) : ('llm' as const);
                    send({ type: 'group.notes', groupKey: group.key, notes, source });
                    // The walk is written outside the notes slots, so the next group's notes start at
                    // once. The notes are on the page meanwhile; they are sent again with the walk.
                    return Effect.forkScoped(
                      walkGroup(
                        group,
                        members,
                        notes,
                        annotatable.slice(0, annotatable.indexOf(group)),
                        annotatable,
                        support,
                      ).pipe(
                        Effect.map((section) => {
                          if (section) {
                            send({ type: 'group.notes', groupKey: group.key, notes: { ...notes, section }, source });
                          }
                        }),
                      ),
                    ).pipe(
                      Effect.map((fiber) => {
                        walks.push(fiber);
                      }),
                    );
                  }),
                  Effect.catchTag('ModelError', (error) =>
                    Effect.sync(() => {
                      failed++;
                      trace.end(stepId, { ...readFields(reading.reads()), warnings: [error.message] }, 'failed');
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
              }),
            { concurrency: options.concurrency?.notes ?? 3, discard: true },
          ),
        ),
        Effect.tap(() => Effect.forEach(walks, (fiber) => Fiber.join(fiber), { discard: true })),
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
  /** Starts the walkthrough beside everything after define; `finish` joins it. */
  const startWalkthrough = (defined: { overallSummary: string; decisions: NonNullable<Tour['decisions']> }) =>
    // The walkthrough reads define's decisions only: a gap with the description has no code path to walk.
    Effect.forkScoped(
      writeWalkthrough(
        defined.overallSummary,
        defined.decisions.filter((decision) => decision.source !== 'description'),
      ),
    ).pipe(
      Effect.map((fiber) => {
        walking = fiber;
      }),
    );
  mapping = yield* Effect.forkScoped(mapAffected);
  const [definition] = yield* Effect.all(
    [
      defineGroups.pipe(
        Effect.tap(startWalkthrough),
        Effect.tap((defined) =>
          judge
            ? Effect.all([judgeGroupChoice(judge, defined.groups), showVisual(defined)], {
                concurrency: 'unbounded',
                discard: true,
              })
            : showVisual(defined),
        ),
      ),
      judge ? judgeFiles(judge) : Effect.void,
    ],
    { concurrency: 'unbounded' },
  );
  if (judge) {
    stage('judge', 'done');
  }

  // Stage 2: code places files; the LLM settles what Jev was unsure about.
  stage('place', 'running');
  trace.begin('place', 'place', { inputs: judge ? ['judge-files', 'judge-groups', 'define'] : ['define'] });
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
  const pathOf = new Map(files.map((file) => [file.id, file.path]));
  trace.end('place', {
    output: {
      placed: Object.fromEntries(
        Object.entries(outcome.placements).map(([fileId, placement]) => [
          pathOf.get(fileId) ?? fileId,
          `${placement.groupKey} (${placement.reason})`,
        ]),
      ),
      unsure: outcome.uncertain.map((fileId) => pathOf.get(fileId) ?? fileId),
    },
    summary: outcome.uncertain.length ? `${outcome.uncertain.length} unsure` : 'all placed',
  });
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
  yield* writeNotes(groups, outcome.uncertain.length && definition.groups.length ? 'followup' : 'place');
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

/** The files a call read, for its trace step; nothing when it read none. */
function readFields(reads: string[]): { reads?: string[] } {
  return reads.length ? { reads } : {};
}
