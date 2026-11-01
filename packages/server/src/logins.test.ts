import type { LoginSession } from '@gloss/protocol';
import { createHttpGlossClient } from '@gloss/protocol';
import { ManagedRuntime } from 'effect';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { type LoginInteraction, Logins, type RunLogin } from './logins.ts';

/** A login flow the test steps through: it reports a URL, asks a question, then ends as told. */
function scripted() {
  const calls: { method: string; io: LoginInteraction; signal: AbortSignal }[] = [];
  let finish!: (error?: Error) => void;
  const run: RunLogin = async (_subscription, method, io, signal) => {
    calls.push({ method, io, signal });
    io.notify({ type: 'auth_url', url: 'https://example.test/authorize', instructions: 'Sign in' });
    const choice = await io.prompt({
      type: 'select',
      message: 'How?',
      options: [
        { id: 'browser', label: 'Browser' },
        { id: 'code', label: 'Code' },
      ],
    });
    io.notify({ type: 'progress', message: `chose ${choice}` });
    await new Promise<void>((resolve, reject) => {
      finish = (error) => (error ? reject(error) : resolve());
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  };
  return { run, calls, finish: (error?: Error) => finish(error) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(run: RunLogin) {
  const runtime = ManagedRuntime.make(Logins.layer(run));
  // Only the login routes run here, so the runtime needs only `Logins`.
  const app = createApp({ runtime: runtime as never, health: async () => ({}) as never });
  const client = createHttpGlossClient({
    baseUrl: 'http://gloss.test',
    fetch: async (input, init) =>
      app.request(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init),
  });
  return { client, app, runtime };
}

describe('login API', () => {
  it('relays the flow’s page and questions, and reports success', async () => {
    const flow = scripted();
    const { client } = setup(flow.run);
    const started = await client.startLogin('claude', 'oauth');
    expect(started.state).toBe('running');
    const asked = await client.login(started.id);
    expect(asked.authUrl).toEqual({ url: 'https://example.test/authorize', instructions: 'Sign in' });
    expect(asked.prompt).toMatchObject({ type: 'select', options: [{ id: 'browser' }, { id: 'code' }] });

    const answered = await client.answerLogin(started.id, asked.prompt!.id, 'code');
    expect(answered.prompt).toBeUndefined();
    await tick();
    expect((await client.login(started.id)).messages).toEqual(['chose code']);

    flow.finish();
    await tick();
    expect((await client.login(started.id)).state).toBe('succeeded');
  });

  it('refuses an answer to a question that is no longer open', async () => {
    const { client } = setup(scripted().run);
    const { id } = await client.startLogin('chatgpt', 'oauth');
    const { prompt } = await client.login(id);
    await client.answerLogin(id, prompt!.id, 'browser');
    await expect(client.answerLogin(id, prompt!.id, 'browser')).rejects.toMatchObject({ status: 409 });
  });

  it('reports a failed flow’s error', async () => {
    const flow = scripted();
    const { client } = setup(flow.run);
    const { id } = await client.startLogin('claude', 'api_key');
    await client.answerLogin(id, (await client.login(id)).prompt!.id, 'browser');
    flow.finish(new Error('Invalid code'));
    await tick();
    expect(await client.login(id)).toMatchObject<Partial<LoginSession>>({ state: 'failed', error: 'Invalid code' });
    expect(flow.calls[0]?.method).toBe('api_key');
  });

  it('cancels by aborting the flow, and a new login replaces a running one', async () => {
    const flow = scripted();
    const { client } = setup(flow.run);
    const first = await client.startLogin('claude', 'oauth');
    const second = await client.startLogin('claude', 'oauth');
    expect(flow.calls[0]?.signal.aborted).toBe(true);
    expect((await client.login(first.id)).state).toBe('cancelled');

    await client.cancelLogin(second.id);
    expect(flow.calls[1]?.signal.aborted).toBe(true);
    expect((await client.login(second.id)).state).toBe('cancelled');
  });

  it('withdraws a question the flow answered another way', async () => {
    const withdraw = new AbortController();
    const { client } = setup(async (_s, _m, io) => {
      await io.prompt({ type: 'manual_code', message: 'Paste the code', signal: withdraw.signal }).catch(() => {});
    });
    const { id } = await client.startLogin('chatgpt', 'oauth');
    expect((await client.login(id)).prompt?.type).toBe('manual_code');
    withdraw.abort();
    await tick();
    const after = await client.login(id);
    expect(after.prompt).toBeUndefined();
    expect(after.state).toBe('succeeded');
  });

  it('aborts running logins when the backend closes', async () => {
    const flow = scripted();
    const { client, runtime } = setup(flow.run);
    await client.startLogin('claude', 'oauth');
    await runtime.dispose();
    expect(flow.calls[0]?.signal.aborted).toBe(true);
  });

  it('accepts logins only as JSON from the app', async () => {
    const { app } = setup(scripted().run);
    const body = JSON.stringify({ subscription: 'claude', method: 'oauth' });
    const form = await app.request('http://gloss.test/api/logins', { method: 'POST', body });
    expect(form.status).toBe(403);
    const elsewhere = await app.request('http://gloss.test/api/logins', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' },
    });
    expect(elsewhere.status).toBe(403);
  });
});
