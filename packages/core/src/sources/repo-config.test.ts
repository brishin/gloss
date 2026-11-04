import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import type { SourceRef } from '@gloss/protocol';
import { Effect } from 'effect';
import { TestClock } from 'effect/testing';
import {
  type ConfigResponse,
  makeRepoConfigs,
  parseRepoConfig,
  REPO_CONFIG_TTL,
  responseStatus,
  splitResponse,
} from './repo-config.ts';

const pr = (number: number, owner = 'acme', repo = 'api'): SourceRef => ({ kind: 'github-pr', owner, repo, number });
const config = (rule: string) => JSON.stringify({ decisionRules: [rule] });

/** A fake GitHub that records each request's ETag and answers from `answers` in order. */
function fakeGithub(answers: (ConfigResponse | Error)[]) {
  const requests: { repo: string; etag?: string }[] = [];
  const fetch = async (owner: string, repo: string, etag: string | undefined) => {
    requests.push({ repo: `${owner}/${repo}`, ...(etag ? { etag } : {}) });
    const answer = answers.shift() ?? { kind: 'missing' };
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };
  return { requests, fetch };
}

describe('parseRepoConfig', () => {
  it.each([
    ['not JSON', '{', []],
    ['not an object', '["Flag A"]', []],
    ['no rules', '{"other": 1}', []],
    ['a plain list', config(' Flag A '), [{ rules: ['Flag A'] }]],
    [
      'a rule past the length limit left out',
      JSON.stringify({ decisionRules: ['Flag A', 'x'.repeat(401)] }),
      [{ rules: ['Flag A'] }],
    ],
    [
      'sets that do not parse left out',
      JSON.stringify({
        decisionRules: [
          { files: '(', rules: ['Bad'] },
          { files: '\\.py$', rules: ['Good'] },
        ],
      }),
      [{ files: '\\.py$', rules: ['Good'] }],
    ],
  ])('%s', (_, text, rules) => {
    expect(parseRepoConfig(text).decisionRules).toEqual(rules);
  });

  it('keeps only the sets that fit the rule limit', () => {
    const sets = Array.from({ length: 3 }, (_, set) => ({
      rules: Array.from({ length: 8 }, (_, i) => `R${set}.${i}`),
    }));
    expect(parseRepoConfig(JSON.stringify({ decisionRules: sets })).decisionRules).toHaveLength(2);
  });
});

describe('gh api -i output', () => {
  it('reads the status, headers and body', () => {
    const output = 'HTTP/2.0 200 OK\r\nEtag: W/"abc"\r\nContent-Type: text/plain\r\n\r\n{"a": 1}\n';
    expect(responseStatus(output)).toBe(200);
    const { headers, body } = splitResponse(output);
    expect(headers.get('etag')).toBe('W/"abc"');
    expect(body).toBe('{"a": 1}\n');
  });

  it('reads the status from a failure', () => {
    expect(responseStatus('HTTP/2.0 304 Not Modified\nEtag: "abc"\n\n\ngh: HTTP 304')).toBe(304);
    expect(responseStatus('\ngh: Not Found (HTTP 404)')).toBe(404);
    expect(responseStatus('\nerror connecting to api.github.com')).toBeUndefined();
  });
});

describe('RepoConfigs', () => {
  it.effect('asks GitHub once per TTL, then with the last ETag', () =>
    Effect.gen(function* () {
      const github = fakeGithub([{ kind: 'found', text: config('Flag A'), etag: '"v1"' }, { kind: 'unchanged' }]);
      const configs = yield* makeRepoConfigs({ fetch: github.fetch });
      // A stack opening at once, and another PR of the same repo: one request.
      const [first] = yield* Effect.all([configs.get(pr(1)), configs.get(pr(2)), configs.get(pr(3, 'ACME', 'Api'))], {
        concurrency: 'unbounded',
      });
      expect(first.decisionRules).toEqual([{ rules: ['Flag A'] }]);
      yield* configs.get(pr(4));
      expect(github.requests).toEqual([{ repo: 'acme/api' }]);

      yield* TestClock.adjust(REPO_CONFIG_TTL);
      // Unchanged: the 304 keeps the rules it had.
      expect((yield* configs.get(pr(1))).decisionRules).toEqual([{ rules: ['Flag A'] }]);
      expect(github.requests).toEqual([{ repo: 'acme/api' }, { repo: 'acme/api', etag: '"v1"' }]);
    }),
  );

  it.effect('asks again at once when the tour is re-run', () =>
    Effect.gen(function* () {
      const github = fakeGithub([
        { kind: 'found', text: config('Flag A'), etag: '"v1"' },
        { kind: 'found', text: config('Flag B'), etag: '"v2"' },
      ]);
      const configs = yield* makeRepoConfigs({ fetch: github.fetch });
      yield* configs.get(pr(1));
      expect((yield* configs.get(pr(1), { revalidate: true })).decisionRules).toEqual([{ rules: ['Flag B'] }]);
      expect(github.requests.at(-1)).toEqual({ repo: 'acme/api', etag: '"v1"' });
    }),
  );

  it.effect('keeps no failure: the last answer stands in, and the next tour asks again', () =>
    Effect.gen(function* () {
      const github = fakeGithub([
        { kind: 'found', text: config('Flag A'), etag: '"v1"' },
        new Error('offline'),
        { kind: 'missing' },
      ]);
      const configs = yield* makeRepoConfigs({ fetch: github.fetch });
      yield* configs.get(pr(1));
      yield* TestClock.adjust(REPO_CONFIG_TTL);
      expect((yield* configs.get(pr(1))).decisionRules).toEqual([{ rules: ['Flag A'] }]);
      // Removed from the default branch: no rules, and no ETag sent after.
      expect((yield* configs.get(pr(1))).decisionRules).toEqual([]);
      expect(github.requests).toHaveLength(3);
      yield* TestClock.adjust(REPO_CONFIG_TTL);
      yield* configs.get(pr(1));
      expect(github.requests.at(-1)).toEqual({ repo: 'acme/api' });
    }),
  );

  it.effect('reads a local repository with git, and never asks GitHub', () =>
    Effect.gen(function* () {
      const github = fakeGithub([]);
      const configs = yield* makeRepoConfigs({
        fetch: github.fetch,
        readLocal: async (repo) => (repo === '/work/api' ? config('Flag L') : undefined),
      });
      expect((yield* configs.get({ kind: 'local', repo: '/work/api', target: '' })).decisionRules).toEqual([
        { rules: ['Flag L'] },
      ]);
      expect((yield* configs.get({ kind: 'local', repo: '/work/other', target: '' })).decisionRules).toEqual([]);
      expect(github.requests).toEqual([]);
    }),
  );

  it.effect('reads the config committed at HEAD of a local repository', () =>
    Effect.gen(function* () {
      const repo = mkdtempSync(join(tmpdir(), 'gloss-repo-config-'));
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo });
      git('init', '-q');
      mkdirSync(join(repo, '.gloss'));
      writeFileSync(join(repo, '.gloss/config.json'), config('Flag committed'));
      git('add', '.');
      git('commit', '-qm', 'init');
      writeFileSync(join(repo, '.gloss/config.json'), config('Flag uncommitted'));
      const configs = yield* makeRepoConfigs();
      const read = yield* configs.get({ kind: 'local', repo, target: '' });
      rmSync(repo, { recursive: true, force: true });
      expect(read.decisionRules).toEqual([{ rules: ['Flag committed'] }]);
    }),
  );
});
