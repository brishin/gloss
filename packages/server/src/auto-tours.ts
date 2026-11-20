import { Repos } from '@gloss/core';
import { type RecentTour, serializeRef } from '@gloss/protocol';
import { Cause, Clock, Context, Effect, Fiber, Layer, Stream } from 'effect';
import { Jobs } from './jobs.ts';

export interface AutoToursOptions {
  /** Whether the background tours start switched on (the saved choice). */
  enabled: boolean;
  /** Saves a change of the switch. */
  save?: (enabled: boolean) => void;
  /** The longest the review inbox goes unread; a pushed PR shows up no later than this. */
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
 * Tours every PR that asks for the `gh` login's review in the background while it is switched
 * on, so the tour is ready (cached for its head) when it is opened. Looks at the notifications
 * as often as GitHub allows (a minute; an unchanged answer is free) and reads the inbox when they
 * change, so a new review request is toured within about a minute. GitHub sends no notification
 * for a push, so the inbox is also read every `intervalMs`. Runs one tour at a time, newest first. Each tour is an ordinary job:
 * opening the PR while it runs attaches to it. A failed tour is not retried until the PR changes.
 * Switching it off stops following the current tour, which then runs on only if it is past
 * placement or someone watches it (see `Jobs`).
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

const makeAutoTours = Effect.fnUntraced(function* (options: AutoToursOptions) {
  const intervalMs = options.intervalMs ?? 5 * MINUTE;
  const maxAgeMs = options.maxAgeMs ?? 7 * DAY;
  const jobs = yield* Jobs;
  const repos = yield* Repos;
  const scope = yield* Effect.scope;
  const seen = new Map<string, string>();
  let enabled = options.enabled;
  let loop: Fiber.Fiber<void> | undefined;

  const tour = (pr: RecentTour) =>
    Effect.gen(function* () {
      const key = serializeRef(pr.ref);
      seen.set(key, pr.updatedAt);
      // Following the job keeps it alive (an unwatched job is aborted before placement) and
      // makes the next tour wait for this one.
      const job = yield* jobs.start(pr.ref);
      yield* Stream.runDrain(jobs.events(job, 0));
      yield* Effect.logInfo(`auto tour ${key}: ${job.state}`);
    }).pipe(
      // Switched off mid-tour: switching it on again tours the PR again.
      Effect.onInterrupt(() => Effect.sync(() => seen.delete(serializeRef(pr.ref)))),
    );

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
      yield* tour(pr);
    }
  });

  /**
   * Looks at the notifications, reads the inbox when they changed or `intervalMs` has passed,
   * then waits as long as GitHub asks. Without notifications (no `gh`, or an error) it waits a
   * minute and still reads the inbox every `intervalMs`.
   */
  const watch = Effect.gen(function* () {
    let since: string | undefined;
    let lastRead = -Infinity;
    while (true) {
      const check = yield* repos.notifications(since);
      since = check?.lastModified ?? since;
      const now = yield* Clock.currentTimeMillis;
      if (check?.changed || now - lastRead >= intervalMs) {
        lastRead = now;
        yield* poll.pipe(
          Effect.catchCause((cause) => Effect.logWarning('auto tours: inbox poll failed', Cause.pretty(cause))),
        );
      }
      yield* Effect.sleep(check?.pollMs ?? MINUTE);
    }
  });

  const start = (delayMs: number) =>
    Effect.gen(function* () {
      loop = yield* Effect.sleep(delayMs).pipe(Effect.andThen(watch), Effect.asVoid, Effect.forkIn(scope));
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
