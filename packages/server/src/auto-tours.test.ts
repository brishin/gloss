import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from '@effect/vitest';
import { createFakeModelClient, DiffSources, type Inbox, ModelClient, RepoClones, Repos, TourCache } from '@gloss/core';
import type { RecentTour, SourceRef, TourEventBody } from '@gloss/protocol';
import { Effect, Layer, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, test } from 'vitest';
import { AutoTours, dueTours, watchedPrs } from './auto-tours.ts';
import { Jobs, type RunTour } from './jobs.ts';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const DAY = 24 * 60 * 60_000;

const pr = (number: number, patch: Partial<RecentTour> = {}): RecentTour => ({
  ref: { kind: 'github-pr', owner: 'o', repo: 'r', number },
  title: `#${number}`,
  state: 'open',
  updatedAt: new Date(NOW - 60_000).toISOString(),
  ...patch,
});

describe('dueTours', () => {
  test.each([
    ['an open PR not seen before', pr(1), new Map(), true],
    ['an open PR seen at the same update', pr(1), new Map([['github:o/r#1', pr(1).updatedAt]]), false],
    ['an open PR updated since it was seen', pr(1), new Map([['github:o/r#1', '2026-11-19T00:00:00Z']]), true],
    ['a draft', pr(1, { state: 'draft' }), new Map(), false],
    ['a PR in the merge queue', pr(1, { state: 'queued' }), new Map(), false],
    [
      'a PR idle for longer than the max age',
      pr(1, { updatedAt: new Date(NOW - 8 * DAY).toISOString() }),
      new Map(),
      false,
    ],
  ])('%s', (_, tour, seen, due) => {
    expect(dueTours([tour], seen, NOW, 7 * DAY)).toEqual(due ? [tour] : []);
  });
});

describe('watchedPrs', () => {
  test('follows review requests first, then PRs already reviewed, each once', () => {
    const inbox: Inbox = { reviewRequested: [pr(2), pr(1)], reviewed: [pr(3), pr(1)], authored: [pr(4)] };
    expect(watchedPrs(inbox).map((tour) => (tour.ref as { number: number }).number)).toEqual([2, 1, 3]);
  });
});

const started = (ref: SourceRef): TourEventBody => ({
  type: 'job.started',
  ref,
  sourceKey: 'k',
  pipelineVersion: '1',
  models: { define: 'a', followup: 'a', notes: 'a' },
  cached: false,
});

/** A review inbox of #1, #2 and a draft #3, and tours that take `tourMs` of test time each and are never watched. */
function harness(enabled: boolean, tourMs = 60_000) {
  const toured: number[] = [];
  const saved: boolean[] = [];
  const state = { running: 0, most: 0 };
  const run: RunTour = ({ ref }) =>
    Stream.make(started(ref)).pipe(
      Stream.concat(
        Stream.fromEffect(
          Effect.gen(function* () {
            state.running += 1;
            state.most = Math.max(state.most, state.running);
            yield* Effect.sleep(tourMs).pipe(Effect.ensuring(Effect.sync(() => (state.running -= 1))));
            toured.push((ref as { number: number }).number);
            return { type: 'job.error', code: 'internal', message: 'done', fatal: true } as TourEventBody;
          }),
        ),
      ),
    );
  const box = {
    inbox: { reviewRequested: [pr(1), pr(2), pr(3, { state: 'draft' })], reviewed: [], authored: [pr(4)] } as Inbox,
  };
  const repos = Layer.succeed(Repos, { inbox: Effect.sync(() => box.inbox) } as unknown as Repos['Service']);
  const jobs = Jobs.layer({ run, idleAbortMs: 1_000 }).pipe(
    Layer.provide(
      Layer.mergeAll(
        TourCache.memory,
        Layer.succeed(ModelClient, createFakeModelClient({ answers: {} })),
        DiffSources.layer,
        RepoClones.layer(join(tmpdir(), 'gloss-test-clones')),
      ),
    ),
  );
  const layer = AutoTours.layer({
    enabled,
    save: (on) => saved.push(on),
    intervalMs: 5 * 60_000,
    startDelayMs: 0,
    maxAgeMs: Infinity,
  }).pipe(Layer.provideMerge(Layer.mergeAll(jobs, repos)));
  return { toured, saved, state, box, layer };
}

