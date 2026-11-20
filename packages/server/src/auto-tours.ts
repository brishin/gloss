import { Repos } from '@gloss/core';
import { type RecentTour, serializeRef } from '@gloss/protocol';
import { Cause, Clock, Effect, Layer, Schedule, Stream } from 'effect';
import { Jobs } from './jobs.ts';

export interface AutoToursOptions {
  /** How often to read the review inbox. */
  intervalMs?: number;
  /** PRs with no activity for longer than this are left alone. */
  maxAgeMs?: number;
  /** Wait before the first read, so a server start does not wait on GitHub. */
  startDelayMs?: number;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * The open review requests to tour now: each PR the first time it is seen, and again when its
 * `updatedAt` moves (a push, or any other activity: an unchanged head replays the cached tour at
 * once). Drafts, PRs in the merge queue and PRs idle for longer than `maxAgeMs` are left out.
 * `seen` maps `serializeRef` to the `updatedAt` last toured.
 */
export function dueTours(
  requested: readonly RecentTour[],
  seen: ReadonlyMap<string, string>,
  now: number,
  maxAgeMs: number,
): RecentTour[] {
  return requested.filter(
    (pr) =>
      pr.ref.kind === 'github-pr' &&
      pr.state === 'open' &&
      now - Date.parse(pr.updatedAt) <= maxAgeMs &&
      seen.get(serializeRef(pr.ref)) !== pr.updatedAt,
  );
}

/**
 * Tours every PR that asks for the `gh` login's review in the background, so the tour is ready
 * (cached for its head) when it is opened. Reads the inbox every `intervalMs` and runs one tour
 * at a time, newest PR first. Each tour is an ordinary job: opening the PR while it runs attaches
 * to it. A failed tour is not retried until the PR changes. Lives as long as the layer's scope.
 */
export const autoToursLayer = (options: AutoToursOptions = {}): Layer.Layer<never, never, Jobs | Repos> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const intervalMs = options.intervalMs ?? 5 * MINUTE;
      const maxAgeMs = options.maxAgeMs ?? 7 * DAY;
      const jobs = yield* Jobs;
      const repos = yield* Repos;
      const seen = new Map<string, string>();

      const poll = Effect.gen(function* () {
        const requested = (yield* repos.inbox)?.reviewRequested;
        if (!requested) {
          return;
        }
        const open = new Set(requested.map((pr) => serializeRef(pr.ref)));
        for (const key of seen.keys()) {
          if (!open.has(key)) {
            seen.delete(key);
          }
        }
        for (const pr of dueTours(requested, seen, yield* Clock.currentTimeMillis, maxAgeMs)) {
          seen.set(serializeRef(pr.ref), pr.updatedAt);
          // Following the job keeps it alive (an unwatched job is aborted before placement) and
          // makes the next tour wait for this one.
          const job = yield* jobs.start(pr.ref);
          yield* Stream.runDrain(jobs.events(job, 0));
          yield* Effect.logInfo(`auto tour ${serializeRef(pr.ref)}: ${job.state}`);
        }
      });

      yield* Effect.sleep(options.startDelayMs ?? 10_000).pipe(
        Effect.andThen(
          poll.pipe(
            Effect.catchCause((cause) => Effect.logWarning('auto tours: inbox poll failed', Cause.pretty(cause))),
            Effect.repeat(Schedule.spaced(intervalMs)),
          ),
        ),
        Effect.forkScoped,
      );
    }),
  );
