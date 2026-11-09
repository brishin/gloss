import {
  createFakeJudgeClient,
  createFakeModelClient,
  DecisionRules,
  DiffSources,
  JudgeClient,
  ModelClient,
  RepoError,
  Repos,
  StaleFileError,
  TourCache,
} from '@gloss/core';
import type { AskEvent, DecisionRuleSet, DiffPayload, Tour, TourEvent, TourEventBody } from '@gloss/protocol';
import { createHttpGlossClient } from '@gloss/protocol';
import { Effect, Layer, ManagedRuntime, Queue, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { createApp, withPullStates } from './app.ts';
import { Jobs, type RunTour } from './jobs.ts';
import { Logins } from './logins.ts';

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

/** Repository access that fails unless a test scripts it. */
const unscripted = (): Repos['Service'] => ({
  pulls: () => Effect.succeed(new Map()),
  viewer: Effect.succeed(undefined),
  inbox: Effect.succeed(undefined),
  asset: () => Effect.succeed(undefined),
  stack: () => Effect.fail(new RepoError({ message: 'unscripted' })),
  review: () => Effect.fail(new RepoError({ message: 'unscripted' })),
  contents: () => Effect.fail(new RepoError({ message: 'unscripted' })),
  lfs: () => Effect.fail(new RepoError({ message: 'unscripted' })),
});

function setup(
  run: ReturnType<typeof scripted>['run'],
  {
    repos,
    model = createFakeModelClient({ answers: {} }),
    extra = Layer.empty,
    ...options
  }: Partial<Parameters<typeof createApp>[0]> & {
    repos?: Partial<Repos['Service']>;
    model?: ModelClient['Service'];
    /** Optional services the pipeline reads with `serviceOption`. */
    extra?: Layer.Layer<DecisionRules | JudgeClient> | Layer.Layer<never>;
  } = {},
) {
  const services = Layer.mergeAll(TourCache.memory, Layer.succeed(ModelClient, model), DiffSources.layer, extra);
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(Jobs.layer({ run }), Logins.layer(), Layer.succeed(Repos, { ...unscripted(), ...repos })).pipe(
      Layer.provideMerge(services),
    ),
  );
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

  it('fills in missing PR authors and current states with one lookup, keeps authors, and names the viewer', async () => {
    const asked: unknown[][] = [];
    const { client, runtime } = setup(scripted().run, {
      repos: {
        viewer: Effect.succeed('me'),
        pulls: (refs) => {
          asked.push([...refs]);
          return Effect.succeed(
            new Map([
              ['github:o/r#1', { author: 'ana', state: 'merged' as const }],
              ['github:o/r#2', { author: 'bo', state: 'queued' as const }],
            ]),
          );
        },
      },
    });
    const pr = { kind: 'github-pr', owner: 'o', repo: 'r', number: 1 } as const;
    await runtime.runPromise(
      TourCache.use((cache) =>
        Effect.sync(() => {
          cache.recordRecent(pr, 'pr1', 'One');
          cache.recordRecent({ ...pr, number: 2 }, 'pr2', 'Two', 'bo');
        }),
      ),
    );

    const first = await client.recent();
    expect(first.viewer).toBe('me');
    expect(first.tours.map((tour) => [tour.title, tour.author, tour.state])).toEqual([
      ['Two', 'bo', 'queued'],
      ['One', 'ana', 'merged'],
    ]);
    expect(asked).toEqual([[{ ...pr, number: 2 }, pr]]);
    await client.recent();
    expect(asked).toHaveLength(2);
  });

  it('a stack member takes its state from the lookup, else keeps the recorded one', () => {
    const two = { ...stack, members: [...stack.members, { ...stack.members[0]!, number: 2 }] };
    const tour = {
      ref: { kind: 'github-pr', owner: 'o', repo: 'r', number: 1 },
      title: 't',
      stack: two,
      updatedAt: '',
    } as const;
    const fresh = withPullStates(tour, new Map([['github:o/r#2', { state: 'merged' as const }]]));
    expect(fresh.state).toBeUndefined();
    expect(fresh.stack?.members.map((member) => member.state)).toEqual(['open', 'merged']);
  });

  it('round-trips a stack through the client', async () => {
    const asked: unknown[] = [];
    const { client } = setup(scripted().run, {
      repos: {
        stack: (stackRef) => {
          asked.push(stackRef);
          return Effect.succeed(stack);
        },
      },
    });
    expect(await client.stack(ref)).toEqual(stack);
    expect(asked).toEqual([ref]);
  });

  it('rejects a request without a PR number', async () => {
    const { app } = setup(scripted().run, { repos: { stack: () => Effect.succeed(stack) } });
    expect((await app.request('/api/stack?owner=o&repo=r')).status).toBe(400);
  });

  it('reports a failed lookup as a bad gateway', async () => {
    const { app } = setup(scripted().run, {
      repos: { stack: () => Effect.fail(new RepoError({ message: 'gh is not signed in' })) },
    });
    const response = await app.request('/api/stack?owner=o&repo=r&number=1');
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'gh is not signed in' });
  });

  const pair = {
    ...stack,
    members: [
      { ...stack.members[0]!, title: 'Add the name call', blurb: 'Names stacks with the fast model.' },
      { ...stack.members[0]!, number: 2, title: 'Show names in the rail', baseRef: 'feature', headRef: 'rail' },
    ],
  };

  it('names a stack with the small tier once, then from the cache even after a PR merges', async () => {
    const model = createFakeModelClient({ answers: { small: { name: '"Stack names in the rail."' } } });
    const { client } = setup(scripted().run, { model });
    expect(await client.stackName(pair)).toBe('Stack names in the rail');
    const merged = { ...pair, members: [{ ...pair.members[0]!, state: 'merged' as const }, pair.members[1]!] };
    expect(await client.stackName(merged)).toBe('Stack names in the rail');
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.prompt).toContain(
      '#1 Add the name call (branch feature)\n  Names stacks with the fast model.',
    );
    expect(model.calls[0]!.prompt).toContain('#2 Show names in the rail (branch rail)');
  });

  it('does not name a stack of one, or a request from another site', async () => {
    const { app } = setup(scripted().run);
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      app.request('/api/stack/name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    expect((await post(stack)).status).toBe(400);
    expect((await post(pair, { Origin: 'https://evil.example' })).status).toBe(403);
  });

  it('reports a failed model call as a bad gateway', async () => {
    const { app } = setup(scripted().run);
    const response = await app.request('/api/stack/name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pair),
    });
    expect(response.status).toBe(502);
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
      repos: {
        contents: (fromDiff, fromFile) => {
          asked.push([fromDiff.id, fromFile.id]);
          return Effect.succeed({ oldContents: 'a\nb\n', newContents: 'a\nB\n' });
        },
      },
    });
    await runtime.runPromise(TourCache.use((cache) => Effect.sync(() => cache.put('d1', 'diff', diff))));
    expect(await client.fileContents('d1', 'f1')).toEqual({ oldContents: 'a\nb\n', newContents: 'a\nB\n' });
    expect(asked).toEqual([['d1', 'f1']]);
  });

  it('answers 404 for an unknown diff or file, and 502 when the read fails', async () => {
    const { app, runtime } = setup(scripted().run, {
      repos: { contents: () => Effect.fail(new RepoError({ message: 'gh is not signed in' })) },
    });
    await runtime.runPromise(TourCache.use((cache) => Effect.sync(() => cache.put('d1', 'diff', diff))));
    expect((await app.request('/api/diffs/nope/files/f1')).status).toBe(404);
    expect((await app.request('/api/diffs/d1/files/nope')).status).toBe(404);
    expect((await app.request('/api/diffs/d1/files/f1')).status).toBe(502);
  });

  it('answers 409 when the file no longer matches the diff', async () => {
    const { app, runtime } = setup(scripted().run, { repos: { contents: () => Effect.fail(new StaleFileError()) } });
    await runtime.runPromise(TourCache.use((cache) => Effect.sync(() => cache.put('d1', 'diff', diff))));
    expect((await app.request('/api/diffs/d1/files/f1')).status).toBe(409);
  });
});

