import {
  createHttpGlossClient,
  DEFAULT_BACKEND_URL,
  type GlossClient,
  type RecentTour,
  type ResolvedAsset,
} from '@gloss/protocol';
import { Context, Data, Effect, Layer } from 'effect';
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
