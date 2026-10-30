import { createFakeModelClient, DiffSources, ModelClient, TourCache } from '@gloss/core';
import type { Tour, TourEvent, TourEventBody } from '@gloss/protocol';
import { createHttpGlossClient } from '@gloss/protocol';
import { Effect, Layer, ManagedRuntime, Queue, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { Jobs, type RunTour } from './jobs.ts';

const ref = { kind: 'github-pr' as const, owner: 'o', repo: 'r', number: 1 };
const models = { define: 'a', followup: 'a', notes: 'a' };
const tour: Tour = {
  diffId: 'd',
  ref,
  meta: { title: 't', baseRef: 'main', headRef: 'feature', commits: [] },
  files: [],
  groups: [],
  placements: {},
  judgments: {},
  notes: {},
  models,
};

/** A scripted pipeline: three events, then waits for `release` (or abort) before completing. */
function scripted() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let runs = 0;
  const run: RunTour = ({ onStep }) =>
    Stream.callback<TourEventBody>((queue) =>
      Effect.gen(function* () {
        runs++;
        onStep?.({ id: 'fetch', kind: 'fetch', inputs: [], state: 'done', startMs: 0, endMs: 5 });
        Queue.offerUnsafe(queue, {
          type: 'job.started',
          ref,
          sourceKey: 'k',
          pipelineVersion: '1',
          models,
          cached: false,
        });
        Queue.offerUnsafe(queue, { type: 'tour.summary', overallSummary: 'one' });
        Queue.offerUnsafe(queue, { type: 'tour.summary', overallSummary: 'two' });
        yield* Effect.promise(() => gate);
        Queue.offerUnsafe(queue, { type: 'tour.complete', tour, cached: false });
        yield* Queue.end(queue);
      }),
    );
  return { run, release, runs: () => runs };
}

function setup(run: ReturnType<typeof scripted>['run'], options: Partial<Parameters<typeof createApp>[0]> = {}) {
  const services = Layer.mergeAll(
    TourCache.memory,
    Layer.succeed(ModelClient, createFakeModelClient({ answers: {} })),
    DiffSources.layer,
  );
  const runtime = ManagedRuntime.make(Jobs.layer({ run }).pipe(Layer.provideMerge(services)));
  const app = createApp({ runtime, health: async () => ({}) as never, ...options });
  const client = createHttpGlossClient({
    baseUrl: 'http://gloss.test',
    fetch: async (input, init) =>
      app.request(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init),
  });
  return { client, app, runtime };
}

async function take(events: AsyncIterable<TourEvent>, count: number): Promise<TourEvent[]> {
  const out: TourEvent[] = [];
  for await (const event of events) {
    out.push(event);
    if (out.length === count) {
      break;
    }
  }
  return out;
}

describe('tour API', () => {
  it('serves the job trace while it runs and after it ends', async () => {
    const script = scripted();
    const { client } = setup(script.run);
    const { jobId } = await client.startTour(ref);
    const running = await client.trace(jobId);
    expect(running).toEqual({ done: false, steps: [expect.objectContaining({ id: 'fetch', state: 'done' })] });
    script.release();
    await take(client.events(jobId), 4);
    expect((await client.trace(jobId)).done).toBe(true);
    await expect(client.trace('nope')).rejects.toThrow(/Unknown/);
  });

  it('dedupes concurrent starts, replays after a seq, and streams to the terminal event', async () => {
    const script = scripted();
    const { client } = setup(script.run);
    const first = await client.startTour(ref);
    const second = await client.startTour(ref);
    expect(second.jobId).toBe(first.jobId);
    expect(script.runs()).toBe(1);

    const resumed = client.events(first.jobId, { after: 1 });
    setTimeout(script.release, 20);
    const events = [];
    for await (const event of resumed) {
      events.push(event);
    }
    expect(events.map((event) => [event.seq, event.type])).toEqual([
      [2, 'tour.summary'],
      [3, 'tour.summary'],
      [4, 'tour.complete'],
    ]);

    // A finished job replays in full, and a new start runs a fresh job (the cache makes it cheap).
    expect((await take(client.events(first.jobId), 4)).map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect((await client.startTour(ref)).jobId).not.toBe(first.jobId);
  });

  it('aborts a running job and tells subscribers', async () => {
    const script = scripted();
    const { client } = setup(script.run);
    const { jobId } = await client.startTour(ref);
    setTimeout(() => void client.abort(jobId), 20);
    const events = [];
    for await (const event of client.events(jobId)) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({ type: 'job.aborted', reason: 'client' });
  });

  it('rejects malformed refs', async () => {
    const { app } = setup(scripted().run);
    const response = await app.request('/api/tours', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: { kind: 'github-pr', owner: 'o' } }),
    });
    expect(response.status).toBe(400);
  });
});

