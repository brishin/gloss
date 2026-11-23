import { type Inbox, Repos } from '@gloss/core';
import { type RecentTour, serializeRef } from '@gloss/protocol';
import { Cause, Clock, Context, Effect, Fiber, Layer, Stream } from 'effect';
import { Jobs } from './jobs.ts';

export interface AutoToursOptions {
  /** Whether the background tours start switched on (the saved choice). */
  enabled: boolean;
  /** Saves a change of the switch. */
  save?: (enabled: boolean) => void;
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
 * The PRs the background tours follow: the open review requests, then the open PRs by others
 * already reviewed (a push after a review no longer asks for it, but is the next thing read).
 */
export function watchedPrs(inbox: Inbox): RecentTour[] {
  const requested = new Set(inbox.reviewRequested.map((pr) => serializeRef(pr.ref)));
  return [...inbox.reviewRequested, ...inbox.reviewed.filter((pr) => !requested.has(serializeRef(pr.ref)))];
}

/**
 * The watched PRs to tour now: each PR the first time it is seen, and again when its
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
 * Tours every PR that asks for the `gh` login's review, or that they reviewed and is still open
 * (see `watchedPrs`), in the background while it is switched on, so the tour is ready (cached for its head) when it is opened. Reads the inbox every
 * `intervalMs`, on its own schedule, into a queue in the inbox's order (review requests first,
 * each list most recently updated first), so a new request goes ahead of an older backlog. A worker tours the queue one PR at a
 * time, and only while no other tour runs: a tour you open always goes first. Each tour is an
 * ordinary job: opening the PR while it runs attaches to it. A failed tour is not retried until
 * the PR changes. Switching it off stops following the current tour, which then runs on only if
 * it is past placement or someone watches it (see `Jobs`).
 */
export class AutoTours extends Context.Service<
  AutoTours,
  {
    readonly enabled: Effect.Effect<boolean>;
    /** Switches the background tours on or off, and saves the choice. */
    set(enabled: boolean): Effect.Effect<void>;
  }
>()('@gloss/server/AutoTours') {
  static layer(options: AutoToursOptions): Layer.Layer<AutoTours, never, Jobs | Repos> {
    return Layer.effect(AutoTours, makeAutoTours(options));
  }
}

/** How often the idle worker looks for queued PRs, and for other tours to finish. */
const WORKER_TICK_MS = 5_000;

const makeAutoTours = Effect.fnUntraced(function* (options: AutoToursOptions) {
  const intervalMs = options.intervalMs ?? 5 * MINUTE;
  const maxAgeMs = options.maxAgeMs ?? 7 * DAY;
  const jobs = yield* Jobs;
  const repos = yield* Repos;
  const scope = yield* Effect.scope;
  /** `serializeRef` to the `updatedAt` last toured. */
  const seen = new Map<string, string>();
  /** The PRs to tour, most recently updated first, as the last inbox read had them. */
  let queue: RecentTour[] = [];
  let enabled = options.enabled;
  let loop: Fiber.Fiber<void> | undefined;

  const tour = (pr: RecentTour) =>
    Effect.gen(function* () {
      const key = serializeRef(pr.ref);
      seen.set(key, pr.updatedAt);
      // Following the job keeps it alive (an unwatched job is aborted before placement) and
      // makes the next tour wait for this one.
      const asked = Date.now();
      const job = yield* jobs.start(pr.ref);
      yield* Stream.runDrain(jobs.events(job, 0));
      yield* Effect.logInfo(`auto tour ${key}: ${job.state}`);
      // A job already running (opened in a tab) may be for an older head than this update, so
      // look again next time; an unchanged head replays its cached tour at once.
      const first = job.log[0];
      if (first && Date.parse(first.at) < asked) {
        seen.delete(key);
      }
    }).pipe(
      // Switched off mid-tour: switching it on again tours the PR again.
      Effect.onInterrupt(() => Effect.sync(() => seen.delete(serializeRef(pr.ref)))),
    );

  const discover = Effect.gen(function* () {
    const inbox = yield* repos.inbox;
    if (!inbox) {
      return;
    }
    const watched = watchedPrs(inbox);
    const open = new Set(watched.map((pr) => serializeRef(pr.ref)));
    for (const key of seen.keys()) {
      if (!open.has(key)) {
        seen.delete(key);
      }
    }
    queue = dueTours(watched, seen, yield* Clock.currentTimeMillis, maxAgeMs);
  });

  const read = discover.pipe(
    Effect.catchCause((cause) => Effect.logWarning('auto tours: inbox read failed', Cause.pretty(cause))),
  );

  /** Tours the head of the queue whenever no other tour is running. */
  const work = Effect.gen(function* () {
    while (true) {
      const next = queue[0];
      if (!next || jobs.running().length > 0) {
        yield* Effect.sleep(WORKER_TICK_MS);
        continue;
      }
      queue = queue.slice(1);
      yield* tour(next);
    }
  });

  const start = (delayMs: number) =>
    Effect.gen(function* () {
      queue = [];
      loop = yield* Effect.sleep(delayMs).pipe(
        Effect.andThen(read),
        Effect.andThen(
          Effect.all([Effect.sleep(intervalMs).pipe(Effect.andThen(read), Effect.forever), work], {
            concurrency: 2,
            discard: true,
          }),
        ),
        Effect.asVoid,
        Effect.forkIn(scope),
      );
    });

  if (enabled) {
    yield* start(options.startDelayMs ?? 10_000);
  }

  return AutoTours.of({
    enabled: Effect.sync(() => enabled),
    set: (next) =>
      Effect.gen(function* () {
        if (next !== enabled) {
          yield* Effect.sync(() => options.save?.(next));
          enabled = next;
          if (loop) {
            yield* Fiber.interrupt(loop);
            loop = undefined;
          }
          if (next) {
            yield* start(0);
          }
        }
      }),
  });
});
