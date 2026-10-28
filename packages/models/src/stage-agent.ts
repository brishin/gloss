'use agent';
import { defineTool, useAgentFinish, useDataWriter, useInitialData, useModel, useTool } from '@flue/runtime';
import type * as v from 'valibot';
import type { ThinkingLevel } from './config.ts';

/** Creation data for one stage conversation. JSON only: the result schema is looked up by id. */
export interface StageInit {
  model: string;
  thinkingLevel: ThinkingLevel;
  system: string;
  schemaId: string;
  resultName: string;
}

/** Result schemas by id, registered in-process by `FlueModelClient` before each dispatch. */
export const stageSchemas = new Map<string, v.GenericSchema>();

const MAX_SUBMIT_REMINDERS = 2;

/**
 * One pipeline stage as a Flue agent: the delivered message is the prompt, and the
 * model answers by calling `submit` once with input validated against the stage's
 * schema. The validated input is written as the `result` data part, and `submit`
 * terminates the turn, so a stage costs one model turn when the model behaves.
 */
export function GlossStage() {
  // Undefined only on bare tooling renders, which never call a model.
  const init = useInitialData<StageInit | undefined>();
  useModel(init?.model ?? 'anthropic/claude-haiku-5-5', {
    thinkingLevel: init?.thinkingLevel ?? 'low',
    compaction: false,
  });
  const writeResult = useDataWriter('result');
  if (!init) {
    return '';
  }
  const schema = stageSchemas.get(init.schemaId);
  if (!schema) {
    throw new Error(`Unknown stage schema ${init.schemaId}`);
  }
  useTool(
    defineTool({
      name: 'submit',
      description: `Submit the complete ${init.resultName}. Call exactly once.`,
      input: schema as v.ObjectSchema<v.ObjectEntries, undefined>,
      run: ({ data }) => {
        writeResult(data);
        return { output: 'Submitted.', terminate: true };
      },
    }),
  );
  useAgentFinish(({ response, append }) => {
    const calls = response.toolCalls.filter((call) => call.tool === 'submit');
    if (calls.some((call) => !call.isError) || calls.length > MAX_SUBMIT_REMINDERS) {
      return;
    }
    append({
      kind: 'signal',
      type: 'gloss.submit-required',
      body: 'Call the submit tool now with the complete result. Do not reply in prose.',
    });
  });
  return init.system;
}

GlossStage.agentName = 'gloss-stage';