describe('stack API', () => {
  const stack = {
    owner: 'o',
    repo: 'r',
    base: 'main',
    members: [{ number: 1, title: 't', state: 'open' as const, baseRef: 'main', headRef: 'feature' }],
  };

  it('round-trips a stack through the client', async () => {
    const asked: unknown[] = [];
    const { client } = setup(scripted().run, {
      resolveStack: async (stackRef) => {
        asked.push(stackRef);
        return stack;
      },
    });
    expect(await client.stack(ref)).toEqual(stack);
    expect(asked).toEqual([ref]);
  });

  it('rejects a request without a PR number', async () => {
    const { app } = setup(scripted().run, { resolveStack: async () => stack });
    expect((await app.request('/api/stack?owner=o&repo=r')).status).toBe(400);
  });

  it('reports a failed lookup as a bad gateway', async () => {
    const { app } = setup(scripted().run, {
      resolveStack: async () => {
        throw new Error('gh is not signed in');
      },
    });
    const response = await app.request('/api/stack?owner=o&repo=r&number=1');
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'gh is not signed in' });
  });
});

describe('file contents API', () => {
  const file = {
    id: 'f1',
    path: 'a.ts',
    status: 'modified' as const,
    additions: 1,
    deletions: 1,
    isBinary: false,
    truncated: false,
    hunks: [{ id: 'h1', header: '@@ -2 +2 @@', oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, patch: '-b\n+B' }],
  };
  const diff = { id: 'd1', ref, sourceKey: 'k', fingerprint: 'f', meta: tour.meta, files: [file] };

  it('reads a cached diff file through the client', async () => {
    const asked: unknown[] = [];
    const { client, runtime } = setup(scripted().run, {
      readContents: async (fromDiff, fromFile) => {
        asked.push([fromDiff.id, fromFile.id]);
        return { oldContents: 'a\nb\n', newContents: 'a\nB\n' };
      },
    });
    await runtime.runPromise(TourCache.use((cache) => Effect.sync(() => cache.put('d1', 'diff', diff))));
    expect(await client.fileContents('d1', 'f1')).toEqual({ oldContents: 'a\nb\n', newContents: 'a\nB\n' });
    expect(asked).toEqual([['d1', 'f1']]);
  });

  it('answers 404 for an unknown diff or file, and 502 when the read fails', async () => {
    const { app, runtime } = setup(scripted().run, {
      readContents: async () => {
        throw new Error('gh is not signed in');
      },
    });
    await runtime.runPromise(TourCache.use((cache) => Effect.sync(() => cache.put('d1', 'diff', diff))));
    expect((await app.request('/api/diffs/nope/files/f1')).status).toBe(404);
    expect((await app.request('/api/diffs/d1/files/nope')).status).toBe(404);
    expect((await app.request('/api/diffs/d1/files/f1')).status).toBe(502);
  });
});

describe('review API', () => {
  const review = {
    owner: 'o',
    repo: 'r',
    number: 1,
    verdict: 'APPROVE' as const,
    body: '',
    comments: [{ path: 'a.ts', side: 'additions' as const, line: 3, body: 'nit' }],
    commitId: 'abc',
  };

  it('round-trips a review through the client', async () => {
    const sent: unknown[] = [];
    const { client } = setup(scripted().run, {
      submitReview: async (submitted) => {
        sent.push(submitted);
        return { url: 'https://github.com/o/r/pull/1#pullrequestreview-1' };
      },
    });
    expect(await client.review(review)).toEqual({ url: 'https://github.com/o/r/pull/1#pullrequestreview-1' });
    expect(sent).toEqual([review]);
  });

  it('refuses a review GitHub would refuse, without sending it', async () => {
    const sent: unknown[] = [];
    const { app } = setup(scripted().run, { submitReview: async (submitted) => (sent.push(submitted), { url: '' }) });
    const response = await app.request('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...review, verdict: 'REQUEST_CHANGES' }),
    });
    expect(response.status).toBe(400);
    expect(sent).toEqual([]);
  });

  it("passes GitHub's refusal through as a bad gateway", async () => {
    const { app } = setup(scripted().run, {
      submitReview: async () => {
        throw new Error('Can not approve your own pull request (HTTP 422)');
      },
    });
    const response = await app.request('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(review),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Can not approve your own pull request (HTTP 422)' });
  });
});

describe('review API from other sites', () => {
  const review = { owner: 'o', repo: 'r', number: 1, verdict: 'APPROVE', body: '', comments: [] };
  const sent: unknown[] = [];
  const { app } = setup(scripted().run, {
    corsOrigins: ['http://localhost:4778'],
    submitReview: async (submitted) => (sent.push(submitted), { url: 'u' }),
  });
  const post = (headers: Record<string, string>) =>
    app.request('http://localhost:4777/api/reviews', { method: 'POST', headers, body: JSON.stringify(review) });

  it.each([
    ['a simple text/plain request', { 'Content-Type': 'text/plain' }],
    ['JSON from another origin', { 'Content-Type': 'application/json', Origin: 'https://evil.example' }],
  ])('refuses %s without sending it', async (_, headers) => {
    expect((await post(headers)).status).toBe(403);
    expect(sent).toEqual([]);
  });

  it.each([
    ['the same origin', { 'Content-Type': 'application/json', Origin: 'http://localhost:4777' }],
    ['an allowed origin', { 'Content-Type': 'application/json', Origin: 'http://localhost:4778' }],
    ['no origin (the CLI)', { 'Content-Type': 'application/json' }],
  ])('accepts JSON from %s', async (_, headers) => {
    expect((await post(headers)).status).toBe(200);
  });
});
