import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import {
  DecisionRules,
  DiffSources,
  JudgeClient,
  ModelClient,
  RepoClones,
  RepoConfigs,
  type Services,
  TourCache,
} from '@gloss/core';
import {
  createFlueModelClient,
  createJevClient,
  glossCacheDir,
  glossPath,
  loadConfig,
  loadProviderPackages,
  modelName,
  providerStatus,
  readDecisionRules,
  saveDecisionRules,
  validateModelIds,
} from '@gloss/models';
import type { Health } from '@gloss/protocol';
import { PIPELINE_VERSION } from '@gloss/protocol';
import { Context, Effect, Layer } from 'effect';

export const VERSION = '0.0.0';

/** What the backend reports about itself: models, judge and providers. */
export class BackendInfo extends Context.Service<BackendInfo, { judge?: string; health(): Promise<Health> }>()(
  'gloss/BackendInfo',
) {}

/** `~/.gloss/.env` holds keys (TYPESAFE_API_KEY, ...) for users who do not export them; the shell wins. */
export function loadGlossEnv(): void {
  const path = glossPath('.env');
  if (existsSync(path)) {
    const before = { ...process.env };
    process.loadEnvFile(path);
    Object.assign(process.env, before);
  }
}

/**
 * Config, providers, the Flue model client, Jev and the cache: everything inference needs,
 * local only. Jev is provided only when a TypeSafe (or OpenRouter) key is configured.
 */
export const BackendLayer: Layer.Layer<Services | DecisionRules | RepoConfigs | RepoClones | BackendInfo> =
  Layer.unwrap(
    Effect.promise(async () => {
      // Clones lived in the temp dir before the cache dir; they are not used any more.
      void rm(join(tmpdir(), `gloss-clones-${process.getuid?.() ?? 'user'}`), { recursive: true, force: true }).catch(
        () => {},
      );
      loadGlossEnv();
      const config = loadConfig();
      await loadProviderPackages(config.providerPackages);
      validateModelIds([...Object.values(config.tiers), ...config.ask.models]);
      const judge = await createJevClient(config.judge);
      return Layer.mergeAll(
        TourCache.sqlite(glossPath('cache.sqlite')),
        Layer.succeed(ModelClient, createFlueModelClient({ config })),
        DiffSources.layer,
        RepoConfigs.layer,
        Layer.succeed(DecisionRules, {
          get: Effect.sync(() => readDecisionRules()),
          save: (rules) => Effect.sync(() => saveDecisionRules(rules)),
        }),
        RepoClones.layer(join(glossCacheDir(), 'clones')),
        judge ? Layer.succeed(JudgeClient, judge) : Layer.empty,
        Layer.succeed(BackendInfo, {
          judge: judge?.model,
          health: async () => ({
            version: VERSION,
            pipelineVersion: PIPELINE_VERSION,
            judge: { available: !!judge, model: judge?.model },
            models: config.tiers,
            ask: { models: config.ask.models.map((id) => ({ id, name: modelName(id) })), default: config.ask.default },
            providers: await providerStatus(),
          }),
        }),
      );
    }),
  );