describe('LFS object API', () => {
  const oid = 'a'.repeat(64);
  const file = {
    id: 'f1',
    path: 'snap/home.png',
    status: 'added' as const,
    additions: 3,
    deletions: 0,
    isBinary: false,
    truncated: false,
    hunks: [
      {
        id: 'h1',
        header: '@@ -0,0 +1,3 @@',
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 3,
        patch: `+version https://git-lfs.github.com/spec/v1\n+oid sha256:${oid}\n+size 3`,
      },
    ],
  };
  const diff = { id: 'd1', ref, sourceKey: 'k', fingerprint: 'f', meta: tour.meta, files: [file] };

  it('serves an object the diff names, as its file type', async () => {
    const asked: unknown[] = [];
    const { client, app, runtime } = setup(scripted().run, {
      repos: {
        lfs: (fromDiff, object) => {
          asked.push([fromDiff.id, object]);
          return Effect.succeed(new Uint8Array([1, 2, 3]));
        },
      },
    });
    await runtime.runPromise(TourCache.use((cache) => Effect.sync(() => cache.put('d1', 'diff', diff))));
    const blob = await client.lfsObject('d1', oid);
    expect(blob.type).toBe('image/png');
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(asked).toEqual([['d1', { oid, size: 3 }]]);
    expect((await app.request(`/api/diffs/d1/lfs/${oid}`)).headers.get('Content-Security-Policy')).toContain('sandbox');
  });

  it('answers 404 for an object the diff does not name', async () => {
    const { app, runtime } = setup(scripted().run, { repos: { lfs: () => Effect.succeed(new Uint8Array()) } });
    await runtime.runPromise(TourCache.use((cache) => Effect.sync(() => cache.put('d1', 'diff', diff))));
    expect((await app.request(`/api/diffs/d1/lfs/${'b'.repeat(64)}`)).status).toBe(404);
    expect((await app.request(`/api/diffs/nope/lfs/${oid}`)).status).toBe(404);
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
      repos: {
        review: (submitted) => {
          sent.push(submitted);
          return Effect.succeed({ url: 'https://github.com/o/r/pull/1#pullrequestreview-1' });
        },
      },
    });
    expect(await client.review(review)).toEqual({ url: 'https://github.com/o/r/pull/1#pullrequestreview-1' });
    expect(sent).toEqual([review]);
  });

  it('refuses a review GitHub would refuse, without sending it', async () => {
    const sent: unknown[] = [];
    const { app } = setup(scripted().run, {
      repos: { review: (submitted) => (sent.push(submitted), Effect.succeed({ url: '' })) },
    });
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
      repos: {
        review: () => Effect.fail(new RepoError({ message: 'Can not approve your own pull request (HTTP 422)' })),
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
    repos: { review: (submitted) => (sent.push(submitted), Effect.succeed({ url: 'u' })) },
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

describe('setup API', () => {
  const status = {
    github: { state: 'signed-in' as const, login: 'octocat' },
    extension: { dir: '/x/apps/extension', id: 'a'.repeat(32), hostInstalled: false },
  };
  function hooks() {
    const calls: string[] = [];
    return {
      calls,
      setup: {
        status: async () => status,
        githubLogin: async () => ({ code: 'ABCD-1234', url: 'https://github.com/login/device' }),
        installNativeHost: async () => void calls.push('host'),
        saveJudgeKey: async (key: string) => void calls.push(`key:${key}`),
      },
    };
  }

  it('round-trips each setup call through the client', async () => {
    const { calls, setup: setupHooks } = hooks();
    const { client } = setup(scripted().run, { setup: setupHooks });
    expect(await client.setup()).toEqual(status);
    expect(await client.githubLogin()).toEqual({ code: 'ABCD-1234', url: 'https://github.com/login/device' });
    await client.installNativeHost();
    await client.saveJudgeKey('  tsk-1  ');
    expect(calls).toEqual(['host', 'key:tsk-1']);
  });

  it('has no setup routes when the backend gives no hooks', async () => {
    const { app } = setup(scripted().run);
    expect((await app.request('/api/setup')).status).toBe(404);
  });

  it('takes changes only as JSON from the app, and refuses an empty key', async () => {
    const { calls, setup: setupHooks } = hooks();
    const { app } = setup(scripted().run, { setup: setupHooks });
    const form = await app.request('/api/setup/extension', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(form.status).toBe(403);
    const empty = await app.request('/api/setup/judge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: ' ' }),
    });
    expect(empty.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('decision rules API', () => {
  function rulesLayer(judge = true) {
    let saved: readonly DecisionRuleSet[] = [{ rules: ['Flag A'] }];
    const layer = Layer.mergeAll(
      Layer.succeed(DecisionRules, {
        get: Effect.sync(() => saved),
        save: (sets) => Effect.sync(() => void (saved = sets)),
      }),
      judge
        ? Layer.succeed(
            JudgeClient,
            createFakeJudgeClient((_, id) =>
              id === 'overlaps_r2' ? { type: 'bool', probability: 0.9 } : { type: 'bool', probability: 0.1 },
            ),
          )
        : Layer.empty,
    );
    return { layer, saved: () => saved };
  }

  it('reads and saves the rule sets, with what Jev finds in them', async () => {
    const rules = rulesLayer();
    const { client } = setup(scripted().run, { extra: rules.layer });
    expect(await client.decisionRules()).toEqual({ sets: [{ rules: ['Flag A'] }], findings: [], checked: true });
    const sets = [{ rules: ['Flag A'] }, { files: '\\.py$', rules: [' Flag a too '] }];
    expect(await client.saveDecisionRules(sets)).toEqual({
      sets: [{ rules: ['Flag A'] }, { files: '\\.py$', rules: ['Flag a too'] }],
      findings: [{ set: 0, rule: 0, kind: 'overlap', other: { set: 1, rule: 0 } }],
      checked: true,
    });
    expect(rules.saved()).toEqual([{ rules: ['Flag A'] }, { files: '\\.py$', rules: ['Flag a too'] }]);
  });

  it('saves unchecked without Jev', async () => {
    const { client } = setup(scripted().run, { extra: rulesLayer(false).layer });
    expect(await client.saveDecisionRules([{ rules: ['Flag B'] }])).toEqual({
      sets: [{ rules: ['Flag B'] }],
      findings: [],
      checked: false,
    });
  });

  it('takes rules only as JSON from the app, with a valid files pattern', async () => {
    const rules = rulesLayer();
    const { app } = setup(scripted().run, { extra: rules.layer });
    const put = (contentType: string, body: unknown) =>
      app.request('/api/rules', {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: JSON.stringify(body),
      });
    expect((await put('text/plain', { sets: [] })).status).toBe(403);
    expect((await put('application/json', { sets: [{ files: '(', rules: ['Flag A'] }] })).status).toBe(400);
    expect(rules.saved()).toEqual([{ rules: ['Flag A'] }]);
  });

  it('has the model rewrite the rules without saving them', async () => {
    const rules = rulesLayer();
    const model = createFakeModelClient({
      answers: { define: { rules: [{ text: 'Flag B', files: '' }], reply: 'Swapped A for B.' } },
    });
    const { client, app } = setup(scripted().run, { extra: rules.layer, model });
    expect(await client.editDecisionRules({ rules: [{ text: 'Flag A' }], instruction: 'replace A with B' })).toEqual({
      rules: [{ text: 'Flag B' }],
      reply: 'Swapped A for B.',
    });
    expect(rules.saved()).toEqual([{ rules: ['Flag A'] }]);
    const form = await app.request('/api/rules/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ rules: [], instruction: 'x' }),
    });
    expect(form.status).toBe(403);
  });

  it('has no rules when the backend keeps none', async () => {
    const { app } = setup(scripted().run);
    expect((await app.request('/api/rules')).status).toBe(404);
  });
});

describe('update API', () => {
  const status = { running: 'a', head: 'a', behind: 2 };

  it('reports the status and applies an update through the client', async () => {
    let applied = 0;
    const { client } = setup(scripted().run, {
      update: { status: async () => status, apply: async () => void applied++ },
    });
    expect(await client.updateStatus()).toEqual(status);
    await client.update();
    expect(applied).toBe(1);
  });

  it('answers 404 when the backend does not update itself, and 500 with the reason when an update fails', async () => {
    expect((await setup(scripted().run).app.request('/api/update')).status).toBe(404);
    const { client } = setup(scripted().run, {
      update: {
        status: async () => status,
        apply: async () => {
          throw new Error('Not possible to fast-forward');
        },
      },
    });
    await expect(client.update()).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining('fast-forward'),
    });
  });

  it('refuses an update that is not JSON from the app', async () => {
    let applied = 0;
    const { app } = setup(scripted().run, {
      update: { status: async () => status, apply: async () => void applied++ },
    });
    const form = await app.request('/api/update', { method: 'POST' });
    const other = await app.request('http://gloss.test/api/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' },
      body: '{}',
    });
    expect([form.status, other.status, applied]).toEqual([403, 403, 0]);
  });
});

describe('ask API', () => {
  const diff: DiffPayload = { id: 'd', ref, sourceKey: 'k', fingerprint: 'x', meta: tour.meta, files: [] };

  it.each([
    ['the default model', undefined, 'fake/mid'],
    ['the picked model', 'fake/large', 'fake/large'],
    ['the default for a model the backend does not offer', 'other/model', 'fake/mid'],
  ])('streams the answer of %s', async (_, picked, used) => {
    const model = createFakeModelClient({ answers: {}, chat: (request) => `Asked ${request.model}.` });
    const { client, runtime } = setup(scripted().run, { model });
    await runtime.runPromise(TourCache.use((cache) => Effect.sync(() => cache.put('d', 'diff', diff))));
    const events: AskEvent[] = [];
    for await (const event of client.ask({ tour, question: 'Why?', ...(picked ? { model: picked } : {}) })) {
      events.push(event);
    }
    expect(events.map((event) => (event.type === 'ask.delta' ? event.text : event.type)).join('')).toBe(
      `Asked ${used}.ask.done`,
    );
  });

  it('refuses a tour whose diff is not cached, and a blank question', async () => {
    const { client } = setup(scripted().run);
    await expect(async () => {
      for await (const _ of client.ask({ tour, question: 'Why?' })) {
        // Nothing streams.
      }
    }).rejects.toThrow(/Unknown diff/);
    await expect(async () => {
      for await (const _ of client.ask({ tour, question: '  ' })) {
        // Nothing streams.
      }
    }).rejects.toThrow(/Invalid request/);
  });
});
