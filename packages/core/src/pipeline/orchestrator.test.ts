import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SourceRef, Tour, TourEventBody, TraceStep } from '@gloss/protocol';
import { initialTourState, reduceTourEvent, tourFromState } from '@gloss/protocol';
import { Effect, Exit, Layer, Stream } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeJudgeClient, createFakeModelClient } from '../adapters/fake.ts';
import { type JudgeAnswer, JudgeClient, JudgeError, ModelClient } from '../adapters/types.ts';
import { type CacheStore, createMemoryCacheStore, TourCache } from '../cache/store.ts';
import { DiffSources } from '../sources/index.ts';
import { runTour } from './orchestrator.ts';

let repo: string;

function write(path: string, text: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'gloss-test-'));
  git('init', '-q', '-b', 'main');
  write('src/auth.ts', 'export function check() {\n  return true;\n}\n');
  write('.gitattributes', 'api/*.gen.ts linguist-generated\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  write('src/auth.ts', 'export function check(user: string) {\n  return user === "admin";\n}\n');
  write('src/auth.test.ts', 'test("check", () => {});\n');
  write('api/client.gen.ts', 'export const x = 1;\n');
  write('README.md', '# Docs\n');
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

/** Runs one tour against the fixture repo and returns its events and finished tour. */
async function tour(options: {
  model: ModelClient['Service'];
  judge?: JudgeClient['Service'];
  cache?: CacheStore;
}): Promise<{ events: TourEventBody[]; tour: Tour; trace: Map<string, TraceStep> }> {
  const ref: SourceRef = { kind: 'local', repo, target: '' };
  const layer = Layer.mergeAll(
    Layer.succeed(ModelClient, options.model),
    Layer.succeed(TourCache, options.cache ?? createMemoryCacheStore()),
    DiffSources.layer,
    options.judge ? Layer.succeed(JudgeClient, options.judge) : Layer.empty,
  );
  const trace = new Map<string, TraceStep>();
  const onStep = (step: TraceStep) => trace.set(step.id, step);
  const events = [
    ...(await Effect.runPromise(Stream.runCollect(runTour({ ref, onStep })).pipe(Effect.provide(layer)))),
  ];
  const last = events.at(-1);
  if (last?.type !== 'tour.complete') {
    throw new Error(`The tour ended with ${last?.type}`);
  }
  return { events, tour: last.tour, trace };
}

const groupsAnswer = {
  overallSummary: 'Tightens the auth check.',
  decisions: [
    { text: 'Only admins pass, with no migration for existing sessions.', priority: 'urgent', groupKey: 'auth' },
    { text: 'Ship docs with the check.', priority: 'low', groupKey: 'not-a-group' },
  ],
  visuals: {
    first: {
      kind: 'timeline',
      caption: 'When a session loses access.',
      markers: [],
      lanes: [{ label: 'After', spans: [{ from: 0, to: 60, text: 'Signed in' }] }],
    },
    second: { kind: 'mermaid', caption: 'Too vague.', mermaid: 'flowchart TD\n  A --> B\n  A --> C' },
  },
  groups: [
    { key: 'auth', label: 'Auth check', summary: 'Only admins pass.', category: 'security' },
    { key: 'docs', label: 'Docs', summary: 'Readme.', category: 'docs' },
  ],
};

/** What the sketch call draws. */
const sketchAnswer = {
  form: 'bands' as const,
  caption: 'Who passes the check.',
  svg: '<svg viewBox="0 0 760 200"><rect x="10" y="10" width="200" height="40" fill="#cfc8f5"/><text x="20" y="35">Admins only</text></svg>',
};

/** The sketch as the normalizer passes it on: sanitized, with its namespace. */
const sketch = {
  kind: 'svg',
  caption: sketchAnswer.caption,
  svg: sketchAnswer.svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '),
};

function fakeModel() {
  return createFakeModelClient({
    answers: {
      define: (request) => (request.resultName === 'sketch' ? sketchAnswer : groupsAnswer),
      followup: (request) => ({
        placements: [...request.prompt.matchAll(/^### (f[0-9a-f]+) /gm)].map((match) => ({
          fileId: match[1],
          groupKey: 'auth',
        })),
      }),
      notes: (request) => {
        const fileId = /^### (f[0-9a-f]+) /m.exec(request.prompt)?.[1] ?? 'none';
        const hunkId = /^@@ hunk (h[0-9a-f]+)/m.exec(request.prompt)?.[1] ?? 'none';
        return {
          fileNotes: [],
          lineNotes: [{ fileId, hunkId, side: 'additions', line: 2, text: 'Note.' }],
          riskNotes: [],
          decisions: [{ fileId, hunkId, side: 'additions', line: 2, text: 'Compare by name.', priority: 'high' }],
        };
      },
    },
  });
}

