import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, JobManager } from '@gloss/server';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Backend } from './backend.ts';

export const DEFAULT_PORT = 4777;

/** The built web app (`pnpm --filter @gloss/web build`). */
const WEB_ROOT = fileURLToPath(new URL('../../../apps/web/dist/client', import.meta.url));
const SHELLS = ['index.html', '_shell.html'];
/** Sources compiled into the web build; when any is newer, the served app may reject the server's events. */
const WEB_SOURCES = ['../../../apps/web/src', '../../protocol/src'].map((path) =>
  fileURLToPath(new URL(path, import.meta.url)),
);

export interface ServeOptions {
  port: number;
  host: string;
  token?: string;
  corsOrigins: string[];
}

function newestSourceMtime(): number {
  let newest = 0;
  for (const root of WEB_SOURCES) {
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) {
        newest = Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs);
      }
    }
  }
  return newest;
}

function shellHtml(): string | undefined {
  for (const name of SHELLS) {
    const path = `${WEB_ROOT}/${name}`;
    if (existsSync(path)) {
      if (statSync(path).mtimeMs < newestSourceMtime()) {
        console.error(
          'gloss: the web app build is older than its sources (apps/web, packages/protocol). Run `pnpm --filter @gloss/web build`, or the page may reject events.',
        );
      }
      // Same-origin backend: the web app calls `/api` relative to the page.
      return readFileSync(path, 'utf8').replace(
        '<head>',
        `<head><script>window.__GLOSS__=${JSON.stringify({ backendUrl: '' })}</script>`,
      );
    }
  }
  return undefined;
}

export function startServer(
  backend: Backend,
  options: ServeOptions,
): Promise<{ url: string; close: () => Promise<void> }> {
  const jobs = new JobManager({ cache: backend.cache, model: backend.model, judge: backend.judge });
  const app = createApp({
    jobs,
    cache: backend.cache,
    health: backend.health,
    token: options.token,
    corsOrigins: options.corsOrigins,
  });
  const shell = shellHtml();
  if (shell) {
    app.use('/assets/*', serveStatic({ root: WEB_ROOT }));
    app.use('/favicon.svg', serveStatic({ root: WEB_ROOT }));
    app.get('*', (c) => c.html(shell));
  } else {
    app.get('*', (c) =>
      c.text(
        'The gloss web app is not built. Run `pnpm --filter @gloss/web build`, or `pnpm dev` for development.',
        503,
      ),
    );
  }

  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: options.port, hostname: options.host }, (info) => {
      resolve({
        url: `http://${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${info.port}`,
        close: () =>
          new Promise((done) => {
            jobs.abortAll();
            server.close(() => done());
          }),
      });
    });
    server.on('error', reject);
  });
}
