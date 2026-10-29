import { existsSync } from 'node:fs';
import process from 'node:process';
import { DiffSources, JudgeClient, ModelClient, type Services, TourCache } from '@gloss/core';
import {
  createFlueModelClient,
  createJevClient,
  glossPath,
  loadConfig,
  loadProviderPackages,
  providerStatus,
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
export const BackendLayer: Layer.Layer<Services | BackendInfo> = Layer.unwrap(
  Effect.promise(async () => {
    loadGlossEnv();
    const config = loadConfig();
    await loadProviderPackages(config.providerPackages);
    validateModelIds(Object.values(config.tiers));
    const judge = await createJevClient(config.judge);
    return Layer.mergeAll(
      TourCache.sqlite(glossPath('cache.sqlite')),
      Layer.succeed(ModelClient, createFlueModelClient({ config })),
      DiffSources.layer,
      judge ? Layer.succeed(JudgeClient, judge) : Layer.empty,
      Layer.succeed(BackendInfo, {
        judge: judge?.model,
        health: async () => ({
          version: VERSION,
          pipelineVersion: PIPELINE_VERSION,
          judge: { available: !!judge, model: judge?.model },
          models: config.tiers,
          providers: await providerStatus(),
        }),
      }),
    );
  }),
);
