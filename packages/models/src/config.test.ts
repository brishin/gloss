import process from 'node:process';
import { beforeAll, describe, expect, test } from 'vitest';
import { loadConfig } from './config.ts';

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
