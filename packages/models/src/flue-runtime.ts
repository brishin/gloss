import { randomUUID } from 'node:crypto';
import type { Provider } from '@earendil-works/pi-ai';
import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { ModelClient, ModelError, type ModelRequest, type ModelTier } from '@gloss/core';
import { Effect } from 'effect';
import * as v from 'valibot';
import type { GlossConfig } from './config.ts';
import { getModels } from './registry.ts';
import { GlossStage, stageSchemas, type StageInit } from './stage-agent.ts';

/**
 * Re-registers each of gloss's providers for Flue with auth delegated to gloss's own
 * registry, so OAuth tokens from `gloss login` (refreshed under the credential store's
 * lock) reach Flue. pi-ai recognizes subscription tokens by shape when they arrive as
 * `apiKey`, so the bridged provider behaves exactly like the OAuth-configured one.
 */
export function bridgedProviders(): Provider[] {
  const models = getModels();
  return models.getProviders().map(
    (provider) =>
      Object.create(provider, {
        auth: {
          value: {
            apiKey: {
              name: `${provider.name} (via gloss)`,
              resolve: () => models.getAuth(provider.id),
            },
          },
        },
      }) as Provider,
  );
}

let runtime: Promise<unknown> | undefined;

/** Boots Flue once per process with only the stage agent and gloss's bridged providers. */
export function ensureFlueRuntime(providers: readonly Provider[] = bridgedProviders()): Promise<unknown> {
  runtime ??= start({ agents: [GlossStage], providers });
  return runtime;
}

export interface FlueModelClientOptions {
  config: Pick<GlossConfig, 'tiers' | 'thinking'>;
  providers?: readonly Provider[];
}

export class StageResultError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StageResultError';
  }
}

/**
 * `ModelClient` over Flue: each request is a fresh `GlossStage` conversation whose
 * model answers through the `submit` tool. Streams text/reasoning deltas to `onDelta`.
 * Interrupting the effect aborts the conversation.
 */
export function createFlueModelClient({ config, providers }: FlueModelClientOptions): ModelClient['Service'] {
  return {
    config: () => ({ ...config.tiers }),
    prompt: <S extends v.GenericSchema>(request: ModelRequest<S>) =>
      Effect.tryPromise({
        try: (signal) => promptStage(config, providers, request, signal),
        catch: (cause) => new ModelError({ message: cause instanceof Error ? cause.message : String(cause), cause }),
      }),
  };
}

async function promptStage<S extends v.GenericSchema>(
  config: FlueModelClientOptions['config'],
  providers: FlueModelClientOptions['providers'],
  request: ModelRequest<S>,
  signal: AbortSignal,
) {
  await ensureFlueRuntime(providers);
  const tier: ModelTier = request.tier;
  const schemaId = randomUUID();
  stageSchemas.set(schemaId, request.result);
  const handle = init(GlossStage);
  const onAbort = () => void handle.abort().catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const initialData: StageInit = {
      model: config.tiers[tier],
      thinkingLevel: config.thinking[tier],
      system: request.system,
      schemaId,
      resultName: request.resultName,
    };
    const receipt = await handle.dispatch({ message: { kind: 'user', body: request.prompt }, initialData });
    const reply = await handle.read(receipt, {
      signal,
      onEvent: (chunk) => {
        if (chunk.type === 'message-delta') {
          request.onDelta?.({ kind: chunk.kind, text: chunk.delta });
        }
      },
    });
    const written = reply.data.result?.at(-1);
    if (written === undefined) {
      throw new StageResultError(
        `${config.tiers[tier]} did not submit a ${request.resultName} result${reply.text ? `: ${reply.text.slice(0, 200)}` : ''}`,
      );
    }
    return { data: v.parse(request.result, written) as v.InferOutput<S>, model: config.tiers[tier] };
  } finally {
    signal.removeEventListener('abort', onAbort);
    stageSchemas.delete(schemaId);
  }
}