const fakeJudge = () =>
  createFakeJudgeClient((state, id): JudgeAnswer => {
    // A workflow, so the candidates compete: the mermaid one is wrong and the sketch shows
    // one detail, so the timeline wins.
    if (id === 'workflow') {
      return { type: 'bool', probability: 0.95 };
    }
    if (id === 'call_path') {
      return { type: 'bool', probability: 0.1 };
    }
    if (/^c\d_/.test(id)) {
      return { type: 'bool', probability: id === 'c3_accurate' || id === 'c1_whole' ? 0.2 : 0.8 };
    }
    const path = (state.file as { path: string }).path;
    if (id === 'group') {
      return path.endsWith('.md')
        ? { type: 'choice', choice: 'docs', confidence: 0.95, probabilities: { docs: 0.95, auth: 0.05 } }
        : { type: 'choice', choice: 'auth', confidence: 0.55, probabilities: { auth: 0.55, docs: 0.45 } };
    }
    if (id === 'fits_any_group') {
      return { type: 'bool', probability: 0.9 };
    }
    if (id === 'tests_only') {
      return { type: 'bool', probability: path.includes('.test.') ? 0.95 : 0.02 };
    }
    if (id === 'auth_check') {
      return { type: 'bool', probability: path === 'src/auth.ts' ? 0.9 : 0.01 };
    }
    return { type: 'bool', probability: 0.05 };
  });

