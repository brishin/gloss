import type { CacheStore } from '@gloss/core';
import { resolveGithubAsset } from '@gloss/core';
import type { DiffPayload, Health, ResolvedAsset, TourEvent } from '@gloss/protocol';
import { encodeNdjson, isTerminal, SourceRefSchema } from '@gloss/protocol';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { cors } from 'hono/cors';
import { stream, streamSSE } from 'hono/streaming';
import * as v from 'valibot';
import type { JobManager } from './jobs.ts';

export interface AppOptions {
  jobs: JobManager;
  cache: CacheStore;
  health: () => Promise<Health>;
  /** When set, every `/api` request needs `Authorization: Bearer <token>` (remote backends). */
  token?: string;
  /** Browser origins allowed to call the API cross-origin (the dev web server, a hosted frontend). */
  corsOrigins?: string[];
  /** Resolves a PR body attachment to a URL the browser can load; defaults to the `gh` login. */
  resolveAsset?: (url: string, signal?: AbortSignal) => Promise<ResolvedAsset | undefined>;
}

const StartBodySchema = v.object({ ref: SourceRefSchema, force: v.optional(v.boolean(), false) });

const PING_MS = 15_000;

/** The gloss HTTP API: start a tour, stream its events (SSE or NDJSON), fetch diffs. */
export function createApp({
  jobs,
  cache,
  health,
  token,
  corsOrigins = [],
  resolveAsset = resolveGithubAsset,
}: AppOptions): Hono {
  const app = new Hono();
  if (corsOrigins.length) {
    app.use('/api/*', cors({ origin: corsOrigins, allowHeaders: ['Authorization', 'Content-Type', 'Last-Event-ID'] }));
  }
  if (token) {
    app.use('/api/*', bearerAuth({ token }));
  }

  app.get('/api/health', async (c) => c.json(await health()));

  app.get('/api/recent', (c) => c.json(cache.listRecent(20)));

  app.post('/api/tours', async (c) => {
    const parsed = v.safeParse(StartBodySchema, await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request', issues: v.flatten(parsed.issues) }, 400);
    }
    const job = jobs.start(parsed.output.ref, parsed.output.force);
    return c.json({ jobId: job.id, state: job.state, lastSeq: job.log.length }, 202);
  });

  app.get('/api/tours/:id/events', (c) => {
    const job = jobs.get(c.req.param('id'));
    if (!job) {
      return c.json({ error: 'Unknown or expired job' }, 404);
    }
    const after = Number(c.req.header('Last-Event-ID') ?? c.req.query('after') ?? 0) || 0;

    const pump = async (
      write: (event: TourEvent) => Promise<void>,
      ping: () => Promise<void>,
      signal: { aborted: boolean; onAbort(fn: () => void): void },
    ) => {
      const queue: TourEvent[] = [];
      let wake: (() => void) | undefined;
      let closed = false;
      const unsubscribe = jobs.subscribe(job, after, (event) => {
        queue.push(event);
        wake?.();
      });
      signal.onAbort(() => {
        closed = true;
        unsubscribe();
        wake?.();
      });
      try {
        while (!closed) {
          while (queue.length) {
            const event = queue.shift()!;
            await write(event);
            if (isTerminal(event)) {
              return;
            }
          }
          if (job.state !== 'running' && queue.length === 0) {
            return;
          }
          const timer = new Promise<'ping'>((resolve) => setTimeout(() => resolve('ping'), PING_MS));
          const woke = new Promise<'event'>((resolve) => {
            wake = () => resolve('event');
          });
          if ((await Promise.race([timer, woke])) === 'ping') {
            await ping();
          }
          wake = undefined;
        }
      } finally {
        unsubscribe();
      }
    };

    if (c.req.header('Accept')?.includes('application/x-ndjson')) {
      c.header('Content-Type', 'application/x-ndjson');
      return stream(c, (out) =>
        pump(
          (event) => out.write(encodeNdjson(event)).then(() => {}),
          () => out.write('\n').then(() => {}),
          {
            get aborted() {
              return out.aborted;
            },
            onAbort: (fn) => out.onAbort(fn),
          },
        ),
      );
    }
    return streamSSE(c, (out) =>
      pump(
        (event) => out.writeSSE({ id: String(event.seq), event: event.type, data: JSON.stringify(event) }),
        () => out.write(': ping\n\n').then(() => {}),
        {
          get aborted() {
            return out.aborted;
          },
          onAbort: (fn) => out.onAbort(fn),
        },
      ),
    );
  });

  app.post('/api/tours/:id/abort', (c) => {
    const job = jobs.get(c.req.param('id'));
    if (!job) {
      return c.json({ error: 'Unknown or expired job' }, 404);
    }
    jobs.abort(job);
    return c.body(null, 204);
  });

  app.get('/api/diffs/:id', (c) => {
    const diff = cache.get<DiffPayload>(c.req.param('id'));
    return diff ? c.json(diff) : c.json({ error: 'Unknown diff' }, 404);
  });

  app.get('/api/assets', async (c) => {
    const asset = await resolveAsset(c.req.query('url') ?? '', c.req.raw.signal).catch(() => undefined);
    // Signed URLs expire within minutes, so neither side may cache the answer.
    c.header('Cache-Control', 'no-store');
    return asset ? c.json(asset) : c.json({ error: 'Unknown asset' }, 404);
  });

  return app;
}
