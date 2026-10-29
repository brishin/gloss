import { execFile, spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { glossHome, glossPath } from '@gloss/models';
import { createHttpGlossClient } from '@gloss/protocol';

const BIN = fileURLToPath(new URL('./bin.ts', import.meta.url));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const serverUrl = (port: number) => `http://127.0.0.1:${port}`;

/** Whether a gloss server answers on `port`; a stalled port counts as down after a second. */
export function isUp(port: number): Promise<boolean> {
  const client = createHttpGlossClient({
    baseUrl: serverUrl(port),
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(1000) }),
  });
  return client.health().then(
    () => true,
    () => false,
  );
}

/**
 * Starts `gloss serve` on `port` in its own session (it outlives the caller, logging to
 * ~/.gloss/serve.log) and waits up to 30s for it to answer.
 */
export async function startDetached(port: number): Promise<{ url: string } | { error: string }> {
  mkdirSync(glossHome(), { recursive: true });
  const log = openSync(glossPath('serve.log'), 'a');
  spawn(process.execPath, [BIN, 'serve', '--port', String(port)], {
    detached: true,
    stdio: ['ignore', log, log],
  }).unref();
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(500);
    if (await isUp(port)) {
      return { url: serverUrl(port) };
    }
  }
  return { error: `gloss did not start; see ${glossPath('serve.log')}` };
}

/** Stops whatever listens on `port` (SIGTERM, then SIGKILL after 10s). Needs `lsof` (macOS, Linux). */
export async function stopServer(port: number): Promise<number[]> {
  const { stdout } = await promisify(execFile)('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).catch(() => ({
    stdout: '',
  }));
  const pids = stdout.split('\n').filter(Boolean).map(Number);
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
    for (let attempt = 0; attempt < 20 && (await isUp(port)); attempt++) {
      await sleep(500);
    }
    if (!(await isUp(port))) {
      break;
    }
  }
  return pids;
}
