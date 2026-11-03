import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Repos } from '@gloss/core';
import {
  type CaptureOptions,
  captureTourSnapshot,
  createHttpGlossClient,
  type GlossClient,
  type SourceRef,
  type TourSnapshot,
} from '@gloss/protocol';
import { createApp, Jobs, Logins } from '@gloss/server';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { BackendInfo, BackendLayer } from './backend.ts';
import { CHECKOUT } from './update.ts';

/** The export build of the web app (`pnpm --filter @gloss/web build`): one module, nothing to fetch. */
export const EXPORT_ROOT = join(CHECKOUT, 'apps/web/dist/export');

/**
 * Keeps text from closing the inline `<script>` it sits in. U+FFFD (only ever inside string
 * literals in the bundle) is escaped too, since some hosts reject a file that contains it.
 */
const inlineScript = (text: string) =>
  text
    .replace(/<\/(script)/gi, '<\\/$1')
    .replace(/<!--/g, '\\x3C!--')
    .replace(/\uFFFD/g, '\\uFFFD');

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);

/**
 * One self-contained HTML file: the tour page as the app renders it (light and dark), over a
 * gzipped snapshot of the tour. It needs no backend; the large leaf libraries (grammars,
 * highlighter wasm, diagram layout) load from jsDelivr (see apps/web/vite.export.config.ts).
 */
export function exportHtml(snapshot: TourSnapshot, root = EXPORT_ROOT): string {
  const script = join(root, 'tour.js');
  if (!existsSync(script)) {
    throw new Error('The export build is missing. Run `pnpm --filter @gloss/web build`.');
  }
  const title = snapshot.events.find((event) => event.type === 'diff.ready')?.meta.title ?? 'Tour';
  const packed = gzipSync(JSON.stringify(snapshot), { level: 9 }).toString('base64');
  const icon = readFileSync(join(root, 'favicon.svg'), 'utf8');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} · gloss</title>`,
    `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(icon)}">`,
    '</head>',
    '<body>',
    '<div id="gloss"></div>',
    `<script type="application/octet-stream" id="gloss-snapshot">${packed}</script>`,
    `<script type="module">${inlineScript(readFileSync(script, 'utf8'))}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * A backend for one export: an in-process API (no port) over this machine's models, cache and
 * repositories, or a running server at `backendUrl`.
 */
export async function exportBackend(backendUrl?: string, token?: string) {
  if (backendUrl) {
    return { client: createHttpGlossClient({ baseUrl: backendUrl, token }), close: async () => {} };
  }
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(Jobs.layer(), Logins.layer(), Repos.layer).pipe(Layer.provideMerge(BackendLayer)),
  );
  const info = await runtime.runPromise(BackendInfo.use(Effect.succeed));
  const app = createApp({ runtime, health: () => info.health() });
  const client: GlossClient = createHttpGlossClient({
    baseUrl: 'http://gloss.export',
    fetch: (input, init) => Promise.resolve(app.fetch(new Request(input, init))),
  });
  return { client, judge: info.judge, close: () => runtime.dispose() };
}

/** A file name for a ref's export: `owner-repo-123`, or the repo folder and target. */
export function exportName(ref: SourceRef): string {
  const name =
    ref.kind === 'github-pr'
      ? `${ref.owner}-${ref.repo}-${ref.number}`
      : [ref.repo.split('/').filter(Boolean).at(-1), ref.target].filter(Boolean).join('-');
  return name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'tour';
}

/** Runs (or replays from the cache) the tour for `ref` and renders it as one HTML file. */
export async function exportTour(client: GlossClient, ref: SourceRef, options: CaptureOptions = {}): Promise<string> {
  return exportHtml(await captureTourSnapshot(client, ref, options));
}
