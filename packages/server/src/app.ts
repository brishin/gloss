import { type ModelClient, nameStack, type PullSummary, Repos, TourCache } from '@gloss/core';
import type {
  DiffPayload,
  GithubLogin,
  Health,
  RecentTour,
  RecentTours,
  SourceRef,
  Stack,
  SetupStatus,
  TourEvent,
  Trace,
  UpdateStatus,
} from '@gloss/protocol';
import {
  encodeNdjson,
  lfsPointer,
  JudgeKeyRequestSchema,
  LoginAnswerSchema,
  ReviewRequestSchema,
  reviewProblem,
  serializeRef,
  SourceRefSchema,
  StackSchema,
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

/** How many recent tours the app lists. */
const RECENT_LIMIT = 20;

export interface AppOptions {
  /** Runs handlers' effects: the jobs, the cache and repository access, with the pipeline's services behind them. */
  runtime: ManagedRuntime.ManagedRuntime<Jobs | TourCache | Logins | Repos | ModelClient, never>;
  health: () => Promise<Health>;
  /** When set, every `/api` request needs `Authorization: Bearer <token>` (remote backends). */
  token?: string;
  /** Browser origins allowed to call the API cross-origin (the dev web server, a hosted frontend). */
  corsOrigins?: string[];
  /** First-run setup on the backend's machine (`/api/setup`); a remote backend leaves it out. */
  setup?: SetupHooks;
  /** Updates the backend's own checkout (`/api/update`); a backend that is not a checkout leaves it out. */
  update?: UpdateHooks;
}

/** What the setup page asks of the backend's machine: the CLI implements these (packages/cli/src/setup.ts). */
export interface SetupHooks {
  status(): Promise<SetupStatus>;
  githubLogin(): Promise<GithubLogin>;
  installNativeHost(): Promise<void>;
  /** Saves the key, then restarts the server (a new Jev client needs a new runtime). */
  saveJudgeKey(key: string): Promise<void>;
}

/** The CLI implements these (packages/cli/src/update.ts). */
export interface UpdateHooks {
  status(): Promise<UpdateStatus>;
  /** Pulls, installs and builds, then has the server restart on the new code once the response is out. */
  apply(): Promise<void>;
}

const StartBodySchema = v.object({ ref: SourceRefSchema, force: v.optional(v.boolean(), false) });

const PING_MS = 15_000;

type GithubRef = Extract<SourceRef, { kind: 'github-pr' }>;

const stackRefs = (stack: Stack): GithubRef[] =>
  stack.members.map((member) => ({ kind: 'github-pr', owner: stack.owner, repo: stack.repo, number: member.number }));

/** A recent tour with its PR's state, and its stack members' states, as GitHub has them now. */
export function withPullStates(tour: RecentTour, pulls: ReadonlyMap<string, PullSummary>): RecentTour {
  const state = pulls.get(serializeRef(tour.ref))?.state;
  const { stack } = tour;
  return {
    ...tour,
    ...(state ? { state } : {}),
    ...(stack
      ? {
          stack: {
            ...stack,
            members: stack.members.map((member, index) => ({
              ...member,
              state: pulls.get(serializeRef(stackRefs(stack)[index]!))?.state ?? member.state,
            })),
          },
        }
      : {}),
  };
}

/** The gloss HTTP API: start a tour, stream its events (SSE or NDJSON), fetch diffs. */
export function createApp({ runtime, health, token, corsOrigins = [], setup, update }: AppOptions): Hono {
  const app = new Hono();
  const run = <A>(
    effect: Effect.Effect<A, never, Jobs | TourCache | Logins | Repos | ModelClient>,
    signal?: AbortSignal,
  ) => runtime.runPromise(effect, { signal });
  if (corsOrigins.length) {
    app.use('/api/*', cors({ origin: corsOrigins, allowHeaders: ['Authorization', 'Content-Type', 'Last-Event-ID'] }));
  }
  if (token) {
    app.use('/api/*', bearerAuth({ token }));
  }

  app.get('/api/health', async (c) => c.json(await health()));

  app.get('/api/recent', async (c) =>
    c.json(
      await run(
        Effect.gen(function* () {
          const cache = yield* TourCache;
          const repos = yield* Repos;
          const tours = cache.listRecent(RECENT_LIMIT);
          // One batched GraphQL lookup for every PR the side rail shows: its state now, and the
          // author of tours recorded before authors were kept (stored for good).
          const refs = new Map<string, GithubRef>();
          for (const tour of tours) {
            if (tour.ref.kind === 'github-pr') {
              refs.set(serializeRef(tour.ref), tour.ref);
            }
            for (const ref of tour.stack ? stackRefs(tour.stack) : []) {
              refs.set(serializeRef(ref), ref);
            }
          }
          const [pulls, viewer, inbox] = yield* Effect.all(
            [
              refs.size ? repos.pulls([...refs.values()]) : Effect.succeed(new Map<string, PullSummary>()),
              repos.viewer,
              repos.inbox,
            ],
            { concurrency: 'unbounded' },
          );
          const authors = new Map(
            tours.flatMap((tour) => {
              const author = !tour.author && pulls.get(serializeRef(tour.ref))?.author;
              return author ? [[serializeRef(tour.ref), author] as const] : [];
            }),
          );
          if (authors.size) {
            cache.recordAuthors(authors);
          }
          const recent: RecentTours = {
            ...(viewer ? { viewer } : {}),
            ...inbox,
            tours: (authors.size ? cache.listRecent(RECENT_LIMIT) : tours).map((tour) => withPullStates(tour, pulls)),
          };
          return recent;
        }),
        c.req.raw.signal,
      ),
    ),
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

  app.get('/api/diffs/:id/lfs/:oid', async (c) => {
    const diff = await run(TourCache.use((cache) => Effect.sync(() => cache.get<DiffPayload>(c.req.param('id')))));
    const oid = c.req.param('oid');
    // Only objects the diff names: the route must not fetch arbitrary objects from the repository.
    const found = diff?.files.flatMap((file) => {
      const pointer = lfsPointer(file);
      const object = [pointer?.old, pointer?.new].find((side) => side?.oid === oid);
      return object ? [{ file, object }] : [];
    })[0];
    if (!diff || !found) {
      return c.json({ error: 'Unknown diff or LFS object' }, 404);
    }
    return run(
      Repos.use((repos) => repos.lfs(diff, found.object)).pipe(
        Effect.match({
          onSuccess: (bytes) =>
            c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
              'Content-Type': mediaType(found.file.path),
              // Content-addressed: the same oid is always the same bytes.
              'Cache-Control': 'private, max-age=31536000, immutable',
              // An SVG opened on its own must not run script on the API's origin.
              'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
              'X-Content-Type-Options': 'nosniff',
            }),
          onFailure: (error) => c.json({ error: error.message }, 502),
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

  // A POST only so the stack can ride in the body; it spends model tokens, so only the app may ask.
  app.post('/api/stack/name', async (c) => {
    if (!fromApp(c)) {
      return c.json({ error: 'Stack names are given only as JSON to the gloss app' }, 403);
    }
    const parsed = v.safeParse(StackSchema, await c.req.json().catch(() => undefined));
    if (!parsed.success || parsed.output.members.length < 2) {
      return c.json({ error: 'Expected a stack of two or more PRs' }, 400);
    }
    return run(
      nameStack(parsed.output).pipe(
        Effect.match({
          onSuccess: (name) => c.json({ name }),
          onFailure: (error) => c.json({ error: error.message }, 502),
        }),
      ),
      c.req.raw.signal,
    );
  });

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

  if (setup) {
    const failed = (c: Context, error: unknown) =>
      c.json({ error: error instanceof Error ? error.message : String(error) }, 500);

    app.get('/api/setup', async (c) => c.json(await setup.status()));

    // Each changes the backend's machine, so like logins they take JSON from the app only.
    app.post('/api/setup/github', async (c) => {
      if (!fromApp(c)) return c.json({ error: 'Setup is accepted only as JSON from the gloss app' }, 403);
      return setup.githubLogin().then(
        (login) => c.json(login, 201),
        (error) => failed(c, error),
      );
    });

    app.post('/api/setup/extension', async (c) => {
      if (!fromApp(c)) return c.json({ error: 'Setup is accepted only as JSON from the gloss app' }, 403);
      return setup.installNativeHost().then(
        () => c.body(null, 204),
        (error) => failed(c, error),
      );
    });

    app.post('/api/setup/judge', async (c) => {
      if (!fromApp(c)) return c.json({ error: 'Setup is accepted only as JSON from the gloss app' }, 403);
      const parsed = v.safeParse(JudgeKeyRequestSchema, await c.req.json().catch(() => undefined));
      if (!parsed.success) return c.json({ error: 'Enter a key' }, 400);
      return setup.saveJudgeKey(parsed.output.key).then(
        () => c.body(null, 202),
        (error) => failed(c, error),
      );
    });
  }

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

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

function mediaType(path: string): string {
  return MEDIA_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
}
