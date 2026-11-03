import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { beforeAll, describe, expect, test } from 'vitest';
import { loadConfig, readDecisionRules, saveDecisionRules } from './config.ts';

// No config file: the gloss home points nowhere.
beforeAll(() => {
  process.env.GLOSS_HOME = '/nonexistent-gloss-home';
});

const load = (env: Record<string, string>) => loadConfig(env).tiers.small;

describe('small tier', () => {
  test.each([
    ['defaults to Haiku', {}, 'anthropic/claude-haiku-5-5'],
    [
      'stays Haiku when define is raised',
      { GLOSS_MODEL_DEFINE: 'anthropic/claude-sonnet-5-5' },
      'anthropic/claude-haiku-5-5',
    ],
    [
      'follows an OpenAI define tier, needing no Anthropic login',
      { GLOSS_MODEL_DEFINE: 'openai/gpt-6-sol' },
      'openai/gpt-6-luna',
    ],
    ['follows the OpenAI profile', { GLOSS_PROFILE: 'openai' }, 'openai/gpt-6-luna'],
    ['uses define itself for another provider', { GLOSS_MODEL_DEFINE: 'other/model' }, 'other/model'],
    ['takes GLOSS_MODEL', { GLOSS_MODEL: 'other/one' }, 'other/one'],
    ['takes GLOSS_MODEL_SMALL', { GLOSS_MODEL_DEFINE: 'openai/gpt-6-sol', GLOSS_MODEL_SMALL: 'x/y' }, 'x/y'],
  ])('%s', (_, env, small) => {
    expect(load(env)).toBe(small);
  });
});

describe('decision rules', () => {
  test('save keeps the rest of the config, and no sets drops the key', () => {
    const home = mkdtempSync(join(tmpdir(), 'gloss-config-'));
    const before = process.env.GLOSS_HOME;
    process.env.GLOSS_HOME = home;
    try {
      writeFileSync(join(home, 'config.json'), JSON.stringify({ profile: 'openai', judge: null }));
      const sets = [
        { rules: ['Flag every new environment variable'] },
        { files: '\\.py$', rules: ['Flag N+1 queries'] },
      ];
      saveDecisionRules(sets);
      expect(readDecisionRules()).toEqual(sets);
      expect(loadConfig({}).decisionRules).toEqual(sets);
      expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toEqual({
        profile: 'openai',
        judge: null,
        decisionRules: sets,
      });
      saveDecisionRules([]);
      expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toEqual({ profile: 'openai', judge: null });
    } finally {
      process.env.GLOSS_HOME = before;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('reads a plain list as one set, and leaves out a set that does not parse', () => {
    expect(readDecisionRules({ decisionRules: [' Flag A ', 'Flag B'] } as never)).toEqual([
      { rules: ['Flag A', 'Flag B'] },
    ]);
    expect(
      readDecisionRules({ decisionRules: [{ files: '(', rules: ['Bad'] }, { rules: ['Good'] }, 'stray'] } as never),
    ).toEqual([{ rules: ['Good'] }]);
  });

  test('save refuses to overwrite a config it cannot parse', () => {
    const home = mkdtempSync(join(tmpdir(), 'gloss-config-'));
    const before = process.env.GLOSS_HOME;
    process.env.GLOSS_HOME = home;
    try {
      writeFileSync(join(home, 'config.json'), '{ "profile": ');
      expect(() => saveDecisionRules([{ rules: ['Flag A'] }])).toThrow(/Could not read/);
      expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe('{ "profile": ');
    } finally {
      process.env.GLOSS_HOME = before;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('ask models', () => {
  test.each([
    ['offers Claude, starting on Sonnet', {}, 'anthropic/claude-sonnet-5-5', 3],
    ['follows the OpenAI profile', { GLOSS_PROFILE: 'openai' }, 'openai/gpt-6-sol', 3],
    ['offers the notes model for another provider', { GLOSS_MODEL: 'other/one' }, 'other/one', 1],
  ])('%s', (_, env, model, count) => {
    const { ask } = loadConfig(env);
    expect(ask.default).toBe(model);
    expect(ask.models).toHaveLength(count);
  });
});
