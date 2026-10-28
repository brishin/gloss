import { existsSync } from 'node:fs';
import process from 'node:process';
import { createSqliteCacheStore, type CacheStore, type JudgeClient, type ModelClient } from '@gloss/core';
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

export const VERSION = '0.0.0';

export interface Backend {
  cache: CacheStore;
  model: ModelClient;
  judge?: JudgeClient;
  health: () => Promise<Health>;
}

/** `~/.gloss/.env` holds keys (TYPESAFE_API_KEY, ...) for users who do not export them; the shell wins. */
export function loadGlossEnv(): void {
  const path = glossPath('.env');
  if (existsSync(path)) {
    const before = { ...process.env };
    process.loadEnvFile(path);
    Object.assign(process.env, before);
  }
}

/** Wires config, providers, the Flue model client, Jev and the cache: everything inference needs, local only. */
export async function createBackend(): Promise<Backend> {
  loadGlossEnv();
  const config = loadConfig();
  await loadProviderPackages(config.providerPackages);
  validateModelIds(Object.values(config.tiers));
  const cache = createSqliteCacheStore(glossPath('cache.sqlite'));
  const model = createFlueModelClient({ config });
  const judge = await createJevClient(config.judge);
  return {
    cache,
    model,
    judge,
    health: async () => ({
      version: VERSION,
      pipelineVersion: PIPELINE_VERSION,
      judge: { available: !!judge, model: judge?.model },
      models: config.tiers,
      providers: await providerStatus(),
    }),
  };
}
