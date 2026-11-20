import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from '@effect/vitest';
import { createFakeModelClient, DiffSources, type Inbox, ModelClient, RepoClones, Repos, TourCache } from '@gloss/core';
import type { RecentTour, SourceRef, TourEventBody } from '@gloss/protocol';
import { Effect, Layer, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, test } from 'vitest';
import { autoToursLayer, dueTours } from './auto-tours.ts';
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

const started = (ref: SourceRef): TourEventBody => ({
  type: 'job.started',
  ref,
  sourceKey: 'k',
  pipelineVersion: '1',
  models: { define: 'a', followup: 'a', notes: 'a' },
  cached: false,
});

describe('autoToursLayer', () => {
  it.effect('tours each review request once, one at a time, and again when it changes', () => {
    const toured: number[] = [];
    let running = 0;
    let most = 0;
    // Each tour takes a minute of test time and is never watched, so only the poller keeps it alive.
    const run: RunTour = ({ ref }) =>
      Stream.make(started(ref)).pipe(
        Stream.concat(
          Stream.fromEffect(
            Effect.gen(function* () {
              running += 1;
              most = Math.max(most, running);
              yield* Effect.sleep(60_000);
              running -= 1;
              toured.push((ref as { number: number }).number);
              return { type: 'job.error', code: 'internal', message: 'done', fatal: true } as TourEventBody;
            }),
          ),
        ),
      );
    let inbox: Inbox = { reviewRequested: [pr(1), pr(2), pr(3, { state: 'draft' })], authored: [pr(4)] };
    const repos = Layer.succeed(Repos, {
      inbox: Effect.sync(() => inbox),
    } as unknown as Repos['Service']);
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
    const layer = autoToursLayer({ intervalMs: 5 * 60_000, startDelayMs: 0, maxAgeMs: Infinity }).pipe(
      Layer.provide(Layer.mergeAll(jobs, repos)),
    );
    return Effect.gen(function* () {
      yield* TestClock.adjust(1);
      yield* TestClock.adjust(60_000);
      expect(toured).toEqual([1]);
      yield* TestClock.adjust(60_000);
      expect(toured).toEqual([1, 2]);
      expect(most).toBe(1);
      // The next poll finds nothing new; then #2 is pushed to.
      yield* TestClock.adjust(5 * 60_000);
      expect(toured).toEqual([1, 2]);
      inbox = { ...inbox, reviewRequested: [pr(2, { updatedAt: new Date(NOW).toISOString() }), pr(1)] };
      yield* TestClock.adjust(5 * 60_000);
      yield* TestClock.adjust(60_000);
      expect(toured).toEqual([1, 2, 2]);
    }).pipe(Effect.provide(layer));
  });
});
