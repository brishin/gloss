import { existsSync, readFileSync } from 'node:fs';
import { Repos } from '@gloss/core';
import { createApp, Jobs, Logins } from '@gloss/server';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { BackendInfo, BackendLayer } from './backend.ts';
import { restartDetached } from './daemon.ts';
import { createUpdater, headCommit, SHELLS, WEB_ROOT, webBuildStale } from './update.ts';

export const DEFAULT_PORT = 4777;

export interface ServeOptions {
  port: number;
  host: string;
  token?: string;
  corsOrigins: string[];
}

function shellHtml(): string | undefined {
  for (const name of SHELLS) {
    const path = `${WEB_ROOT}/${name}`;
    if (existsSync(path)) {
      if (webBuildStale()) {
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

/** Serves the API and the web app; closing it aborts every running tour and closes the cache. */
export async function startServer(
  options: ServeOptions,
): Promise<{ url: string; judge?: string; close: () => Promise<void> }> {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(Jobs.layer(), Logins.layer(), Repos.layer).pipe(Layer.provideMerge(BackendLayer)),
  );
  const info = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* BackendInfo;
    }),
  );
  const commit = await headCommit();
  const app = createApp({
    runtime,
    health: async () => ({ ...(await info.health()), commit }),
    token: options.token,
    corsOrigins: options.corsOrigins,
    update: commit ? createUpdater(commit, () => restartDetached(options.port)) : undefined,
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
    const server = serve({ fetch: app.fetch, port: options.port, hostname: options.host }, (address) => {
      resolve({
        url: `http://${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${address.port}`,
        judge: info.judge,
        close: async () => {
          await runtime.dispose();
          await new Promise((done) => server.close(done));
        },
      });
    });
    server.on('error', reject);
  });
}
