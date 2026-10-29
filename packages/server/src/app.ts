import { resolveGithubAsset, resolveGithubStack, submitGithubReview, TourCache } from '@gloss/core';
import type {
  DiffPayload,
  Health,
  ResolvedAsset,
  ReviewRequest,
  ReviewResult,
  SourceRef,
  Stack,
  TourEvent,
} from '@gloss/protocol';
import { encodeNdjson, ReviewRequestSchema, reviewProblem, SourceRefSchema } from '@gloss/protocol';
import { Effect, type ManagedRuntime, Schedule, Stream } from 'effect';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { cors } from 'hono/cors';
import { stream, streamSSE } from 'hono/streaming';
import * as v from 'valibot';
import { Jobs } from './jobs.ts';

export interface AppOptions {
  /** Runs handlers' effects: the jobs and the cache, with the pipeline's services behind them. */
  runtime: ManagedRuntime.ManagedRuntime<Jobs | TourCache, never>;
  health: () => Promise<Health>;
  /** When set, every `/api` request needs `Authorization: Bearer <token>` (remote backends). */
  token?: string;
  /** Browser origins allowed to call the API cross-origin (the dev web server, a hosted frontend). */
  corsOrigins?: string[];
  /** Resolves a PR body attachment to a URL the browser can load; defaults to the `gh` login. */
  resolveAsset?: (url: string, signal?: AbortSignal) => Promise<ResolvedAsset | undefined>;
  /** Finds the stack a PR sits in; defaults to walking branches through the `gh` login. */
  resolveStack?: (ref: Extract<SourceRef, { kind: 'github-pr' }>, signal?: AbortSignal) => Promise<Stack>;
  /** Posts a review to GitHub; defaults to the `gh` login. */
  submitReview?: (review: ReviewRequest, signal?: AbortSignal) => Promise<ReviewResult>;
}

const StartBodySchema = v.object({ ref: SourceRefSchema, force: v.optional(v.boolean(), false) });

const PING_MS = 15_000;

/** The gloss HTTP API: start a tour, stream its events (SSE or NDJSON), fetch diffs. */
export function createApp({
  runtime,
  health,
  token,
  corsOrigins = [],
  resolveAsset = resolveGithubAsset,
  resolveStack = resolveGithubStack,
  submitReview = submitGithubReview,
}: AppOptions): Hono {
  const app = new Hono();
  const run = <A>(effect: Effect.Effect<A, never, Jobs | TourCache>, signal?: AbortSignal) =>
    runtime.runPromise(effect, { signal });
  if (corsOrigins.length) {
    app.use('/api/*', cors({ origin: corsOrigins, allowHeaders: ['Authorization', 'Content-Type', 'Last-Event-ID'] }));
  }
  if (token) {
    app.use('/api/*', bearerAuth({ token }));
  }

  app.get('/api/health', async (c) => c.json(await health()));

  app.get('/api/recent', async (c) =>
    c.json(await run(TourCache.use((cache) => Effect.sync(() => cache.listRecent(20))))),
  );

  app.post('/api/tours', async (c) => {
    const parsed = v.safeParse(StartBodySchema, await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request', issues: v.flatten(parsed.issues) }, 400);
    }
    const { ref, force } = parsed.output;
    const job = await run(Jobs.use((jobs) => jobs.start(ref, force)));
    return c.json({ jobId: job.id, state: job.state, lastSeq: job.log.length }, 202);
  });

  app.get('/api/tours/:id/events', async (c) => {
    const id = c.req.param('id');
    const job = await run(Jobs.use((jobs) => Effect.sync(() => jobs.get(id))));
    if (!job) {
      return c.json({ error: 'Unknown or expired job' }, 404);
    }
    const after = Number(c.req.header('Last-Event-ID') ?? c.req.query('after') ?? 0) || 0;

    /** Writes the job's events until its terminal one, with a ping every 15 s so proxies keep the stream open. */
    const pump = (
      out: { onAbort(fn: () => void): void },
      write: (event: TourEvent) => Promise<unknown>,
      ping: () => Promise<unknown>,
    ) => {
      const controller = new AbortController();
      out.onAbort(() => controller.abort());
      const events = Jobs.use((jobs) =>
        Stream.runForEach(jobs.events(job, after), (event) => Effect.promise(() => write(event))),
      );
      const pings = Effect.promise(ping).pipe(Effect.delay(PING_MS), Effect.repeat(Schedule.forever));
      return run(Effect.raceFirst(events, Effect.asVoid(pings)), controller.signal).catch(() => {});
    };

    if (c.req.header('Accept')?.includes('application/x-ndjson')) {
      c.header('Content-Type', 'application/x-ndjson');
      return stream(c, (out) =>
        pump(
          out,
          (event) => out.write(encodeNdjson(event)),
          () => out.write('\n'),
        ),
      );
    }
    return streamSSE(c, (out) =>
      pump(
        out,
        (event) => out.writeSSE({ id: String(event.seq), event: event.type, data: JSON.stringify(event) }),
        () => out.write(': ping\n\n'),
      ),
    );
  });

  app.post('/api/tours/:id/abort', async (c) => {
    const id = c.req.param('id');
    const found = await run(
      Jobs.use((jobs) => {
        const job = jobs.get(id);
        return job ? Effect.as(jobs.abort(job), true) : Effect.succeed(false);
      }),
    );
    return found ? c.body(null, 204) : c.json({ error: 'Unknown or expired job' }, 404);
  });

  app.get('/api/diffs/:id', async (c) => {
    const id = c.req.param('id');
    const diff = await run(TourCache.use((cache) => Effect.sync(() => cache.get<DiffPayload>(id))));
    return diff ? c.json(diff) : c.json({ error: 'Unknown diff' }, 404);
  });

  app.get('/api/assets', async (c) => {
    const asset = await resolveAsset(c.req.query('url') ?? '', c.req.raw.signal).catch(() => undefined);
    // Signed URLs expire within minutes, so neither side may cache the answer.
    c.header('Cache-Control', 'no-store');
    return asset ? c.json(asset) : c.json({ error: 'Unknown asset' }, 404);
  });

  app.get('/api/stack', async (c) => {
    const parsed = v.safeParse(SourceRefSchema, {
      kind: 'github-pr',
      owner: c.req.query('owner'),
      repo: c.req.query('repo'),
      number: Number(c.req.query('number')),
    });
    if (!parsed.success || parsed.output.kind !== 'github-pr') {
      return c.json({ error: 'Expected owner, repo and number' }, 400);
    }
    try {
      // Not cached: stacks change as PRs merge and retarget.
      return c.json(await resolveStack(parsed.output, c.req.raw.signal));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Stack lookup failed' }, 502);
    }
  });

  app.post('/api/reviews', async (c) => {
    const parsed = v.safeParse(ReviewRequestSchema, await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: 'Invalid review', issues: v.flatten(parsed.issues) }, 400);
    }
    const problem = reviewProblem(parsed.output);
    if (problem) {
      return c.json({ error: problem }, 400);
    }
    try {
      // Not aborted with the request: once sent, a review should land even if the tab closes.
      return c.json(await submitReview(parsed.output));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Review failed' }, 502);
    }
  });

  return app;
}
