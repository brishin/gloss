import * as v from 'valibot';
import { type AskEvent, type AskRequest, parseAskEvent } from './ask.ts';
import { type ResolvedAsset, ResolvedAssetSchema } from './asset.ts';
import { parseSseStream } from './codec.ts';
import type { DiffPayload, FileContents } from './diff.ts';
import { DiffPayloadSchema, FileContentsSchema } from './diff.ts';
import { isTerminal, type TourEvent } from './events.ts';
import {
  type LoginMethod,
  type LoginSession,
  LoginSessionSchema,
  ProviderLoginSchema,
  type Subscription,
} from './login.ts';
import { type ReviewRequest, type ReviewResult, ReviewResultSchema } from './review.ts';
import { type GithubLogin, GithubLoginSchema, type SetupStatus, SetupStatusSchema } from './setup.ts';
import type { SourceRef } from './source-ref.ts';
import { SourceRefSchema } from './source-ref.ts';
import { PullStateSchema, type Stack, StackNameSchema, StackSchema } from './stack.ts';
import { type Trace, TraceSchema } from './trace.ts';
import { type UpdateStatus, UpdateStatusSchema } from './update.ts';

export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:4777';

export const StartTourResponseSchema = v.object({
  jobId: v.string(),
  state: v.picklist(['running', 'complete', 'failed', 'aborted']),
  lastSeq: v.number(),
});
export type StartTourResponse = v.InferOutput<typeof StartTourResponseSchema>;

export const HealthSchema = v.object({
  version: v.string(),
  /** The git commit the server runs, when it runs from a checkout. */
  commit: v.optional(v.string()),
  pipelineVersion: v.string(),
  judge: v.object({ available: v.boolean(), model: v.optional(v.string()) }),
  models: v.object({ define: v.string(), followup: v.string(), notes: v.string() }),
  providers: v.array(
    v.object({
      id: v.string(),
      configured: v.boolean(),
      source: v.optional(v.string()),
      /** Set when the app can sign this provider in (`startLogin`). */
      login: v.optional(ProviderLoginSchema),
    }),
  ),
});
export type Health = v.InferOutput<typeof HealthSchema>;

export const RecentTourSchema = v.object({
  ref: SourceRefSchema,
  title: v.string(),
  /** The PR author's GitHub login (PRs only). */
  author: v.optional(v.string()),
  /** The PR's state on GitHub now (PRs only; missing when GitHub won't say). */
  state: v.optional(PullStateSchema),
  /** The stack the PR sat in when the app last asked for it, with each member's state as of now (PRs only). */
  stack: v.optional(StackSchema),
  updatedAt: v.string(),
});
export type RecentTour = v.InferOutput<typeof RecentTourSchema>;

export const RecentToursSchema = v.object({
  /** The backend's GitHub login, so the app can tell the user's PRs from others'. */
  viewer: v.optional(v.string()),
  tours: v.array(RecentTourSchema),
  /** Open PRs waiting on the viewer's review, newest first; missing when GitHub won't say. */
  reviewRequested: v.optional(v.array(RecentTourSchema)),
  /** The viewer's open PRs, newest first; missing when GitHub won't say. */
  authored: v.optional(v.array(RecentTourSchema)),
});
export type RecentTours = v.InferOutput<typeof RecentToursSchema>;

/**
 * Everything a frontend may ask a gloss backend. The HTTP implementation below works
 * against the local CLI server today and a remote one later (base URL + bearer token).
 */
export interface GlossClient {
  startTour(ref: SourceRef, options?: { force?: boolean }): Promise<StartTourResponse>;
  /** Replays the job's log after `after`, then follows it live until a terminal event. */
  events(jobId: string, options?: { after?: number; signal?: AbortSignal }): AsyncIterable<TourEvent>;
  abort(jobId: string): Promise<void>;
  /** Asks the model that wrote a finished tour about it; the answer streams until done or failed. Abort to stop it. */
  ask(request: AskRequest, options?: { signal?: AbortSignal }): AsyncIterable<AskEvent>;
  diff(diffId: string): Promise<DiffPayload>;
  /** What each pipeline step of the job read and returned, for the pipeline debug view. */
  trace(jobId: string): Promise<Trace>;
  /** One changed file of a diff in full, for expanding the unchanged lines around its hunks. */
  fileContents(diffId: string, fileId: string): Promise<FileContents>;
  /** A Git LFS object the diff names, such as one side of a changed image. */
  lfsObject(diffId: string, oid: string): Promise<Blob>;
  health(): Promise<Health>;
  recent(): Promise<RecentTours>;
  /** Resolves a GitHub attachment URL (see `isGithubAssetUrl`) to one the browser can load. */
  asset(url: string): Promise<ResolvedAsset>;
  /** The stack a GitHub PR sits in (a stack of one when it has no neighbours). */
  stack(ref: Extract<SourceRef, { kind: 'github-pr' }>): Promise<Stack>;
  /** A short name for a stack of two or more PRs, from its titles, branches and descriptions (cached on the backend). */
  stackName(stack: Stack): Promise<string>;
  /** Submits a GitHub review (approve, request changes, or comment) as the backend's `gh` login. */
  review(review: ReviewRequest): Promise<ReviewResult>;
  /** Starts signing a provider in on the backend (replacing any login already running for it). */
  startLogin(subscription: Subscription, method: LoginMethod): Promise<LoginSession>;
  /** The login's current state: the page to open, the question it waits on, or how it ended. */
  login(loginId: string): Promise<LoginSession>;
  /** Answers the login's current question (`prompt.id`). */
  answerLogin(loginId: string, promptId: number, value: string): Promise<LoginSession>;
  cancelLogin(loginId: string): Promise<void>;
  /** GitHub, the extension's native host and Jev, as the setup page shows them. */
  setup(): Promise<SetupStatus>;
  /** Starts `gh auth login --web` on the backend; resolves with the code to enter. */
  githubLogin(): Promise<GithubLogin>;
  /** Registers the extension's native host, so its button can start the server. */
  installNativeHost(): Promise<void>;
  /** Saves a TypeSafe key for Jev in the backend's `~/.gloss/.env`, then the backend restarts to use it. */
  saveJudgeKey(key: string): Promise<void>;
  /** Whether the backend's checkout has newer code (fetches its upstream at most every few minutes). */
  updateStatus(): Promise<UpdateStatus>;
  /** Pulls, installs and builds on the backend, then restarts it; resolves before the restart. */
  update(): Promise<void>;
}

