import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Effect } from 'effect';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { createFlueModelClient } from './flue-runtime.ts';

const faux = fauxProvider({ provider: 'faux', models: [{ id: 'model' }] });
const client = createFlueModelClient({
  config: {
    tiers: { define: 'faux/model', followup: 'faux/model', notes: 'faux/model' },
    thinking: { define: 'low', followup: 'low', notes: 'low' },
  },
  providers: [faux.provider],
});
const Schema = v.object({ answer: v.string() });
const run = (request: Parameters<typeof client.prompt<typeof Schema>>[0]) => Effect.runPromise(client.prompt(request));

describe('FlueModelClient', () => {
  it('returns the validated input of the submit tool call', async () => {
    faux.setResponses([fauxAssistantMessage([fauxToolCall('submit', { answer: 'yes' })], { stopReason: 'toolUse' })]);
    const result = await run({
      tier: 'define',
      system: 'sys',
      prompt: 'q',
      result: Schema,
      resultName: 'answer',
    });
    expect(result.data).toEqual({ answer: 'yes' });
  });

  it('reminds a model that replied in prose, then accepts its submit', async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxText('Here is my answer in prose.')),
      fauxAssistantMessage([fauxToolCall('submit', { answer: 'late' })], { stopReason: 'toolUse' }),
    ]);
    const result = await run({
      tier: 'notes',
      system: 'sys',
      prompt: 'q',
      result: Schema,
      resultName: 'answer',
    });
    expect(result.data).toEqual({ answer: 'late' });
  });

  it('lets the model retry after its submit fails validation', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('submit', { wrong: true })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('submit', { answer: 'fixed' })], { stopReason: 'toolUse' }),
    ]);
    const result = await run({
      tier: 'notes',
      system: 'sys',
      prompt: 'q',
      result: Schema,
      resultName: 'answer',
    });
    expect(result.data).toEqual({ answer: 'fixed' });
  });
});
