import {
  createHttpGlossClient,
  DEFAULT_BACKEND_URL,
  type FileContents,
  type GlossClient,
  type Health,
  initialTourState,
  isLoginFinished,
  type LoginMethod,
  type LoginSession,
  type RecentTour,
  reduceTourEvent,
  type ResolvedAsset,
  type SetupStatus,
  type SourceRef,
  type Subscription,
  type Trace,
  type UpdateStatus,
} from '@gloss/protocol';
import { Context, Data, Duration, Effect, Layer, Schedule, Stream } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { settled } from './trace-view.ts';

declare global {
  interface Window {
    /** Injected by the gloss CLI when it serves this app; `backendUrl: ''` means same origin. */
    __GLOSS__?: { backendUrl?: string; token?: string };
  }
}

/** Where the backend is: CLI-injected config, else a build-time env var, else the local default. */
export function backendConfig(): { baseUrl: string; token?: string } {
  const injected = typeof window === 'undefined' ? undefined : window.__GLOSS__;
  return {
    baseUrl: injected?.backendUrl ?? import.meta.env.VITE_GLOSS_BACKEND_URL ?? DEFAULT_BACKEND_URL,
    token: injected?.token ?? import.meta.env.VITE_GLOSS_TOKEN,
  };
}

/** The backend, as the web app's only service: everything else is in the browser. */
export class Gloss extends Context.Service<Gloss, GlossClient>()('@gloss/web/Gloss') {
  static layer = Layer.sync(Gloss, () => createHttpGlossClient(backendConfig()));
}

/** A failed backend call; `cause` is what the client threw. */
export class GlossRequestError extends Data.TaggedError('GlossRequestError')<{ cause: unknown }> {}

/** One backend call as an effect. */
export const request = <A>(f: (client: GlossClient) => Promise<A>) =>
  Gloss.use((client) =>
    Effect.tryPromise({ try: () => f(client), catch: (cause) => new GlossRequestError({ cause }) }),
  );

export const glossRuntime = Atom.runtime(Gloss.layer);

/** Recent tours, newest first; fetched again whenever a page mounts it afresh. */
export const recentToursAtom: Atom.Atom<AsyncResult.AsyncResult<RecentTour[], GlossRequestError>> = glossRuntime.atom(
  request((client) => client.recent()),
);

/** The backend's models and which of their providers are signed in; refresh it after a login. */
export const healthAtom: Atom.Atom<AsyncResult.AsyncResult<Health, GlossRequestError>> = glossRuntime.atom(
  request((client) => client.health()),
);

/** Whether the backend's checkout has newer code; checked on load and every 30 minutes. */
export const updateStatusAtom: Atom.Atom<AsyncResult.AsyncResult<UpdateStatus, unknown>> = glossRuntime.atom(
  Stream.fromEffectSchedule(
    request((client) => client.updateStatus()),
    Schedule.spaced(Duration.minutes(30)),
  ),
);

/**
 * Updates the backend (pull, install, build) and waits, up to two minutes, until it answers
 * again on a commit other than `running`, the one it ran before.
 */
export const updateAtom = glossRuntime.fn((running: string | undefined) =>
  Effect.gen(function* () {
    yield* request((client) => client.update());
    for (let attempt = 0; attempt < 120; attempt++) {
      yield* Effect.sleep(Duration.seconds(1));
      const health = yield* request((client) => client.health()).pipe(Effect.orElseSucceed(() => undefined));
      if (health && health.commit !== running) {
        return;
      }
    }
    return yield* new GlossRequestError({
      cause: new Error('gloss did not come back after the update; see ~/.gloss/serve.log'),
    });
  }),
);

/**
 * A provider login, written `{ subscription, method }` to start one: starts it on the backend,
 * then polls it until it ends. Resetting the atom (or starting another) cancels it there.
 */
export const loginAtom = glossRuntime.fn((start: { subscription: Subscription; method: LoginMethod }) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const first = yield* Effect.acquireRelease(
        request((client) => client.startLogin(start.subscription, start.method)),
        // A no-op on the backend once the login has ended.
        (session) => Effect.ignore(request((client) => client.cancelLogin(session.id))),
      );
      // The first poll runs at once, so the stream starts with the login's current state.
      return Stream.fromEffectSchedule(
        request((client) => client.login(first.id)),
        Schedule.spaced(Duration.millis(750)),
      ).pipe(Stream.takeUntil((session: LoginSession) => isLoginFinished(session)));
    }),
  ),
);

/** Answers the running login's current question. */
export const answerLoginAtom = glossRuntime.fn((answer: { loginId: string; promptId: number; value: string }) =>
  request((client) => client.answerLogin(answer.loginId, answer.promptId, answer.value)),
);

/** GitHub, the extension's native host and the extension's folder, as the setup page shows them. */
export const setupAtom: Atom.Atom<AsyncResult.AsyncResult<SetupStatus, GlossRequestError>> = glossRuntime.atom(
  request((client) => client.setup()),
);