export interface HttpGlossClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
}

export class GlossHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GlossHttpError';
    this.status = status;
  }
}

export function createHttpGlossClient({ baseUrl, token, fetch: doFetch = fetch }: HttpGlossClientOptions): GlossClient {
  const root = baseUrl.replace(/\/+$/, '');
  const headers = (extra?: Record<string, string>) => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  });

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const response = await doFetch(`${root}${path}`, {
      ...init,
      headers: headers(init?.headers as Record<string, string>),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new GlossHttpError(response.status, body || `${response.status} ${response.statusText}`);
    }
    return response;
  }

  async function json<S extends v.GenericSchema>(schema: S, path: string, init?: RequestInit) {
    return v.parse(schema, await (await request(path, init)).json());
  }

  return {
    startTour: (ref, options) =>
      json(StartTourResponseSchema, '/api/tours', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref, force: options?.force ?? false }),
      }),

    async *events(jobId, options = {}) {
      let after = options.after ?? 0;
      // Reconnect after a dropped connection; the server replays from `after`.
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await request(`/api/tours/${encodeURIComponent(jobId)}/events?after=${after}`, {
            headers: { Accept: 'text/event-stream' },
            signal: options.signal,
          });
          if (!response.body) {
            throw new Error('Event stream has no body');
          }
          for await (const event of parseSseStream(response.body)) {
            after = event.seq;
            attempt = 0;
            yield event;
            if (isTerminal(event)) {
              return;
            }
          }
        } catch (error) {
          // Only a dropped connection or a server error is worth retrying; a bad event is a protocol bug.
          const retryable = error instanceof TypeError || (error instanceof GlossHttpError && error.status >= 500);
          if (options.signal?.aborted || !retryable || attempt >= 5) {
            throw error;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 250 * 2 ** attempt)));
      }
    },

    async *ask(body, options = {}) {
      const response = await request('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: options.signal,
      });
      if (!response.body) {
        throw new Error('Answer stream has no body');
      }
      for await (const event of parseSseStream(response.body, parseAskEvent)) {
        yield event;
        if (event.type === 'ask.done' || event.type === 'ask.failed') {
          return;
        }
      }
      // A dropped connection ends the body without an error; the answer must not hang as streaming.
      throw new Error('The answer stream ended early');
    },

    async abort(jobId) {
      await request(`/api/tours/${encodeURIComponent(jobId)}/abort`, { method: 'POST' });
    },
    diff: (diffId) => json(DiffPayloadSchema, `/api/diffs/${encodeURIComponent(diffId)}`),
    trace: (jobId) => json(TraceSchema, `/api/tours/${encodeURIComponent(jobId)}/trace`),
    fileContents: (diffId, fileId) =>
      json(FileContentsSchema, `/api/diffs/${encodeURIComponent(diffId)}/files/${encodeURIComponent(fileId)}`),
    lfsObject: async (diffId, oid) =>
      (await request(`/api/diffs/${encodeURIComponent(diffId)}/lfs/${encodeURIComponent(oid)}`)).blob(),
    health: () => json(HealthSchema, '/api/health'),
    recent: () => json(RecentToursSchema, '/api/recent'),
    asset: (url) => json(ResolvedAssetSchema, `/api/assets?url=${encodeURIComponent(url)}`),
    stack: (ref) =>
      json(
        StackSchema,
        `/api/stack?${new URLSearchParams({ owner: ref.owner, repo: ref.repo, number: String(ref.number) })}`,
      ),
    stackName: async (stack) =>
      (
        await json(StackNameSchema, '/api/stack/name', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(stack),
        })
      ).name,
    review: (review) =>
      json(ReviewResultSchema, '/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(review),
      }),
    startLogin: (subscription, method) =>
      json(LoginSessionSchema, '/api/logins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription, method }),
      }),
    login: (loginId) => json(LoginSessionSchema, `/api/logins/${encodeURIComponent(loginId)}`),
    answerLogin: (loginId, promptId, value) =>
      json(LoginSessionSchema, `/api/logins/${encodeURIComponent(loginId)}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptId, value }),
      }),
    async cancelLogin(loginId) {
      await request(`/api/logins/${encodeURIComponent(loginId)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    },
    setup: () => json(SetupStatusSchema, '/api/setup'),
    githubLogin: () =>
      json(GithubLoginSchema, '/api/setup/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    async installNativeHost() {
      await request('/api/setup/extension', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    },
    async saveJudgeKey(key) {
      await request('/api/setup/judge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
    },
    updateStatus: () => json(UpdateStatusSchema, '/api/update'),
    async update() {
      await request('/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    },
  };
}
