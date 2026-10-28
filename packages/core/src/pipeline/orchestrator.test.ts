import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TourEventBody } from '@gloss/protocol';
import { initialTourState, reduceTourEvent, tourFromState } from '@gloss/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeJudgeClient, createFakeModelClient } from '../adapters/fake.ts';
import { createMemoryCacheStore } from '../cache/store.ts';
import { createLocalSource } from '../sources/local.ts';
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

function collect() {
  const events: TourEventBody[] = [];
  return { events, emit: (event: TourEventBody) => events.push(event) };
}

const groupsAnswer = {
  overallSummary: 'Tightens the auth check.',
  groups: [
    { key: 'auth', label: 'Auth check', summary: 'Only admins pass.', category: 'security' },
    { key: 'docs', label: 'Docs', summary: 'Readme.', category: 'docs' },
  ],
};

function fakeModel() {
  return createFakeModelClient({
    answers: {
      define: groupsAnswer,
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
        };
      },
    },
  });
}

const fakeJudge = () =>
  createFakeJudgeClient((state, id) => {
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
    const ref = { kind: 'local' as const, repo, target: '' };
    const { events, emit } = collect();
    const model = fakeModel();
    const tour = await runTour({
      ref,
      source: createLocalSource(ref),
      cache,
      model,
      judge: fakeJudge(),
      emit,
      signal: new AbortController().signal,
    });

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
    const placed = tour.groups.flatMap((group) => group.fileIds);
    expect(placed.toSorted()).toEqual(tour.files.map((file) => file.id).toSorted());

    const byPath = Object.fromEntries(tour.files.map((file) => [file.path, tour.placements[file.id]?.groupKey]));
    expect(byPath).toEqual({
      'README.md': 'docs',
      'api/client.gen.ts': 'generated',
      'src/auth.test.ts': 'tests',
      'src/auth.ts': 'auth',
    });
    expect(tour.placements[tour.files.find((file) => file.path === 'src/auth.ts')!.id]?.reason).toBe('llm-followup');
    expect(tour.groups.find((group) => group.key === 'auth')?.critical).toBe(true);
    expect(tour.groups.map((group) => group.key)).toEqual(['docs', 'auth', 'tests', 'generated']);
    expect(tour.notes.auth?.lineNotes).toHaveLength(1);

    // Second run: a finished tour for the same head replays as two events, with no model calls.
    const calls = model.calls.length;
    const second = collect();
    await runTour({
      ref,
      source: createLocalSource(ref),
      cache,
      model,
      judge: fakeJudge(),
      emit: second.emit,
      signal: new AbortController().signal,
    });
    expect(second.events.map((event) => event.type)).toEqual(['job.started', 'tour.complete']);
    expect(model.calls.length).toBe(calls);
  });

  it('without a judge, the LLM lists files and nothing is dropped', async () => {
    const ref = { kind: 'local' as const, repo, target: '' };
    const { events, emit } = collect();
    const model = createFakeModelClient({
      answers: {
        define: (request) => {
          const ids = [...request.prompt.matchAll(/^(f[0-9a-f]+) /gm)].map((match) => match[1]!);
          return { ...groupsAnswer, groups: [{ ...groupsAnswer.groups[0], fileIds: [ids[0], 'f-hallucinated'] }] };
        },
        followup: { placements: [] },
        notes: { fileNotes: [], lineNotes: [], riskNotes: [] },
      },
    });
    const tour = await runTour({
      ref,
      source: createLocalSource(ref),
      cache: createMemoryCacheStore(),
      model,
      emit,
      signal: new AbortController().signal,
    });
    expect(
      events.some((event) => event.type === 'stage.status' && event.stage === 'judge' && event.state === 'skipped'),
    ).toBe(true);
    expect(events.some((event) => event.type === 'job.warning' && event.message.includes('f-hallucinated'))).toBe(true);
    expect(tour.groups.flatMap((group) => group.fileIds)).toHaveLength(tour.files.length);
  });
});
