import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AskEvent, DiffPayload, Tour } from '@gloss/protocol';
import { Effect, Fiber, Layer, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { createFakeModelClient } from '../adapters/fake.ts';
import { ModelClient } from '../adapters/types.ts';
import { RepoClones, type SearchTree } from '../sources/clone.ts';
import { RepoError, Repos } from '../sources/repos.ts';
import { citedRefs, describeContext, runAsk } from './ask.ts';

const meta = { title: 'Keep LFS objects on disk', baseRef: 'main', headRef: 'lfs', commits: [] };
const ref = { kind: 'local' as const, repo: '/r', target: 'HEAD' };
const diff: DiffPayload = {
  id: 'd',
  ref,
  sourceKey: 'k',
  fingerprint: 'x',
  meta,
  files: [
    {
      id: 'f1',
      path: 'src/repos.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      isBinary: false,
      truncated: false,
      // New lines 10-12, old lines 10-11.
      hunks: [
        {
          id: 'h1',
          header: '@@ -10,2 +10,3 @@',
          oldStart: 10,
          oldLines: 2,
          newStart: 10,
          newLines: 3,
          patch: ' a\n-b\n+c\n+d',
        },
      ],
    },
  ],
};
const tour: Tour = {
  diffId: 'd',
  ref,
  meta,
  files: [],
  overallSummary: 'Moves LFS objects to disk.',
  groups: [
    {
      key: 'core',
      label: 'LFS on disk',
      summary: 'Writes objects to a folder.',
      category: 'core',
      critical: false,
      fileIds: ['f1'],
    },
  ],
  placements: {},
  judgments: {},
  notes: {
    core: {
      fileNotes: [],
      lineNotes: [{ fileId: 'f1', hunkId: 'h1', side: 'additions', line: 11, text: 'Renamed into place.' }],
      riskNotes: [],
    },
  },
  models: { define: 'p/define', followup: 'p/followup', notes: 'p/notes' },
};

/** Repos with these contents, and a clone tree (none by default). */
const repos = (contents: Repos['Service']['contents'], tree?: SearchTree) =>
  Layer.merge(
    Layer.succeed(RepoClones, {
      tree: () => Effect.succeed(tree),
      prune: () => Effect.succeed({ heads: 0, clones: 0 }),
    }),
    reposOnly(contents),
  );

const reposOnly = (contents: Repos['Service']['contents']) =>
  Layer.succeed(Repos, {
    pulls: () => Effect.succeed(new Map()),
    viewer: Effect.succeed(undefined),
    inbox: Effect.succeed(undefined),
    asset: () => Effect.succeed(undefined),
    stack: () => Effect.fail(new RepoError({ message: 'no' })),
    review: () => Effect.fail(new RepoError({ message: 'no' })),
    threads: () => Effect.fail(new RepoError({ message: 'no' })),
    replyToThread: () => Effect.fail(new RepoError({ message: 'no' })),
    resolveThread: () => Effect.fail(new RepoError({ message: 'no' })),
    contents,
    lfs: () => Effect.fail(new RepoError({ message: 'no' })),
  });

const collect = (model: ModelClient['Service'], options: Partial<Parameters<typeof runAsk>[0]> = {}) =>
  Effect.runPromise(
    Stream.runCollect(runAsk({ tour, diff, question: 'Is it cleaned up?', ...options })).pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(ModelClient, model),
          repos(() => Effect.succeed(undefined)),
        ),
      ),
    ),
  ) as Promise<AskEvent[]>;

describe('citedRefs', () => {
  it('keeps only links to lines the diff shows, or to files the model read', () => {
    const text = '[a](f1:11) [b](f1:-11) [c](f1:40) [d](f9:11) [e](https://x.dev) [f](f1:0) [a again](f1:11)';
    expect(citedRefs(text, diff)).toEqual([
      { fileId: 'f1', side: 'additions', line: 11 },
      { fileId: 'f1', side: 'deletions', line: 11 },
    ]);
    const read = new Map([['f1:additions', 40]]);
    expect(citedRefs('[c](f1:40) [d](f1:41) [e](f1:-40)', diff, read)).toEqual([
      { fileId: 'f1', side: 'additions', line: 40 },
    ]);
  });
});

