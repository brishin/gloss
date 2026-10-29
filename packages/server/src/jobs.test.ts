import { it } from '@effect/vitest';
import { createFakeModelClient, DiffSources, ModelClient, TourCache } from '@gloss/core';
import type { TourEventBody } from '@gloss/protocol';
import { Effect, Fiber, Layer, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect } from 'vitest';
import { Jobs, type RunTour } from './jobs.ts';

const ref = { kind: 'github-pr' as const, owner: 'o', repo: 'r', number: 1 };
const models = { define: 'a', followup: 'a', notes: 'a' };
const started: TourEventBody = {
  type: 'job.started',
  ref,
  sourceKey: 'k',
  pipelineVersion: '1',
  models,
  cached: false,
};

/** A pipeline that starts, optionally gets past placement, then never finishes. */
const stuck =
  (pastPlacement: boolean): RunTour =>
  () =>
    Stream.make<TourEventBody[]>(
      started,
      ...(pastPlacement ? [{ type: 'groups.resolved', groups: [] } as TourEventBody] : []),
    ).pipe(Stream.concat(Stream.never));

const jobsLayer = (run: RunTour) =>
  Jobs.layer({ run, idleAbortMs: 60_000, retainMs: 600_000 }).pipe(
    Layer.provide(
      Layer.mergeAll(
        TourCache.memory,
        Layer.succeed(ModelClient, createFakeModelClient({ answers: {} })),
        DiffSources.layer,
      ),
    ),
  );

describe('Jobs', () => {
  it.effect('aborts an unwatched job before placement once the idle timeout passes', () =>
    Effect.gen(function* () {
      const jobs = yield* Jobs;
      const job = yield* jobs.start(ref);
      yield* TestClock.adjust(59_000);
      expect(job.state).toBe('running');
      yield* TestClock.adjust(2_000);
      expect(job.state).toBe('aborted');
      expect(job.log.at(-1)).toMatchObject({ type: 'job.aborted', reason: 'no-subscribers' });
    }).pipe(Effect.provide(jobsLayer(stuck(false)))),
  );

  it.effect('lets an unwatched job past placement keep running', () =>
    Effect.gen(function* () {
      const jobs = yield* Jobs;
      const job = yield* jobs.start(ref);
      yield* TestClock.adjust(120_000);
      expect(job.state).toBe('running');
    }).pipe(Effect.provide(jobsLayer(stuck(true)))),
  );

  it.effect('keeps a watched job alive, and supersedes it on force', () =>
    Effect.gen(function* () {
      const jobs = yield* Jobs;
      const first = yield* jobs.start(ref);
      const watcher = yield* Effect.forkChild(Stream.runCollect(jobs.events(first, 0)));
      yield* TestClock.adjust(120_000);
      expect(first.state).toBe('running');
      const second = yield* jobs.start(ref, true);
      expect(second.id).not.toBe(first.id);
      const seen = yield* Fiber.join(watcher);
      expect(seen.map((event) => event.type)).toEqual(['job.started', 'job.aborted']);
      expect(seen.at(-1)).toMatchObject({ reason: 'superseded' });
      expect((yield* jobs.start(ref)).id).toBe(second.id);
    }).pipe(Effect.provide(jobsLayer(stuck(false)))),
  );

  it.effect('forgets a finished job after the retention window', () =>
    Effect.gen(function* () {
      const jobs = yield* Jobs;
      const job = yield* jobs.start(ref);
      yield* jobs.abort(job);
      expect(jobs.get(job.id)).toBeDefined();
      yield* TestClock.adjust(600_001);
      expect(jobs.get(job.id)).toBeUndefined();
    }).pipe(Effect.provide(jobsLayer(stuck(false)))),
  );
});
