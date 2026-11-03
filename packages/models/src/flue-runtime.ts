import { randomUUID } from 'node:crypto';
import type { Provider } from '@earendil-works/pi-ai';
import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { type ChatRequest, ModelClient, ModelError, type ModelRequest, type ModelTier } from '@gloss/core';
import { Effect } from 'effect';
import * as v from 'valibot';
import { type AskInit, askTools, GlossAsk } from './ask-agent.ts';
import type { GlossConfig } from './config.ts';
import { getModels } from './registry.ts';
import { GlossStage, stageSchemas, type StageInit, stageTools } from './stage-agent.ts';

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

/** Boots Flue once per process with gloss's two agents and its bridged providers. */
export function ensureFlueRuntime(providers: readonly Provider[] = bridgedProviders()): Promise<unknown> {
  runtime ??= start({ agents: [GlossStage, GlossAsk], providers });
  return runtime;
}

export interface FlueModelClientOptions {
  config: Pick<GlossConfig, 'tiers' | 'thinking' | 'ask'>;
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
    config: () => ({ ...config.tiers, ask: config.ask }),
    prompt: <S extends v.GenericSchema>(request: ModelRequest<S>) =>
      Effect.tryPromise({
        try: (signal) => promptStage(config, providers, request, signal),
        catch: (cause) => new ModelError({ message: cause instanceof Error ? cause.message : String(cause), cause }),
      }),
    chat: (request) =>
      Effect.tryPromise({
        try: (signal) => chat(config, providers, request, signal),
        catch: (cause) => new ModelError({ message: cause instanceof Error ? cause.message : String(cause), cause }),
      }),
  };
}

/** One ask: a fresh `GlossAsk` conversation; text and tool calls stream to `onEvent`. */
async function chat(
  config: FlueModelClientOptions['config'],
  providers: FlueModelClientOptions['providers'],
  request: ChatRequest,
  signal: AbortSignal,
) {
  await ensureFlueRuntime(providers);
  const toolsId = randomUUID();
  askTools.set(toolsId, request.tools);
  const handle = init(GlossAsk);
  const onAbort = () => void handle.abort().catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  const inputs = new Map<string, { name: string; input: unknown }>();
  try {
    const initialData: AskInit = {
      model: request.model,
      thinkingLevel: config.thinking.define,
      system: request.system,
      toolsId,
    };
    const receipt = await handle.dispatch({ message: { kind: 'user', body: request.prompt }, initialData });
    const reply = await handle.read(receipt, {
      signal,
      onEvent: (chunk) => {
        if (chunk.type === 'message-delta' && chunk.kind === 'text') {
          request.onEvent?.({ type: 'text', text: chunk.delta });
        } else if (chunk.type === 'tool-input') {
          inputs.set(chunk.toolCallId, { name: chunk.toolName, input: chunk.input });
          request.onEvent?.({
            type: 'tool',
            id: chunk.toolCallId,
            name: chunk.toolName,
            input: chunk.input,
            state: 'running',
          });
        } else if (chunk.type === 'tool-output' || chunk.type === 'tool-output-error') {
          const call = inputs.get(chunk.toolCallId);
          request.onEvent?.({
            type: 'tool',
            id: chunk.toolCallId,
            name: call?.name ?? 'tool',
            input: call?.input,
            state: chunk.type === 'tool-output' ? 'done' : 'failed',
          });
        }
      },
    });
    if (!reply.text.trim()) {
      throw new Error(`${request.model} returned an empty answer`);
    }
    return { text: reply.text, model: request.model };
  } finally {
    signal.removeEventListener('abort', onAbort);
    askTools.delete(toolsId);
  }
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
  const toolsId = request.tools?.length ? schemaId : undefined;
  if (toolsId) {
    stageTools.set(toolsId, request.tools!);
  }
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
      ...(toolsId ? { toolsId } : {}),
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
    stageTools.delete(schemaId);
  }
}