describe('describeContext', () => {
  it('names lines, a file or a group', () => {
    expect(describeContext({ fileId: 'f1', side: 'additions', from: 10, to: 12 }, tour, diff)).toBe(
      'f1 src/repos.ts lines 10-12',
    );
    expect(describeContext({ fileId: 'f1', side: 'deletions', from: 11, to: 11 }, tour, diff)).toBe(
      'f1 src/repos.ts line 11 (removed lines)',
    );
    expect(describeContext({ groupKey: 'core' }, tour, diff)).toBe('the group "LFS on disk"');
    expect(describeContext({ fileId: 'nope' }, tour, diff)).toBeUndefined();
  });
});

describe('runAsk', () => {
  it('asks the default model with the tour, the numbered diff and the thread, and streams the answer', async () => {
    const model = createFakeModelClient({ answers: {}, chat: () => 'No: see [repos.ts:12](f1:12) and [x](f1:99).' });
    const events = await collect(model, {
      context: { fileId: 'f1', side: 'additions', from: 11, to: 12 },
      history: [{ question: 'Who reads it?', answer: 'The tour.' }],
    });
    const request = model.chats[0]!;
    expect(request.model).toBe('fake/mid');
    expect(request.tools.map((tool) => tool.name)).toEqual(['read_file', 'search_code']);
    expect(request.prompt).toContain('+ 12 d');
    expect(request.prompt).toContain('- f1:11: Renamed into place.');
    expect(request.prompt).toContain('Reviewer: Who reads it?');
    expect(request.prompt.trimEnd().endsWith('## Question about f1 src/repos.ts lines 11-12\nIs it cleaned up?')).toBe(
      true,
    );
    expect(
      events
        .filter((event) => event.type === 'ask.delta')
        .map((event) => event.text)
        .join(''),
    ).toBe('No: see [repos.ts:12](f1:12) and [x](f1:99).');
    expect(events.at(-1)).toEqual({
      type: 'ask.done',
      model: 'fake/mid',
      refs: [{ fileId: 'f1', side: 'additions', line: 12 }],
    });
  });

  it('ends with ask.failed when the model fails', async () => {
    const events = await collect(createFakeModelClient({ answers: {} }));
    expect(events).toEqual([{ type: 'ask.failed', message: 'No fake chat answer' }]);
  });

  it('reads a whole file, numbered, through Repos', async () => {
    let output = '';
    const base = createFakeModelClient({ answers: {}, chat: () => 'ok' });
    const model: ModelClient['Service'] = {
      ...base,
      chat: (request) =>
        Effect.promise(() => request.tools[0]!.run({ path: 'f1' })).pipe(
          Effect.tap((text) => Effect.sync(() => (output = text))),
          Effect.andThen(base.chat(request)),
        ),
    };
    await Effect.runPromise(
      Stream.runCollect(runAsk({ tour, diff, question: 'q' })).pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(ModelClient, model),
            repos(() => Effect.succeed({ oldContents: 'old', newContents: 'one\ntwo' })),
          ),
        ),
      ),
    );
    expect(output).toBe('1 one\n2 two');
  });
});

