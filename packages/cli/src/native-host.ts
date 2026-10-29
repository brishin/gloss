#!/usr/bin/env node
// The native messaging host behind the gloss extension (`gloss extension install`): on
// `{ type: 'start' }` it starts `gloss serve` detached unless it is already up, waits for
// it, and replies `{ url }` or `{ error }`.
import process from 'node:process';
import { isUp, serverUrl, startDetached } from './daemon.ts';
import { decodeMessage, encodeMessage } from './extension.ts';
import { DEFAULT_PORT } from './serve.ts';

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
  const port = Number(process.env.GLOSS_PORT ?? DEFAULT_PORT);
  return (await isUp(port)) ? { url: serverUrl(port) } : startDetached(port);
}

const message = (await readMessage()) as { type?: string } | undefined;
const reply = message?.type === 'start' ? await start() : { error: 'Unknown message' };
process.stdout.write(encodeMessage(reply));
process.exit(0);
