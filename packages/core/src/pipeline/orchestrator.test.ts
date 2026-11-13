import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DecisionRuleSet, SourceRef, Tour, TourEventBody, TraceStep } from '@gloss/protocol';
import { initialTourState, reduceTourEvent, tourFromState } from '@gloss/protocol';
import { Effect, Exit, Layer, Stream } from 'effect';
import type * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeJudgeClient, createFakeModelClient } from '../adapters/fake.ts';
import {
  DecisionRules,
  type JudgeAnswer,
  JudgeClient,
  JudgeError,
  ModelClient,
  ModelError,
  type ModelRequest,
} from '../adapters/types.ts';
import { type CacheStore, createMemoryCacheStore, TourCache } from '../cache/store.ts';
import { DiffSources, EMPTY_REPO_CONFIG, RepoClones, type RepoConfig, RepoConfigs } from '../sources/index.ts';
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
  write('src/login.ts', "import { check } from './auth';\n");
  write('src/screen.ts', "import { login } from './login';\nif (useFlag('new-auth')) login();\n");
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
  rules?: DecisionRuleSet[];
  repoConfig?: RepoConfig;
}): Promise<{ events: TourEventBody[]; tour: Tour; trace: Map<string, TraceStep> }> {
  const ref: SourceRef = { kind: 'local', repo, target: '' };
  const layer = Layer.mergeAll(
    Layer.succeed(ModelClient, options.model),
    Layer.succeed(TourCache, options.cache ?? createMemoryCacheStore()),
    DiffSources.layer,
    RepoClones.layer(join(tmpdir(), 'gloss-test-clones')),
    options.judge ? Layer.succeed(JudgeClient, options.judge) : Layer.empty,
    options.rules
      ? Layer.succeed(DecisionRules, { get: Effect.succeed(options.rules), save: () => Effect.void })
      : Layer.empty,
    options.repoConfig
      ? Layer.succeed(RepoConfigs, { get: () => Effect.succeed(options.repoConfig ?? EMPTY_REPO_CONFIG) })
      : Layer.empty,
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

/** What the description check finds: nothing, unless a test says otherwise. */
const checkAnswer = { claims: [], stated: '', areas: [], decisions: [] };
type DefineAnswer = (request: ModelRequest<v.GenericSchema>) => unknown;
/** What the affected call maps: one surface that changes and one that should not. */
const affectedAnswer = {
  systems: [{ name: 'Auth', fileIds: [], change: 'Adds a check.', usedBy: ['Login page'] }],
  surfaces: [
    {
      surface: 'Login page',
      audience: 'everyone',
      effect: 'unchanged',
      what: 'Check sign-in still works.',
      evidence: '',
    },
    { surface: 'Admin login', audience: 'admins', effect: 'changes', what: 'Asks for a code.', evidence: 'auth.ts:3' },
  ],
};
const withCheck =
  (answer: DefineAnswer, check: unknown = checkAnswer, affected: unknown = affectedAnswer): DefineAnswer =>
  (request) =>
    request.resultName === 'descriptionCheck' ? check : request.resultName === 'affected' ? affected : answer(request);

/** One stop of a group's walk, on line 2 of a hunk: the group's first listed decision. */
const walkStop = (fileId: string, hunkId: string) => ({
  kind: 'decision',
  decision: 0,
  priority: 'high',
  title: 'Compares the name',
  why: 'No role table yet.',
  instead: '',
  check: '',
  snippets: [{ fileId, hunkId, from: 1, to: 2, focus: 2, caption: 'The check.', note: '' }],
  wide: -1,
  tree: 'none',
  nodes: [],
});
const walkAnswer = (points: unknown[]) => ({ intro: 'Builds on the group before.', points, rest: '', skim: [] });

function fakeModel() {
  return createFakeModelClient({
    answers: {
      define: withCheck((request) =>
        request.resultName === 'sketch'
          ? sketchAnswer
          : request.resultName === 'walkthrough'
            ? { decisions: [] }
            : request.resultName === 'callpath'
              ? { frames: [], steps: [] }
              : groupsAnswer,
      ),
      followup: (request) => ({
        placements: [...request.prompt.matchAll(/^### (f[0-9a-f]+) /gm)].map((match) => ({
          fileId: match[1],
          groupKey: 'auth',
        })),
      }),
      notes: (request) => {
        const fileId = /^### (f[0-9a-f]+) /m.exec(request.prompt)?.[1] ?? 'none';
        const hunkId = /^@@ hunk (h[0-9a-f]+)/m.exec(request.prompt)?.[1] ?? 'none';
        if (request.resultName === 'walk') {
          return walkAnswer([walkStop(fileId, hunkId)]);
        }
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
    expect(finished.visuals).toEqual([groupsAnswer.visuals.first]);
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

  it("puts the user's decision rules in the define and notes prompts by files, and keys the tour on them", async () => {
    const cache = createMemoryCacheStore();
    const model = fakeModel();
    await tour({ model, judge: fakeJudge(), cache });
    const plain = model.calls.length;
    expect(model.calls.some((call) => call.prompt.includes("## Reviewer's decision rules"))).toBe(false);

    const sets = [
      { rules: ['Flag every new environment variable'] },
      { files: 'src/auth.ts', rules: ['Flag a weaker auth check as urgent'] },
      { files: '*.py', rules: ['Flag a service passed by global'] },
    ];
    const second = await tour({ model, judge: fakeJudge(), cache, rules: sets });
    // A tour cached without rules is not reused once there are rules.
    expect(second.events[0]).toMatchObject({ type: 'job.started', cached: false });
    const calls = model.calls.slice(plain);
    const define = calls.find((call) => call.resultName === 'groups')!.prompt;
    expect(define).toContain(
      '- Flag every new environment variable\n- Flag a weaker auth check as urgent (only in src/auth.ts)',
    );
    expect(define).not.toContain('Flag a service passed by global');
    const notes = (key: string) =>
      calls.find((call) => call.tier === 'notes' && call.prompt.includes(`## This group: ${key}`))?.prompt ?? '';
    expect(notes('Auth check')).toContain('- Flag a weaker auth check as urgent');
    expect(notes('Docs')).toContain('- Flag every new environment variable');
    expect(notes('Docs')).not.toContain('Flag a weaker auth check');

    // Same rules again: the finished tour replays.
    const third = await tour({ model, judge: fakeJudge(), cache, rules: sets });
    expect(third.events.map((event) => event.type)).toEqual(['job.started', 'tour.complete']);
  });

  it("puts the repository's rules before the user's, and keys the tour on them", async () => {
    const cache = createMemoryCacheStore();
    const model = fakeModel();
    const rules = [{ rules: ['Flag every new environment variable'] }];
    await tour({ model, judge: fakeJudge(), cache, rules });
    const before = model.calls.length;
    const repoConfig = { decisionRules: [{ rules: ['Flag a new public endpoint'] }] };
    const second = await tour({ model, judge: fakeJudge(), cache, rules, repoConfig });
    expect(second.events[0]).toMatchObject({ type: 'job.started', cached: false });
    const define = model.calls.slice(before).find((call) => call.resultName === 'groups')!.prompt;
    expect(define).toContain('- Flag a new public endpoint\n- Flag every new environment variable');
    // An empty repository config keys the tour as no config does.
    const third = await tour({ model, judge: fakeJudge(), cache, rules, repoConfig: EMPTY_REPO_CONFIG });
    expect(third.events[0]).toMatchObject({ type: 'job.started', cached: true });
  });

  it('adds what the description check finds to the change-wide decisions, only when the description makes claims', async () => {
    const outside = { text: 'Described as admin-only, but every user runs the new check.', priority: 'medium' };
    // A gap must quote what it breaks; one whose quote the title, description and commits lack is dropped.
    const unquoted = {
      quote: 'admins only, behind a flag',
      text: 'Not behind a flag.',
      priority: 'low',
      admittedBy: '',
    };
    // A gap the description already admits is dropped too.
    const admitted = {
      quote: 'Working tree changes',
      text: 'Also changes the CLI.',
      priority: 'low',
      admittedBy: 'Working tree changes',
    };
    const withFinding = (claims: { claim: string; status: string }[]) => {
      const base = fakeModel();
      return createFakeModelClient({
        answers: {
          define: withCheck((request) => base.prompt(request).pipe(Effect.runSync).data, {
            claims,
            stated: 'Admin only',
            areas: [{ area: 'Auth', fileIds: [], reachedBy: 'every user', described: true, inScope: false }],
            decisions: [
              { ...outside, quote: 'Working tree changes', admittedBy: '', groupKey: 'auth' },
              unquoted,
              admitted,
            ],
          }),
          followup: (request) => base.prompt(request).pipe(Effect.runSync).data,
          notes: (request) => base.prompt(request).pipe(Effect.runSync).data,
        },
      });
    };
    const model = withFinding([{ claim: 'Admin only', status: 'contradicted' }]);
    const { tour: finished } = await tour({ model, judge: fakeJudge() });
    expect(finished.decisions).toEqual([
      groupsAnswer.decisions[0],
      { text: 'Ship docs with the check.', priority: 'low' },
      { ...outside, source: 'description' },
    ]);
    // It reads the same change as define, on the define model.
    const checkCall = model.calls.find((call) => call.resultName === 'descriptionCheck')!;
    expect(checkCall.tier).toBe('define');
    expect(checkCall.prompt).toContain('## Diffs');
    // It sees define's decisions so it can skip gaps they already make; the walkthrough does not walk its gaps.
    expect(checkCall.prompt).toContain(groupsAnswer.decisions[0]!.text);
    const walkCall = model.calls.find((call) => call.resultName === 'walkthrough')!;
    expect(walkCall.prompt).not.toContain(outside.text);

    const unstated = await tour({ model: withFinding([]), judge: fakeJudge() });
    expect(unstated.tour.decisions).toHaveLength(2);
  });

  it('reads the change-wide decisions in code, right after the groups are defined', async () => {
    const authId = (prompt: string) => /^### (f[0-9a-f]+) src\/auth\.ts/m.exec(prompt)![1]!;
    const hunkId = (prompt: string) =>
      new RegExp(`### ${authId(prompt)} [^\\n]*\\n@@ hunk (h[0-9a-f]+)`).exec(prompt)![1]!;
    const base = fakeModel();
    const model = createFakeModelClient({
      answers: {
        define: withCheck((request) => {
          if (request.resultName === 'walkthrough') {
            const fileId = authId(request.prompt);
            const at = {
              fileId,
              hunkId: hunkId(request.prompt),
              from: 1,
              to: 3,
              focus: 2,
              caption: 'The check.',
              note: '',
            };
            const call = { receiver: '', args: '', label: '', note: '', fileId: '', line: 0, snippet: -1 };
            return {
              decisions: [
                {
                  decision: 0,
                  title: 'Only admins pass',
                  why: 'Compares the name.',
                  instead: 'A role table',
                  check: 'Existing sessions keep access.',
                  snippets: [at],
                  tree: 'calls',
                  nodes: [
                    { ...call, depth: 0, name: 'route', status: 'same' },
                    { ...call, depth: 1, name: 'check', args: 'user', fileId, line: 1, status: 'changed', snippet: 0 },
                  ],
                  refs: [],
                  links: [{ to: 1, text: 'The docs say so.' }],
                },
              ],
            };
          }
          if (request.resultName === 'callpath') {
            // A path the decision's tree does not walk: its new function is not on that tree.
            const fileId = authId(request.prompt);
            const at = { fileId, hunkId: hunkId(request.prompt), from: 1, to: 3 };
            return {
              frames: [
                { depth: 0, receiver: '', name: 'login', args: '', fileId: '', line: 0, status: 'same' },
                { depth: 1, receiver: '', name: 'audit', args: 'user', fileId, line: 1, status: 'new' },
              ],
              steps: [
                { title: 'Login audits', text: 'Calls the audit.', frames: [0], excerpts: [at] },
                { title: 'The audit', text: 'Logs the user.', frames: [1], excerpts: [at] },
              ],
            };
          }
          return request.resultName === 'sketch' ? sketchAnswer : groupsAnswer;
        }),
      },
    });
    const { events, tour: finished } = await tour({
      model: {
        ...model,
        prompt: (request) => (request.tier === 'define' ? model.prompt(request) : base.prompt(request)),
      },
      judge: fakeJudge(),
    });
    const [walk] = finished.walkthrough!.decisions;
    expect(walk).toMatchObject({ decision: 0, title: 'Only admins pass', instead: 'A role table' });
    expect(walk!.tree).toEqual([
      { kind: 'call', depth: 0, name: 'route', status: 'same' },
      {
        kind: 'call',
        depth: 1,
        name: 'check',
        args: 'user',
        path: 'src/auth.ts',
        line: 1,
        status: 'changed',
        snippet: 0,
      },
    ]);
    expect(walk!.snippets).toEqual([expect.objectContaining({ from: 1, to: 3, focus: 2, caption: 'The check.' })]);
    expect(finished.walkthrough!.frames.map((frame) => frame.name)).toEqual(['login', 'audit']);
    expect(finished.walkthrough!.steps.map((step) => step.title)).toEqual(['Login audits', 'The audit']);
    expect(model.calls.some((call) => call.resultName === 'callpath')).toBe(true);
    // The prompt numbers the decisions it reads, from 0.
    const call = model.calls.find((call) => call.resultName === 'walkthrough');
    expect(call?.prompt).toContain(`0. (urgent) ${groupsAnswer.decisions[0]!.text}`);
    expect(events.findIndex((event) => event.type === 'tour.walkthrough')).toBeGreaterThan(0);
    expect(events.reduce(reduceTourEvent, initialTourState()).walkthrough).toEqual(finished.walkthrough);

    // When no decision shows in code, the tour has no walkthrough.
    const plain = fakeModel();
    const other = await tour({ model: plain, judge: fakeJudge() });
    expect(plain.calls.some((call) => call.resultName === 'walkthrough')).toBe(true);
    expect(other.tour.walkthrough).toBeUndefined();
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
        'section:auth',
        'section:docs',
        'section:tests',
        'place',
        'description-check',
        'affected',
        'sketch',
        'walkthrough',
        'callpath',
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

  it("sends a group's notes at once and again with its walk, which waits for the walkthrough", async () => {
    const base = fakeModel();
    const model: ModelClient['Service'] = {
      ...base,
      // The walkthrough lands last, so every walk has to wait for it.
      prompt: (request) =>
        request.resultName === 'walkthrough'
          ? Effect.sleep(40).pipe(Effect.flatMap(() => base.prompt(request)))
          : base.prompt(request),
    };
    const { events, tour: finished } = await tour({ model, judge: fakeJudge() });
    const types = events.map((event) =>
      event.type === 'group.notes' ? `${event.groupKey}${event.notes.section ? ' walk' : ''}` : event.type,
    );
    // Every group's notes are out before any walk: the walks wait for the walkthrough, the notes do not.
    const firstWalk = types.findIndex((type) => type.endsWith(' walk'));
    for (const key of ['docs', 'auth', 'tests']) {
      expect(types.indexOf(key)).toBeGreaterThan(-1);
      expect(types.indexOf(key)).toBeLessThan(firstWalk);
      expect(types.indexOf(`${key} walk`)).toBeGreaterThan(-1);
    }
    // The notes stage ends only when the walks are in.
    const done = events.findIndex(
      (event) => event.type === 'stage.status' && event.stage === 'notes' && event.state === 'done',
    );
    expect(done).toBeGreaterThan(types.lastIndexOf('tests walk'));
    const walk = finished.notes.auth!.section!;
    expect(walk.points).toMatchObject([
      { kind: 'decision', decision: 0, priority: 'high', title: 'Compares the name' },
    ]);
    // The first group has nothing before it to tie to; the walk call is told which groups came before.
    expect(finished.notes.docs!.section!.intro).toBeUndefined();
    expect(walk.intro).toBe('Builds on the group before.');
    const asked = base.calls.find((call) => call.resultName === 'walk' && call.prompt.includes('src/auth.ts'))!;
    expect(asked.tier).toBe('notes');
    expect(asked.prompt).toContain('## Groups read before this one\n- Docs: Readme.');
    expect(asked.prompt).toContain('Decisions in this group:\n0. (high) src/auth.ts:2 Compare by name.');
  });

  it('a failed walk call leaves the group its notes, with a warning', async () => {
    const base = fakeModel();
    const model: ModelClient['Service'] = {
      ...base,
      prompt: (request) =>
        request.resultName === 'walk' ? Effect.fail(new ModelError({ message: 'overloaded' })) : base.prompt(request),
    };
    const { events, tour: finished } = await tour({ model, judge: fakeJudge() });
    expect(finished.notes.auth?.lineNotes).toHaveLength(1);
    expect(finished.notes.auth?.section).toBeUndefined();
    expect(events.filter((event) => event.type === 'job.warning' && event.message.includes('walk'))).toHaveLength(3);
    expect(events.some((event) => event.type === 'job.error')).toBe(false);
  });

  it('folds a hunk Jev can skip, flags a contract change, and offers a key hunk the walk misses to a follow-up call', async () => {
    const base = fakeModel();
    const empty = { fileNotes: [], lineNotes: [], riskNotes: [], decisions: [] };
    const model = createFakeModelClient({
      answers: {
        define: (request) => base.prompt(request).pipe(Effect.runSync).data,
        followup: (request) => base.prompt(request).pipe(Effect.runSync).data,
        // Nothing points at any hunk, so what happens to each is up to Jev.
        notes: (request) => {
          if (request.resultName !== 'walk') {
            return empty;
          }
          const fileId = /^### (f[0-9a-f]+) /m.exec(request.prompt)?.[1] ?? 'none';
          const hunkId = /^@@ hunk (h[0-9a-f]+)/m.exec(request.prompt)?.[1] ?? 'none';
          return request.prompt.includes('## Hunks the walk does not reach')
            ? { points: [{ ...walkStop(fileId, hunkId), decision: -1, title: 'The rule itself' }], rest: '' }
            : walkAnswer([]);
        },
      },
    });
    const files = fakeJudge();
    const sure: Record<string, string[]> = {
      'README.md': ['skip', 'contract', 'key'],
      'src/auth.test.ts': ['contract'],
      'src/auth.ts': ['contract', 'key'],
    };
    const states: Record<string, unknown>[] = [];
    const judge: JudgeClient['Service'] = {
      ...files,
      judge: (request) => {
        if (!('hunk' in request.state)) {
          return files.judge(request);
        }
        states.push(request.state);
        const path = (request.state.file as { path: string }).path;
        return Effect.succeed(
          Object.fromEntries(
            Object.keys(request.questions).map((id): [string, JudgeAnswer] => [
              id,
              { type: 'bool', probability: sure[path]?.includes(id) ? 0.9 : 0.1 },
            ]),
          ),
        );
      },
    };
    const { tour: finished, trace } = await tour({ model, judge });
    const id = (path: string) => finished.files.find((file) => file.path === path)!.id;
    // A skippable hunk folds, and is neither flagged nor offered.
    expect(finished.notes.docs!.section).toMatchObject({ points: [], skimHunks: [{ fileId: id('README.md') }] });
    expect(finished.notes.docs!.section!.hunkFlags).toBeUndefined();
    // A contract change nothing points at gets a note on its first changed line.
    expect(finished.notes.tests!.section!.hunkFlags).toEqual([
      { fileId: id('src/auth.test.ts'), hunkId: expect.any(String), side: 'additions', line: 1, flag: 'contract' },
    ]);
    // A key hunk gets a stop from the follow-up call, which says more than its flag would.
    expect(finished.notes.auth!.section).toMatchObject({ points: [{ kind: 'decision', title: 'The rule itself' }] });
    expect(finished.notes.auth!.section!.hunkFlags).toBeUndefined();
    expect([...trace.keys()].filter((step) => step.startsWith('section-key:'))).toEqual(['section-key:auth']);
    // The skip question is asked without the change's summary, the wider ones with it.
    const readme = states.filter((state) => (state.file as { path: string }).path === 'README.md');
    expect(readme).toHaveLength(2);
    expect(readme.filter((state) => 'change_summary' in state)).toHaveLength(1);
  });

  it('lists the description gaps in every notes prompt, however late the check lands', async () => {
    const base = fakeModel();
    const gap = { text: 'Described as admin-only, but every user runs the new check.', priority: 'medium' };
    const check = {
      claims: [{ claim: 'Admin only', status: 'contradicted' }],
      stated: 'Admin only',
      areas: [],
      decisions: [{ ...gap, quote: 'Working tree changes', admittedBy: '' }],
    };
    const model: ModelClient['Service'] = {
      ...base,
      prompt: (request) =>
        request.resultName === 'descriptionCheck'
          ? Effect.sleep(40).pipe(Effect.as({ data: check as never, model: 'fake/define' }))
          : base.prompt(request),
    };
    await tour({ model, judge: fakeJudge() });
    const prompts = base.calls.filter((call) => call.resultName === 'notes').map((call) => call.prompt);
    expect(prompts).toHaveLength(3);
    for (const notesPrompt of prompts) {
      expect(notesPrompt).toContain(gap.text);
    }
  });

  it('without a judge, the LLM lists files and nothing is dropped', async () => {
    const model = createFakeModelClient({
      answers: {
        define: withCheck((request) => {
          if (request.resultName === 'sketch') {
            return sketchAnswer;
          }
          const ids = [...request.prompt.matchAll(/^(f[0-9a-f]+) /gm)].map((match) => match[1]!);
          return { ...groupsAnswer, groups: [{ ...groupsAnswer.groups[0], fileIds: [ids[0], 'f-hallucinated'] }] };
        }),
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
    expect(finished.visuals).toEqual([sketch]);
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
    expect(finished.visuals).toEqual([sketch]);
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

  it('lets notes, the walkthrough and the affected map read files at the head, and traces what they read', async () => {
    const base = fakeModel();
    const outputs: string[][] = [];
    const searched: string[] = [];
    const model: ModelClient['Service'] = {
      ...base,
      prompt: (request) =>
        Effect.gen(function* () {
          const find = request.tools?.find((tool) => tool.name === 'find_importers');
          if (find) {
            for (const input of [{ path: 'src/auth.ts' }, { path: 'README.md' }]) {
              searched.push(yield* Effect.promise(() => find.run(input)));
            }
          }
          const search = request.tools?.find((tool) => tool.name === 'search_code');
          if (search) {
            for (const input of [{ text: 'user ===' }, { text: 'nowhere to be found' }, { text: 'x' }]) {
              searched.push(yield* Effect.promise(() => search.run(input)));
            }
          }
          const read = request.tools?.find((tool) => tool.name === 'read_file');
          if (read && (request.tier === 'notes' ? request.prompt.includes('src/auth.ts') : true)) {
            const answers: string[] = [];
            outputs.push(answers);
            for (const path of ['src/auth.ts', '.gitattributes', '../outside.txt']) {
              answers.push(yield* Effect.promise(() => read.run({ path })));
            }
          }
          return yield* base.prompt(request);
        }),
    };
    const { trace } = await tour({ model });
    // A changed file reads from the working tree, any other file from HEAD; nothing outside the repository.
    expect(outputs).toHaveLength(5);
    expect(new Set(outputs.map((answers) => answers.join('\n'))).size).toBe(1);
    expect(outputs[0]).toEqual([
      '1 export function check(user: string) {\n2   return user === "admin";\n3 }',
      '1 api/*.gen.ts linguist-generated',
      '../outside.txt is not a path inside the repository.',
    ]);
    expect(trace.get('walkthrough')?.reads).toEqual(['src/auth.ts lines 1-3', '.gitattributes lines 1-1']);
    expect(trace.get('callpath')?.reads).toEqual(['src/auth.ts lines 1-3', '.gitattributes lines 1-1']);
    expect(trace.get('notes:auth')?.reads).toEqual(['src/auth.ts lines 1-3', '.gitattributes lines 1-1']);
    expect(trace.get('section:auth')?.reads).toEqual(['src/auth.ts lines 1-3', '.gitattributes lines 1-1']);
    // Only the affected map looks up importers and searches, through git grep in a local repository.
    expect(searched).toEqual([
      "src/login.ts:1:import { check } from './auth';",
      'README.md is not imported by its path (only script and Python files are). Call search_code with a type or function name it defines.',
      'src/auth.ts:2:  return user === "admin";',
      'No matches.',
      'Give a string of at least 3 characters to find.',
    ]);
    expect(trace.get('affected')?.prompt).toContain(
      [
        '## Callers found',
        '### Importers of src/auth.ts',
        "src/login.ts:1:import { check } from './auth';",
        "  src/screen.ts:1:import { login } from './login';",
        "    gate src/screen.ts:2: if (useFlag('new-auth')) login();",
      ].join('\n'),
    );
    expect(trace.get('affected')?.reads).toEqual([
      'found 2 importers of src/auth.ts',
      'importers of src/auth.ts',
      'search "user ==="',
      'search "nowhere to be found"',
      'src/auth.ts lines 1-3',
      '.gitattributes lines 1-1',
    ]);
  });

  it('streams what the change affects, changes first, and keeps it in the finished tour', async () => {
    const { events, tour: finished } = await tour({ model: fakeModel() });
    const event = events.find((event) => event.type === 'tour.affected');
    expect(event && 'affected' in event ? event.affected.map((row) => row.surface) : []).toEqual([
      'Admin login',
      'Login page',
    ]);
    expect(finished.affected).toEqual([
      {
        surface: 'Admin login',
        audience: 'admins',
        effect: 'changes',
        what: 'Asks for a code.',
        evidence: 'auth.ts:3',
      },
      { surface: 'Login page', audience: 'everyone', effect: 'unchanged', what: 'Check sign-in still works.' },
    ]);
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
            RepoClones.layer(join(tmpdir(), 'gloss-test-clones')),
          ),
        ),
      ),
    );
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain('Defining groups failed');
    expect(trace.get('define')).toMatchObject({ state: 'failed', warnings: [expect.stringContaining('tier define')] });
  });
});
