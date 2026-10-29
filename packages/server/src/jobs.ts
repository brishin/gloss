import { randomUUID } from 'node:crypto';
import { PipelineError, runTour, type RunTourOptions, type Services } from '@gloss/core';
import type { SourceRef, TourEvent, TourEventBody } from '@gloss/protocol';
import { isTerminal, serializeRef } from '@gloss/protocol';
import { Cause, Context, Effect, Fiber, Layer, Queue, type Scope, Stream } from 'effect';

export type JobState = 'running' | 'complete' | 'failed' | 'aborted';

type AbortReason = 'client' | 'no-subscribers' | 'superseded';

export interface Job {
  readonly id: string;
  readonly key: string;
  readonly ref: SourceRef;
  readonly log: readonly TourEvent[];
  readonly state: JobState;
}

interface LiveJob extends Job {
  readonly log: TourEvent[];
  state: JobState;
  /** Set once placement is done: the expensive part is paid for, so an unwatched job still finishes and caches. */
  pastPlacement: boolean;
  readonly listeners: Set<(event: TourEvent) => void>;
  fiber?: Fiber.Fiber<void>;
  idle?: Fiber.Fiber<void>;
  abortReason?: AbortReason;
}

/** The pipeline a job runs; tests inject a scripted one. */
export type RunTour = (options: RunTourOptions) => Stream.Stream<TourEventBody, PipelineError, Services>;

export interface JobsOptions {
  /** How long a finished job stays replayable. */
  retainMs?: number;
  /** How long a running job may have no subscriber before it is aborted. */
  idleAbortMs?: number;
  run?: RunTour;
}

/**
 * Owns tour jobs: one running job per ref (two tabs share it), an in-memory event log
 * per job so a subscriber can replay from any `seq`, and abort on request or when
 * nobody is watching an early-stage job. Each job is a fiber in the layer's scope, so
 * closing the server aborts them all.
 */
export class Jobs extends Context.Service<
  Jobs,
  {
    get(jobId: string): Job | undefined;
    /** Attaches to the running job for `ref`, or starts one. `force` replaces a running job and skips cache reads. */
    start(ref: SourceRef, force?: boolean): Effect.Effect<Job>;
    /** Replays events after `after`, then follows the job live until its terminal event. */
    events(job: Job, after: number): Stream.Stream<TourEvent>;
    abort(job: Job): Effect.Effect<void>;
  }
>()('@gloss/server/Jobs') {
  static layer(options: JobsOptions = {}): Layer.Layer<Jobs, never, Services> {
    return Layer.effect(Jobs, makeJobs(options));
  }
}

const makeJobs = Effect.fnUntraced(function* (options: JobsOptions) {
  const run = options.run ?? runTour;
  const retainMs = options.retainMs ?? 10 * 60_000;
  const idleAbortMs = options.idleAbortMs ?? 60_000;
  // The pipeline's services (and the optional judge) as this layer was built with them.
  const services = yield* Effect.context<Services>();
  const scope: Scope.Scope = yield* Effect.scope;
  const jobs = new Map<string, LiveJob>();
  const running = new Map<string, LiveJob>();

  const fork = <A>(effect: Effect.Effect<A>) => Effect.forkIn(effect, scope);

  const emit = (job: LiveJob, body: TourEventBody) =>
    Effect.suspend(() => {
      if (job.state !== 'running') {
        return Effect.void;
      }
      const event = { seq: job.log.length + 1, jobId: job.id, at: new Date().toISOString(), ...body } as TourEvent;
      job.log.push(event);
      if (body.type === 'groups.resolved') {
        job.pastPlacement = true;
      }
      if (isTerminal(body)) {
        job.state = body.type === 'tour.complete' ? 'complete' : body.type === 'job.aborted' ? 'aborted' : 'failed';
      }
      for (const listener of job.listeners) {
        listener(event);
      }
      return job.state === 'running' ? Effect.void : finish(job);
    });

  const finish = (job: LiveJob) =>
    Effect.gen(function* () {
      job.listeners.clear();
      if (running.get(job.key) === job) {
        running.delete(job.key);
      }
      yield* cancelIdle(job);
      yield* fork(Effect.sleep(retainMs).pipe(Effect.andThen(Effect.sync(() => jobs.delete(job.id)))));
    });

  const cancelIdle = (job: LiveJob) =>
    Effect.suspend(() => {
      const idle = job.idle;
      job.idle = undefined;
      return idle ? Effect.asVoid(fork(Fiber.interrupt(idle))) : Effect.void;
    });

  const armIdle = (job: LiveJob) =>
    Effect.gen(function* () {
      yield* cancelIdle(job);
      if (job.state !== 'running' || job.listeners.size > 0) {
        return;
      }
      job.idle = yield* fork(
        Effect.sleep(idleAbortMs).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              job.listeners.size === 0 && !job.pastPlacement ? abort(job, 'no-subscribers') : Effect.void,
            ),
          ),
        ),
      );
    });

  const abort = (job: LiveJob, reason: AbortReason) =>
    Effect.suspend(() => {
      if (job.state !== 'running' || !job.fiber) {
        return Effect.void;
      }
      job.abortReason = reason;
      // A fiber interrupted before it started never runs its `onInterrupt`, so make sure the log says so.
      return Fiber.interrupt(job.fiber).pipe(Effect.andThen(emit(job, { type: 'job.aborted', reason })));
    });

  const execute = (job: LiveJob, force: boolean) =>
    run({ ref: job.ref, force }).pipe(
      Stream.runForEach((body) => emit(job, body)),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = Cause.squash(cause);
        return emit(job, {
          type: 'job.error',
          stage: error instanceof PipelineError ? error.stage : undefined,
          code: error instanceof PipelineError ? error.code : 'internal',
          message: error instanceof Error ? error.message : String(error),
          fatal: true,
        });
      }),
      Effect.onInterrupt(() => emit(job, { type: 'job.aborted', reason: job.abortReason ?? 'client' })),
      Effect.provideContext(services),
    );

  return Jobs.of({
    get: (jobId) => jobs.get(jobId),

    start: (ref, force = false) =>
      Effect.gen(function* () {
        const key = serializeRef(ref);
        const existing = running.get(key);
        if (existing && !force) {
          return existing;
        }
        if (existing) {
          yield* abort(existing, 'superseded');
        }
        const job: LiveJob = {
          id: randomUUID(),
          key,
          ref,
          log: [],
          state: 'running',
          pastPlacement: false,
          listeners: new Set(),
        };
        jobs.set(job.id, job);
        running.set(key, job);
        job.fiber = yield* Effect.forkIn(execute(job, force), scope, { startImmediately: true });
        yield* armIdle(job);
        return job;
      }),

    events: (job, after) =>
      Stream.callback<TourEvent>((queue) =>
        Effect.gen(function* () {
          const live = jobs.get(job.id) ?? (job as LiveJob);
          for (const event of live.log) {
            if (event.seq > after) {
              Queue.offerUnsafe(queue, event);
            }
          }
          if (live.state !== 'running') {
            yield* Queue.end(queue);
            return;
          }
          const listener = (event: TourEvent) => {
            Queue.offerUnsafe(queue, event);
            if (isTerminal(event)) {
              Queue.endUnsafe(queue);
            }
          };
          live.listeners.add(listener);
          yield* cancelIdle(live);
          yield* Effect.addFinalizer(() =>
            Effect.suspend(() => {
              live.listeners.delete(listener);
              return armIdle(live);
            }),
          );
        }),
      ),

    abort: (job) => abort(jobs.get(job.id) ?? (job as LiveJob), 'client'),
  });
});
