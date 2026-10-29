import type { RunTourOptions } from '@gloss/core';
import { createFakeModelClient, createMemoryCacheStore } from '@gloss/core';
import type { Tour, TourEvent } from '@gloss/protocol';
import { createHttpGlossClient } from '@gloss/protocol';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { JobManager } from './jobs.ts';

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
  const run = async ({ emit, signal }: RunTourOptions) => {
    runs++;
    emit({ type: 'job.started', ref, sourceKey: 'k', pipelineVersion: '1', models, cached: false });
    emit({ type: 'tour.summary', overallSummary: 'one' });
    emit({ type: 'tour.summary', overallSummary: 'two' });
    await Promise.race([
      gate,
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    ]);
    emit({ type: 'tour.complete', tour, cached: false });
    return tour;
  };
  return { run, release, runs: () => runs };
}

function setup(run: ReturnType<typeof scripted>['run'], options: Partial<Parameters<typeof createApp>[0]> = {}) {
  const cache = createMemoryCacheStore();
  const jobs = new JobManager({ cache, model: createFakeModelClient({ answers: {} }), run });
  const app = createApp({ jobs, cache, health: async () => ({}) as never, ...options });
  const client = createHttpGlossClient({
    baseUrl: 'http://gloss.test',
    fetch: async (input, init) =>
      app.request(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init),
  });
  return { client, app };
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
