import * as v from 'valibot';
import { type ResolvedAsset, ResolvedAssetSchema } from './asset.ts';
import { parseSseStream } from './codec.ts';
import type { DiffPayload, FileContents } from './diff.ts';
import { DiffPayloadSchema, FileContentsSchema } from './diff.ts';
import { isTerminal, type TourEvent } from './events.ts';
import { type ReviewRequest, type ReviewResult, ReviewResultSchema } from './review.ts';
import type { SourceRef } from './source-ref.ts';
import { SourceRefSchema } from './source-ref.ts';
import { type Stack, StackSchema } from './stack.ts';
import { type Trace, TraceSchema } from './trace.ts';

export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:4777';

export const StartTourResponseSchema = v.object({
  jobId: v.string(),
  state: v.picklist(['running', 'complete', 'failed', 'aborted']),
  lastSeq: v.number(),
});
export type StartTourResponse = v.InferOutput<typeof StartTourResponseSchema>;

export const HealthSchema = v.object({
  version: v.string(),
  pipelineVersion: v.string(),
  judge: v.object({ available: v.boolean(), model: v.optional(v.string()) }),
  models: v.object({ define: v.string(), followup: v.string(), notes: v.string() }),
  providers: v.array(v.object({ id: v.string(), configured: v.boolean(), source: v.optional(v.string()) })),
});
export type Health = v.InferOutput<typeof HealthSchema>;

export const RecentTourSchema = v.object({
  ref: SourceRefSchema,
  title: v.string(),
  updatedAt: v.string(),
});
export type RecentTour = v.InferOutput<typeof RecentTourSchema>;

/**
 * Everything a frontend may ask a gloss backend. The HTTP implementation below works
 * against the local CLI server today and a remote one later (base URL + bearer token).
 */
export interface GlossClient {
  startTour(ref: SourceRef, options?: { force?: boolean }): Promise<StartTourResponse>;
  /** Replays the job's log after `after`, then follows it live until a terminal event. */
  events(jobId: string, options?: { after?: number; signal?: AbortSignal }): AsyncIterable<TourEvent>;
  abort(jobId: string): Promise<void>;
  diff(diffId: string): Promise<DiffPayload>;
  /** What each pipeline step of the job read and returned, for the pipeline debug view. */
  trace(jobId: string): Promise<Trace>;
  /** One changed file of a diff in full, for expanding the unchanged lines around its hunks. */
  fileContents(diffId: string, fileId: string): Promise<FileContents>;
  health(): Promise<Health>;
  recent(): Promise<RecentTour[]>;
  /** Resolves a GitHub attachment URL (see `isGithubAssetUrl`) to one the browser can load. */
  asset(url: string): Promise<ResolvedAsset>;
  /** The stack a GitHub PR sits in (a stack of one when it has no neighbours). */
  stack(ref: Extract<SourceRef, { kind: 'github-pr' }>): Promise<Stack>;
  /** Submits a GitHub review (approve, request changes, or comment) as the backend's `gh` login. */
  review(review: ReviewRequest): Promise<ReviewResult>;
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

    async abort(jobId) {
      await request(`/api/tours/${encodeURIComponent(jobId)}/abort`, { method: 'POST' });
    },
    diff: (diffId) => json(DiffPayloadSchema, `/api/diffs/${encodeURIComponent(diffId)}`),
    trace: (jobId) => json(TraceSchema, `/api/tours/${encodeURIComponent(jobId)}/trace`),
    fileContents: (diffId, fileId) =>
      json(FileContentsSchema, `/api/diffs/${encodeURIComponent(diffId)}/files/${encodeURIComponent(fileId)}`),
    health: () => json(HealthSchema, '/api/health'),
    recent: () => json(v.array(RecentTourSchema), '/api/recent'),
    asset: (url) => json(ResolvedAssetSchema, `/api/assets?url=${encodeURIComponent(url)}`),
    stack: (ref) =>
      json(
        StackSchema,
        `/api/stack?${new URLSearchParams({ owner: ref.owner, repo: ref.repo, number: String(ref.number) })}`,
      ),
    review: (review) =>
      json(ReviewResultSchema, '/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(review),
      }),
  };
}