describe('runTour', () => {
  it('streams a complete tour whose replayed state equals tour.complete, then replays it from cache', async () => {
    const cache = createMemoryCacheStore();
    const model = fakeModel();
    const { events, tour: finished } = await tour({ model, judge: fakeJudge(), cache });

    const types = events.map((event) => event.type);
    const index = (type: string) => types.indexOf(type as never);
    expect(index('job.started')).toBe(0);
    expect(index('diff.ready')).toBeLessThan(index('groups.provisional'));
    expect(index('groups.provisional')).toBeLessThan(index('group.defined'));
    expect(index('groups.resolved')).toBeLessThan(index('group.notes'));
    expect(types.at(-1)).toBe('tour.complete');

    // The reducer over the stream is the tour.
    const state = events.reduce(reduceTourEvent, initialTourState());
    const complete = events.at(-1) as Extract<TourEventBody, { type: 'tour.complete' }>;
    expect(tourFromState(state)).toEqual(complete.tour);

    // Every file is in exactly one group.
    const placed = finished.groups.flatMap((group) => group.fileIds);
    expect(placed.toSorted()).toEqual(finished.files.map((file) => file.id).toSorted());

    const byPath = Object.fromEntries(
      finished.files.map((file) => [file.path, finished.placements[file.id]?.groupKey]),
    );
    expect(byPath).toEqual({
      'README.md': 'docs',
      'api/client.gen.ts': 'generated',
      'src/auth.test.ts': 'tests',
      'src/auth.ts': 'auth',
    });
    expect(finished.placements[finished.files.find((file) => file.path === 'src/auth.ts')!.id]?.reason).toBe(
      'llm-followup',
    );
    expect(finished.groups.find((group) => group.key === 'auth')?.critical).toBe(true);
    expect(finished.groups.map((group) => group.key)).toEqual(['docs', 'auth', 'tests', 'generated']);
    expect(finished.notes.auth?.lineNotes).toHaveLength(1);
    // A decision keeps its group when the group exists; an unknown key leaves it change-wide.
    expect(finished.decisions).toEqual([
      groupsAnswer.decisions[0],
      { text: 'Ship docs with the check.', priority: 'low' },
    ]);
    expect(finished.visual).toEqual(groupsAnswer.visuals.first);
    expect(finished.notes.auth?.decisions?.map((decision) => decision.line)).toEqual([2]);
    // Notes see the change-wide decisions so they don't repeat them on a line.
    expect(model.calls.find((call) => call.tier === 'notes')?.prompt).toContain(groupsAnswer.decisions[0]!.text);
    // The sketch is its own call on the define model, after define, told what the tour says.
    const sketchCall = model.calls.find((call) => call.resultName === 'sketch');
    expect(sketchCall?.tier).toBe('define');
    expect(sketchCall?.prompt).toContain(groupsAnswer.overallSummary);

    // Second run: a finished tour for the same head replays as two events, with no model calls.
    const calls = model.calls.length;
    const second = await tour({ model, judge: fakeJudge(), cache });
    expect(second.events.map((event) => event.type)).toEqual(['job.started', 'tour.complete']);
    expect(model.calls.length).toBe(calls);
  });

  it('traces every step as a DAG with tagged prompts, and replays the trace with a cached tour', async () => {
    const cache = createMemoryCacheStore();
    const { trace } = await tour({ model: fakeModel(), judge: fakeJudge(), cache });
    const steps = [...trace.values()];

    expect(steps.map((step) => step.id).toSorted()).toEqual(
      [
        'define',
        'fetch',
        'followup',
        'judge-files',
        'judge-groups',
        'judge-visual',
        'notes:auth',
        'notes:docs',
        'notes:tests',
        'place',
        'sketch',
        'callstack',
      ].toSorted(),
    );
    for (const step of steps) {
      expect(step.state).toBe('done');
      expect(step.endMs).toBeGreaterThanOrEqual(step.startMs);
      for (const input of step.inputs) {
        expect(trace.has(input), `${step.id} reads ${input}`).toBe(true);
      }
    }
    // Jev was unsure about src/auth.ts, so notes read the follow-up's placements.
    const notes = trace.get('notes:auth')!;
    expect(notes.inputs).toEqual(['followup', 'define', 'judge-files']);
    expect(notes.subject).toBe('Auth check');
    const lines = notes.prompt!.split('\n');
    const from = (heading: string) =>
      notes.sections!.findLast((section) => section.line <= lines.findIndex((line) => line.startsWith(heading)))?.from;
    expect(from('# ')).toBe('fetch');
    expect(from('## This group')).toBe('define');
    expect(from('## Flagged risks')).toBe('judge-files');
    expect(from('## Files')).toBe('followup');
    expect(notes.output).toMatchObject({ lineNotes: [{ text: 'Note.' }] });
    expect(trace.get('judge-groups')!.sections?.[0]).toEqual({ line: 0, from: 'define' });

    const replayed = await tour({ model: fakeModel(), judge: fakeJudge(), cache });
    expect([...replayed.trace.values()]).toEqual(steps);
  });

  it('without a judge, the LLM lists files and nothing is dropped', async () => {
    const model = createFakeModelClient({
      answers: {
        define: (request) => {
          if (request.resultName === 'sketch') {
            return sketchAnswer;
          }
          const ids = [...request.prompt.matchAll(/^(f[0-9a-f]+) /gm)].map((match) => match[1]!);
          return { ...groupsAnswer, groups: [{ ...groupsAnswer.groups[0], fileIds: [ids[0], 'f-hallucinated'] }] };
        },
        followup: { placements: [] },
        notes: { fileNotes: [], lineNotes: [], riskNotes: [], decisions: [] },
      },
    });
    const { events, tour: finished } = await tour({ model });
    expect(
      events.some((event) => event.type === 'stage.status' && event.stage === 'judge' && event.state === 'skipped'),
    ).toBe(true);
    expect(events.some((event) => event.type === 'job.warning' && event.message.includes('f-hallucinated'))).toBe(true);
    expect(finished.groups.flatMap((group) => group.fileIds)).toHaveLength(finished.files.length);
    expect(finished.visual).toEqual(sketch);
  });

  it('shows Jev the candidates as pictures and falls back to the first when it fails', async () => {
    const judge = fakeJudge();
    const sent: number[] = [];
    const failing: JudgeClient['Service'] = {
      model: judge.model,
      judge: (request) => {
        if (!request.state.candidates) {
          return judge.judge(request);
        }
        sent.push(...(request.images ?? []).map((image) => Buffer.from(image.data, 'base64').readUInt32BE(0)));
        return Effect.fail(new JudgeError({ message: 'overloaded' }));
      },
    };
    const { events, tour: finished } = await tour({ model: fakeModel(), judge: failing });
    expect(sent).toEqual([0x89504e47, 0x89504e47, 0x89504e47]);
    expect(events.some((event) => event.type === 'job.warning' && event.message.includes('pick a visual'))).toBe(true);
    expect(finished.visual).toEqual(sketch);
  });

  it('reports a failed Jev file as a warning and still places it', async () => {
    const judge = fakeJudge();
    const failing: JudgeClient['Service'] = {
      model: judge.model,
      judge: (request) =>
        (request.state.file as { path: string } | undefined)?.path === 'README.md'
          ? Effect.fail(new JudgeError({ message: 'overloaded' }))
          : judge.judge(request),
    };
    const { events, tour: finished } = await tour({ model: fakeModel(), judge: failing });
    expect(events.some((event) => event.type === 'job.warning' && event.message.includes('README.md'))).toBe(true);
    expect(finished.groups.flatMap((group) => group.fileIds)).toHaveLength(finished.files.length);
  });

  it('ends with a pipeline error when the model cannot define groups, and traces the failed step', async () => {
    const trace = new Map<string, TraceStep>();
    const onStep = (step: TraceStep) => trace.set(step.id, step);
    const exit = await Effect.runPromiseExit(
      Stream.runCollect(runTour({ ref: { kind: 'local', repo, target: '' }, onStep })).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ModelClient, createFakeModelClient({ answers: {} })),
            TourCache.memory,
            DiffSources.layer,
          ),
        ),
      ),
    );
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain('Defining groups failed');
    expect(trace.get('define')).toMatchObject({ state: 'failed', warnings: [expect.stringContaining('tier define')] });
  });
});
