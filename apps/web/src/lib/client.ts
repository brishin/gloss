import {
  createHttpGlossClient,
  DEFAULT_BACKEND_URL,
  type GlossClient,
  initialTourState,
  type RecentTour,
  reduceTourEvent,
  type ResolvedAsset,
  type SourceRef,
  type Trace,
} from '@gloss/protocol';
import { Context, Data, Duration, Effect, Layer, Stream } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';

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

/** A GitHub attachment resolved to a short-lived URL the browser can load. */
export const assetAtom = Atom.family((src: string) =>
  glossRuntime.atom(request((client): Promise<ResolvedAsset> => client.asset(src))),
);

/** A tour's pipeline trace, and the change's title once the tour has said it. */
export interface Pipeline {
  trace: Trace;
  title?: string;
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
              Effect.map((trace): Pipeline => ({ trace, title: state.meta?.title })),
            ),
          ),
        );
      }),
    ),
  ),
);