/** Starts `gh auth login --web` on the backend: the code to enter on GitHub. */
export const githubLoginAtom = glossRuntime.fn(() => request((client) => client.githubLogin()));

/** Registers the extension's native host, so its button can start the server. */
export const installNativeHostAtom = glossRuntime.fn(() => request((client) => client.installNativeHost()));

/**
 * Saves a Jev key on the backend, which then restarts; succeeds once the restarted backend
 * reports Jev (up to 30s).
 */
export const saveJudgeKeyAtom = glossRuntime.fn((key: string) =>
  Effect.gen(function* () {
    yield* request((client) => client.saveJudgeKey(key));
    yield* request((client) => client.health()).pipe(
      Effect.filterOrFail(
        (health) => health.judge.available,
        () => new GlossRequestError({ cause: 'Jev is not available yet' }),
      ),
      Effect.retry({ schedule: Schedule.spaced(Duration.seconds(1)), times: 30 }),
    );
  }),
);

/**
 * Whether the gloss extension with id `id` answers in this browser. Chrome gives a page
 * `chrome.runtime` only when an extension lists its origin in `externally_connectable`.
 */
export function pingExtension(id: string): Promise<boolean> {
  const runtime = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime;
  if (!runtime?.sendMessage) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      runtime.sendMessage(id, { type: 'ping' }, (reply) => {
        void runtime.lastError;
        resolve(!!reply);
      });
    } catch {
      resolve(false);
    }
  });
}

interface ChromeRuntime {
  lastError?: unknown;
  sendMessage(id: string, message: unknown, reply: (response: unknown) => void): void;
}

/** Whether the extension `id` is loaded, checked every 2s until it is. */
export const extensionAtom = Atom.family((id: string) =>
  glossRuntime.atom(
    Stream.fromEffectSchedule(
      Effect.promise(() => pingExtension(id)),
      Schedule.spaced(Duration.seconds(2)),
    ).pipe(Stream.takeUntil((found) => found)),
  ),
);

/** A GitHub attachment resolved to a short-lived URL the browser can load. */
export const assetAtom = Atom.family((src: string) =>
  glossRuntime.atom(request((client): Promise<ResolvedAsset> => client.asset(src))),
);

/** A tour's pipeline trace, with what the tour's events say about the run around it. */
export interface Pipeline {
  trace: Trace;
  title?: string;
  /** The run replayed a cached tour. */
  cached: boolean;
  /** A fatal error, e.g. the diff could not be fetched before any step ran. */
  error?: { message: string; stage?: string };
  /** The run was stopped (or superseded) before it finished. */
  stopped: boolean;
}

/**
 * The pipeline debug view (keyed by `JSON.stringify({ ref, jobId })`): follows the tour's own
 * job, so a failed or stopped run shows its trace. Without one, or once it has expired, it
 * attaches to the ref's tour (or starts it, as opening the tour would). The trace is fetched
 * again whenever the job's events settle, so running steps fill in.
 */
export const pipelineAtom = Atom.family((key: string) =>
  glossRuntime.atom(
    Stream.unwrap(
      Effect.gen(function* () {
        const { ref, jobId: asked } = JSON.parse(key) as { ref: SourceRef; jobId?: string };
        const kept = asked
          ? yield* request((client) => client.trace(asked)).pipe(
              Effect.as(asked),
              Effect.orElseSucceed(() => undefined),
            )
          : undefined;
        const jobId = kept ?? (yield* request((client) => client.startTour(ref))).jobId;
        const client = yield* Gloss;
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (controller) => Effect.sync(() => controller.abort()),
        );
        const states = Stream.fromAsyncIterable(
          client.events(jobId, { signal: controller.signal }),
          (cause) => new GlossRequestError({ cause }),
        ).pipe(Stream.scan(initialTourState, reduceTourEvent), Stream.debounce(Duration.millis(200)));
        return states.pipe(
          Stream.mapEffect((state) =>
            request((client) => client.trace(jobId)).pipe(
              Effect.map((trace): Pipeline => ({
                trace: settled(trace),
                title: state.meta?.title,
                cached: state.cached,
                stopped: state.status === 'aborted',
                error: state.error,
              })),
            ),
          ),
        );
      }),
    ),
  ),
);
/**
 * A changed file in full, keyed by `JSON.stringify({ diffId, fileId })`. pierre asks for it
 * the first time the reviewer expands unchanged lines in the file, and keeps what it gets.
 */
export const fileContentsAtom = Atom.family((key: string) =>
  glossRuntime.atom(
    request((client): Promise<FileContents> => {
      const { diffId, fileId } = JSON.parse(key) as { diffId: string; fileId: string };
      return client.fileContents(diffId, fileId);
    }),
  ),
);