describe('read_file', () => {
  const readWith = async (
    contents: Repos['Service']['contents'],
    fileId = 'f1',
    files = diff.files,
    side: 'new' | 'old' = 'new',
  ) => {
    let output = '';
    let refs: unknown;
    const base = createFakeModelClient({ answers: {}, chat: () => '[x](f1:2) [y](f2:2) [z](f2:-2)' });
    const model: ModelClient['Service'] = {
      ...base,
      chat: (request) =>
        Effect.promise(() => request.tools[0]!.run({ path: fileId, side })).pipe(
          Effect.tap((text) => Effect.sync(() => (output = text))),
          Effect.andThen(base.chat(request)),
        ),
    };
    const events = await Effect.runPromise(
      Stream.runCollect(runAsk({ tour, diff: { ...diff, files }, question: 'q' })).pipe(
        Effect.provide(Layer.merge(Layer.succeed(ModelClient, model), repos(contents))),
      ),
    );
    refs = (events.at(-1) as Extract<AskEvent, { type: 'ask.done' }>).refs;
    return { output, refs };
  };

  it('reads an added file from its diff, and its lines become citable', async () => {
    const added = {
      ...diff.files[0]!,
      id: 'f2',
      status: 'added' as const,
      hunks: [{ ...diff.files[0]!.hunks[0]!, oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, patch: '+one\n+two' }],
    };
    const { output, refs } = await readWith(() => Effect.succeed(undefined), 'f2', [diff.files[0]!, added]);
    expect(output).toBe('1 one\n2 two');
    expect(refs).toEqual([{ fileId: 'f2', side: 'additions', line: 2 }]);
  });

  it('reads a removed file from its diff, and its old lines become citable', async () => {
    const removed = {
      ...diff.files[0]!,
      id: 'f2',
      status: 'removed' as const,
      hunks: [{ ...diff.files[0]!.hunks[0]!, oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, patch: '-one\n-two' }],
    };
    const { output, refs } = await readWith(() => Effect.succeed(undefined), 'f2', [diff.files[0]!, removed], 'old');
    expect(output).toBe('1 one\n2 two');
    expect(refs).toEqual([{ fileId: 'f2', side: 'deletions', line: 2 }]);
  });

  it('stops the read when the answer is interrupted', async () => {
    let interrupted = false;
    const model = createFakeModelClient({ answers: {} });
    const hang: ModelClient['Service'] = {
      ...model,
      chat: (request) =>
        Effect.promise(() => request.tools[0]!.run({ path: 'f1' })).pipe(Effect.as({ text: '', model: 'm' })),
    };
    const fiber = Effect.runFork(
      Stream.runCollect(runAsk({ tour, diff, question: 'q' })).pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(ModelClient, hang),
            repos(() => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))))),
          ),
        ),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(interrupted).toBe(true);
  });
});

describe('beyond the diff', () => {
  it('reads and searches files outside the change in the clone, and names them on the page', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gloss-ask-'));
    try {
      execFileSync('git', ['init', '-q', repo]);
      execFileSync('mkdir', ['-p', join(repo, 'src')]);
      writeFileSync(join(repo, 'src', 'session.ts'), 'import { keep } from "./repos";\nkeep();\n');
      execFileSync('git', ['-C', repo, 'add', '.']);
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'c']);
      const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      // The working tree moved on: reads and searches see the commit, not the disk.
      writeFileSync(join(repo, 'src', 'session.ts'), 'edited\n');
      const outputs: string[] = [];
      const base = createFakeModelClient({ answers: {}, chat: () => 'See `src/session.ts:2`.' });
      const calls = [
        { name: 'read_file', input: { path: 'src/session.ts', from: 2 } },
        { name: 'search_code', input: { text: 'keep()' } },
        { name: 'read_file', input: { path: '../etc/passwd' } },
      ];
      const model: ModelClient['Service'] = {
        ...base,
        chat: (request) =>
          Effect.gen(function* () {
            for (const [index, call] of calls.entries()) {
              const tool = request.tools.find((candidate) => candidate.name === call.name)!;
              request.onEvent?.({
                type: 'tool',
                id: `t${index}`,
                name: call.name,
                input: call.input,
                state: 'running',
              });
              outputs.push(yield* Effect.promise(() => tool.run(call.input)));
            }
            return yield* base.chat(request);
          }),
      };
      const events = await Effect.runPromise(
        Stream.runCollect(
          runAsk({ tour, diff: { ...diff, meta: { ...meta, headSha: sha } }, question: 'Who calls it?' }),
        ).pipe(
          Effect.provide(
            Layer.merge(
              Layer.succeed(ModelClient, model),
              repos(() => Effect.succeed(undefined), { cwd: repo, rev: sha }),
            ),
          ),
        ),
      );
      expect(outputs).toEqual([
        '2 keep();',
        'src/session.ts:2:keep();',
        '../etc/passwd is not a path inside the repository.',
      ]);
      expect(events.filter((event) => event.type === 'ask.tool').map((event) => event.target)).toEqual([
        'src/session.ts',
        'keep()',
        '../etc/passwd',
      ]);
      expect(events.at(-1)).toEqual({ type: 'ask.done', model: 'fake/mid', refs: [] });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
