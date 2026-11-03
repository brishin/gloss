'use agent';
import { defineTool, useModel, useInitialData, useTool } from '@flue/runtime';
import type * as v from 'valibot';
import type { ThinkingLevel } from './config.ts';

/** Creation data for one ask conversation. JSON only: the tools are looked up by id. */
export interface AskInit {
  model: string;
  thinkingLevel: ThinkingLevel;
  system: string;
  toolsId: string;
}

export interface AskToolSpec {
  name: string;
  description: string;
  input: v.GenericSchema;
  run(input: unknown): Promise<string>;
}

/** Tools by id, registered in-process by `FlueModelClient.chat` before each dispatch. */
export const askTools = new Map<string, readonly AskToolSpec[]>();

/**
 * A reviewer's question about a tour, as a Flue agent: the delivered message is the tour, the
 * diff and the question, and the model answers in prose. Its tools only read.
 */
export function GlossAsk() {
  // Undefined only on bare tooling renders, which never call a model.
  const init = useInitialData<AskInit | undefined>();
  useModel(init?.model ?? 'anthropic/claude-haiku-5-5', {
    thinkingLevel: init?.thinkingLevel ?? 'low',
    compaction: false,
  });
  if (!init) {
    return '';
  }
  for (const tool of askTools.get(init.toolsId) ?? []) {
    useTool(
      defineTool({
        name: tool.name,
        description: tool.description,
        input: tool.input as v.ObjectSchema<v.ObjectEntries, undefined>,
        run: async ({ data }) => ({ output: await tool.run(data) }),
      }),
    );
  }
  return init.system;
}

GlossAsk.agentName = 'gloss-ask';
