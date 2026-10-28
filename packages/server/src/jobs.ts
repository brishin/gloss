import { randomUUID } from 'node:crypto';
import type { JudgeClient, ModelClient, CacheStore } from '@gloss/core';
import { createSource, isAbortError, PipelineError, runTour } from '@gloss/core';
import type { SourceRef, TourEvent, TourEventBody } from '@gloss/protocol';
import { isTerminal, serializeRef } from '@gloss/protocol';

export type JobState = 'running' | 'complete' | 'failed' | 'aborted';

type Listener = (event: TourEvent) => void;

export interface Job {
  readonly id: string;
  readonly key: string;
  readonly ref: SourceRef;
  readonly log: TourEvent[];
  state: JobState;
  finishedAt?: number;
  /** Set once placement is done: the expensive part is paid for, so an unwatched job still finishes and caches. */
  pastPlacement: boolean;
  readonly listeners: Set<Listener>;
  readonly controller: AbortController;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export interface JobManagerOptions {
  cache: CacheStore;
  model: ModelClient;
  judge?: JudgeClient;
  /** How long a finished job stays replayable. */
  retainMs?: number;
  /** How long a running job may have no subscriber before it is aborted. */
  idleAbortMs?: number;
  /** Injection point for tests. */
  run?: typeof runTour;
}

/**
 * Owns tour jobs: one running job per ref (two tabs share it), an in-memory event log
 * per job so a subscriber can replay from any `seq`, and abort on request or when
 * nobody is watching an early-stage job.
 */
export class JobManager {
  readonly #jobs = new Map<string, Job>();
  readonly #running = new Map<string, Job>();
  readonly #options: JobManagerOptions;

  constructor(options: JobManagerOptions) {
    this.#options = options;
  }

  get(jobId: string): Job | undefined {
    return this.#jobs.get(jobId);
  }

  /** Attaches to the running job for `ref`, or starts one. `force` replaces a running job and skips cache reads. */
  start(ref: SourceRef, force = false): Job {
    const key = serializeRef(ref);
    const existing = this.#running.get(key);
    if (existing && !force) {
      return existing;
    }
    if (existing) {
      this.#abort(existing, 'superseded');
    }
    const job: Job = {
      id: randomUUID(),
      key,
      ref,
      log: [],
      state: 'running',
      pastPlacement: false,
      listeners: new Set(),
      controller: new AbortController(),
    };
    this.#jobs.set(job.id, job);
    this.#running.set(key, job);
    this.#armIdleAbort(job);
    void this.#execute(job, force);
    return job;
  }

  /** Replays events after `after`, then delivers live ones. Returns an unsubscribe function. */
  subscribe(job: Job, after: number, listener: Listener): () => void {
    for (const event of job.log) {
      if (event.seq > after) {
        listener(event);
      }
    }
    if (job.state !== 'running') {
      return () => {};
    }
    job.listeners.add(listener);
    clearTimeout(job.idleTimer);
    return () => {
      job.listeners.delete(listener);
      this.#armIdleAbort(job);
    };
  }

  abort(job: Job): void {
    this.#abort(job, 'client');
  }

  /** Aborts every running job (server shutdown). */
  abortAll(): void {
    for (const job of this.#running.values()) {
      this.#abort(job, 'client');
    }
  }

  #emit(job: Job, body: TourEventBody) {
    if (job.state !== 'running') {
      return;
    }
    const event = { seq: job.log.length + 1, jobId: job.id, at: new Date().toISOString(), ...body } as TourEvent;
    job.log.push(event);
    if (body.type === 'groups.resolved') {
      job.pastPlacement = true;
    }
    if (isTerminal(body)) {
      job.state = body.type === 'tour.complete' ? 'complete' : body.type === 'job.aborted' ? 'aborted' : 'failed';
      this.#finish(job);
    }
    for (const listener of job.listeners) {
      listener(event);
    }
    if (job.state !== 'running') {
      job.listeners.clear();
    }
  }

  async #execute(job: Job, force: boolean) {
    const { cache, model, judge } = this.#options;
    const run = this.#options.run ?? runTour;
    try {
      await run({
        ref: job.ref,
        source: createSource(job.ref),
        cache,
        model,
        judge,
        force,
        signal: job.controller.signal,
        emit: (event) => this.#emit(job, event),
      });
    } catch (error) {
      if (job.controller.signal.aborted || isAbortError(error)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.#emit(job, {
        type: 'job.error',
        stage: error instanceof PipelineError ? error.stage : undefined,
        code: error instanceof PipelineError ? error.code : 'internal',
        message,
        fatal: true,
      });
    }
  }

  #abort(job: Job, reason: 'client' | 'no-subscribers' | 'superseded') {
    if (job.state !== 'running') {
      return;
    }
    this.#emit(job, { type: 'job.aborted', reason });
    job.controller.abort(new DOMException(`Tour aborted: ${reason}`, 'AbortError'));
  }

  #armIdleAbort(job: Job) {
    const idleMs = this.#options.idleAbortMs ?? 60_000;
    clearTimeout(job.idleTimer);
    if (job.state !== 'running' || job.listeners.size > 0) {
      return;
    }
    job.idleTimer = setTimeout(() => {
      if (job.listeners.size === 0 && !job.pastPlacement) {
        this.#abort(job, 'no-subscribers');
      }
    }, idleMs);
    job.idleTimer.unref?.();
  }

  #finish(job: Job) {
    clearTimeout(job.idleTimer);
    job.finishedAt = Date.now();
    if (this.#running.get(job.key) === job) {
      this.#running.delete(job.key);
    }
    const timer = setTimeout(() => this.#jobs.delete(job.id), this.#options.retainMs ?? 10 * 60_000);
    timer.unref?.();
  }
}