describe('AutoTours', () => {
  it.effect('tours each review request once, one at a time, and again when it changes', () => {
    const { toured, state, box, layer } = harness(true);
    return Effect.gen(function* () {
      yield* TestClock.adjust(1);
      yield* TestClock.adjust(60_000);
      expect(toured).toEqual([1]);
      yield* TestClock.adjust(60_000);
      expect(toured).toEqual([1, 2]);
      expect(state.most).toBe(1);
      // The next poll finds nothing new; then #2 is pushed to.
      yield* TestClock.adjust(5 * 60_000);
      expect(toured).toEqual([1, 2]);
      box.inbox = { ...box.inbox, reviewRequested: [pr(2, { updatedAt: new Date(NOW).toISOString() }), pr(1)] };
      yield* TestClock.adjust(5 * 60_000);
      yield* TestClock.adjust(60_000);
      expect(toured).toEqual([1, 2, 2]);
    }).pipe(Effect.provide(layer));
  });

  it.effect('tours a push to a PR already reviewed, which no longer asks for review', () => {
    const { toured, box, layer } = harness(true);
    return Effect.gen(function* () {
      yield* TestClock.adjust(1);
      yield* TestClock.adjust(2 * 60_000);
      expect(toured).toEqual([1, 2]);
      // #2 is reviewed, so GitHub drops the request; then its author pushes.
      box.inbox = {
        ...box.inbox,
        reviewRequested: [pr(1)],
        reviewed: [pr(2, { updatedAt: new Date(NOW).toISOString() })],
      };
      yield* TestClock.adjust(5 * 60_000);
      yield* TestClock.adjust(60_000);
      expect(toured).toEqual([1, 2, 2]);
    }).pipe(Effect.provide(layer));
  });

  it.effect('puts a new request ahead of the backlog', () => {
    const { toured, box, layer } = harness(true, 4 * 60_000);
    return Effect.gen(function* () {
      box.inbox = { ...box.inbox, reviewRequested: [pr(1), pr(2), pr(6)] };
      yield* TestClock.adjust(1);
      // #1 runs from 0 to 4 min and #2 from 4 to 8; #5 comes in before the read at 5 min.
      yield* TestClock.adjust(60_000);
      box.inbox = { ...box.inbox, reviewRequested: [pr(5), pr(1), pr(2), pr(6)] };
      yield* TestClock.adjust(16 * 60_000);
      expect(toured).toEqual([1, 2, 5, 6]);
    }).pipe(Effect.provide(layer));
  });

  it.effect('waits while a tour someone opened runs', () => {
    const { toured, state, layer } = harness(false);
    return Effect.gen(function* () {
      const jobs = yield* Jobs;
      const opened = yield* jobs.start(pr(9).ref);
      yield* Stream.runDrain(jobs.events(opened, 0)).pipe(Effect.forkChild);
      yield* (yield* AutoTours).set(true);
      yield* TestClock.adjust(1);
      yield* TestClock.adjust(60_000);
      expect(toured).toEqual([9]);
      yield* TestClock.adjust(3 * 60_000);
      expect(toured).toEqual([9, 1, 2]);
      expect(state.most).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect('tours nothing while off, starts at once when switched on, and stops when switched off', () => {
    const { toured, saved, state, layer } = harness(false);
    return Effect.gen(function* () {
      const auto = yield* AutoTours;
      yield* TestClock.adjust(10 * 60_000);
      expect(toured).toEqual([]);
      yield* auto.set(true);
      expect(yield* auto.enabled).toBe(true);
      yield* TestClock.adjust(1);
      yield* TestClock.adjust(60_000);
      expect(toured).toEqual([1]);
      // Off while #2 runs: it is no longer followed, so the idle timeout aborts it.
      yield* auto.set(false);
      yield* TestClock.adjust(10 * 60_000);
      expect(toured).toEqual([1]);
      expect(state.running).toBe(0);
      expect(saved).toEqual([true, false]);
    }).pipe(Effect.provide(layer));
  });
});
