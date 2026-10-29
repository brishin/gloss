#!/usr/bin/env node
// The native messaging host behind the gloss extension (`gloss extension install`): on
// `{ type: 'start' }` it starts `gloss serve` detached unless it is already up, waits for
// it, and replies `{ url }` or `{ error }`.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { glossHome, glossPath } from '@gloss/models';
import { createHttpGlossClient } from '@gloss/protocol';
import { decodeMessage, encodeMessage } from './extension.ts';
import { DEFAULT_PORT } from './serve.ts';

const BIN = fileURLToPath(new URL('./bin.ts', import.meta.url));

async function readMessage(): Promise<unknown> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, chunk as Buffer]);
    const message = decodeMessage(buffer);
    if (message !== undefined) {
      return message;
    }
  }
  return undefined;
}

async function start(): Promise<{ url: string } | { error: string }> {
  const url = `http://127.0.0.1:${Number(process.env.GLOSS_PORT ?? DEFAULT_PORT)}`;
  // A stalled port must not hold the extension's click: each probe gives up after a second.
  const client = createHttpGlossClient({
    baseUrl: url,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(1000) }),
  });
  const up = () =>
    client.health().then(
      () => true,
      () => false,
    );
  if (await up()) {
    return { url };
  }
  mkdirSync(glossHome(), { recursive: true });
  const log = openSync(glossPath('serve.log'), 'a');
  // Detached into its own session so it outlives this host when Chrome closes the port.
  spawn(process.execPath, [BIN, 'serve'], { detached: true, stdio: ['ignore', log, log] }).unref();
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await up()) {
      return { url };
    }
  }
  return { error: `gloss did not start; see ${glossPath('serve.log')}` };
}

const message = (await readMessage()) as { type?: string } | undefined;
const reply = message?.type === 'start' ? await start() : { error: 'Unknown message' };
process.stdout.write(encodeMessage(reply));
process.exit(0);
