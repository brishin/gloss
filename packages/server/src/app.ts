import { Repos, TourCache } from '@gloss/core';
import type { DiffPayload, Health, TourEvent, Trace, UpdateStatus } from '@gloss/protocol';
import {
  encodeNdjson,
  LoginAnswerSchema,
  ReviewRequestSchema,
  reviewProblem,
  SourceRefSchema,
  StartLoginRequestSchema,
} from '@gloss/protocol';
import { Effect, type ManagedRuntime, Schedule, Stream } from 'effect';
import { type Context, Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { cors } from 'hono/cors';
import { stream, streamSSE } from 'hono/streaming';
import * as v from 'valibot';
import { Jobs } from './jobs.ts';
import { Logins } from './logins.ts';

export interface AppOptions {
  /** Runs handlers' effects: the jobs, the cache and repository access, with the pipeline's services behind them. */
  runtime: ManagedRuntime.ManagedRuntime<Jobs | TourCache | Logins | Repos, never>;
  health: () => Promise<Health>;
  /** When set, every `/api` request needs `Authorization: Bearer <token>` (remote backends). */
  token?: string;
  /** Browser origins allowed to call the API cross-origin (the dev web server, a hosted frontend). */
  corsOrigins?: string[];
  /** Updates the backend's own checkout (`/api/update`); a backend that is not a checkout leaves it out. */
  update?: UpdateHooks;
}

/** The CLI implements these (packages/cli/src/update.ts). */
export interface UpdateHooks {
  status(): Promise<UpdateStatus>;
  /** Pulls, installs and builds, then has the server restart on the new code once the response is out. */
  apply(): Promise<void>;
}

const StartBodySchema = v.object({ ref: SourceRefSchema, force: v.optional(v.boolean(), false) });

const PING_MS = 15_000;

/** The gloss HTTP API: start a tour, stream its events (SSE or NDJSON), fetch diffs. */
export function createApp({ runtime, health, token, corsOrigins = [], update }: AppOptions): Hono {
  const app = new Hono();
  const run = <A>(effect: Effect.Effect<A, never, Jobs | TourCache | Logins | Repos>, signal?: AbortSignal) =>
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

  app.get('/api/tours/:id/trace', async (c) => {
    const job = await run(Jobs.use((jobs) => Effect.sync(() => jobs.get(c.req.param('id')))));
    if (!job) {
      return c.json({ error: 'Unknown or expired job' }, 404);
    }
    const trace: Trace = { steps: [...job.trace.values()], done: job.state !== 'running' };
    return c.json(trace);
  });

  app.get('/api/diffs/:id', async (c) => {
    const id = c.req.param('id');
    const diff = await run(TourCache.use((cache) => Effect.sync(() => cache.get<DiffPayload>(id))));
    return diff ? c.json(diff) : c.json({ error: 'Unknown diff' }, 404);
  });

  app.get('/api/diffs/:id/files/:fileId', async (c) => {
    const diff = await run(TourCache.use((cache) => Effect.sync(() => cache.get<DiffPayload>(c.req.param('id')))));
    const file = diff?.files.find((candidate) => candidate.id === c.req.param('fileId'));
    if (!diff || !file) {
      return c.json({ error: 'Unknown diff or file' }, 404);
    }
    // Not cached: a PR's head is a fixed sha, and the page keeps what it loaded.
    return run(
      Repos.use((repos) => repos.contents(diff, file)).pipe(
        Effect.match({
          onSuccess: (contents) =>
            contents ? c.json(contents) : c.json({ error: 'This file has no unchanged lines to show' }, 404),
          onFailure: (error) => c.json({ error: error.message }, error._tag === 'StaleFileError' ? 409 : 502),
        }),
      ),
      c.req.raw.signal,
    );
  });

  app.get('/api/assets', async (c) => {
    const asset = await run(
      Repos.use((repos) => repos.asset(c.req.query('url') ?? '')),
      c.req.raw.signal,
    );
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
    const ref = parsed.output;
    // Not cached: stacks change as PRs merge and retarget.
    return run(
      Repos.use((repos) => repos.stack(ref)).pipe(
        Effect.tap((stack) => TourCache.use((cache) => Effect.sync(() => cache.recordStack(stack)))),
        Effect.match({
          onSuccess: (stack) => c.json(stack),
          onFailure: (error) => c.json({ error: error.message }, 502),
        }),
      ),
      c.req.raw.signal,
    );
  });

  /**
   * A review acts as the user on GitHub, and a login writes their credentials, so only this app
   * or an allowed origin may send one. JSON is not a "simple" content type: a browser asks
   * first, and CORS turns other sites away.
   */
  const fromApp = (c: Context) => {
    const origin = c.req.header('Origin');
    return (
      !!c.req.header('Content-Type')?.startsWith('application/json') &&
      (origin === undefined || origin === new URL(c.req.url).origin || corsOrigins.includes(origin))
    );
  };

  app.post('/api/reviews', async (c) => {
    if (!fromApp(c)) {
      return c.json({ error: 'Reviews are accepted only as JSON from the gloss app' }, 403);
    }
    const parsed = v.safeParse(ReviewRequestSchema, await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: 'Invalid review', issues: v.flatten(parsed.issues) }, 400);
    }
    const problem = reviewProblem(parsed.output);
    if (problem) {
      return c.json({ error: problem }, 400);
    }
    // Not interrupted with the request: once sent, a review should land even if the tab closes.
    return run(
      Repos.use((repos) => repos.review(parsed.output)).pipe(
        Effect.match({
          onSuccess: (result) => c.json(result),
          onFailure: (error) => c.json({ error: error.message }, 502),
        }),
      ),
    );
  });

  /** The provider logins, as the runtime's `Logins` layer scopes them. */
  const withLogins = <A>(f: (logins: Logins['Service']) => A) =>
    run(Logins.use((logins) => Effect.sync(() => f(logins))));

  app.post('/api/logins', async (c) => {
    if (!fromApp(c)) {
      return c.json({ error: 'Logins are accepted only as JSON from the gloss app' }, 403);
    }
    const parsed = v.safeParse(StartLoginRequestSchema, await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: 'Invalid login', issues: v.flatten(parsed.issues) }, 400);
    }
    const { subscription, method } = parsed.output;
    return c.json(await withLogins((logins) => logins.start(subscription, method)), 201);
  });

  app.get('/api/logins/:id', async (c) => {
    const id = c.req.param('id');
    const session = await withLogins((logins) => logins.get(id));
    c.header('Cache-Control', 'no-store');
    return session ? c.json(session) : c.json({ error: 'Unknown or expired login' }, 404);
  });

  app.post('/api/logins/:id/answer', async (c) => {
    if (!fromApp(c)) {
      return c.json({ error: 'Logins are accepted only as JSON from the gloss app' }, 403);
    }
    const id = c.req.param('id');
    const parsed = v.safeParse(LoginAnswerSchema, await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: 'Invalid answer', issues: v.flatten(parsed.issues) }, 400);
    }
    const { promptId, value } = parsed.output;
    const answered = await withLogins((logins) =>
      logins.get(id) ? (logins.answer(id, promptId, value) ? logins.get(id) : ('closed' as const)) : undefined,
    );
    if (!answered) {
      return c.json({ error: 'Unknown or expired login' }, 404);
    }
    if (answered === 'closed') {
      return c.json({ error: 'That question is no longer open' }, 409);
    }
    return c.json(answered);
  });

  app.post('/api/logins/:id/cancel', async (c) => {
    if (!fromApp(c)) {
      return c.json({ error: 'Logins are accepted only as JSON from the gloss app' }, 403);
    }
    const id = c.req.param('id');
    return (await withLogins((logins) => logins.cancel(id)))
      ? c.body(null, 204)
      : c.json({ error: 'Unknown or expired login' }, 404);
  });

  app.get('/api/update', async (c) => {
    if (!update) {
      return c.json({ error: 'This backend does not update itself' }, 404);
    }
    c.header('Cache-Control', 'no-store');
    return c.json(await update.status());
  });

  app.post('/api/update', async (c) => {
    if (!update) {
      return c.json({ error: 'This backend does not update itself' }, 404);
    }
    // An update runs pnpm and restarts the server, so like a login only the app may ask for one.
    if (!fromApp(c)) {
      return c.json({ error: 'Updates are accepted only as JSON from the gloss app' }, 403);
    }
    try {
      await update.apply();
      return c.body(null, 202);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  return app;
}
