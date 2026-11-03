// The static export's entry (`gloss export`): the tour page as the app renders it, over the
// snapshot the CLI embeds in `#gloss-snapshot`, with no backend. See vite.export.config.ts.
import { parseTourSnapshot, type SourceRef } from '@gloss/protocol';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { routeTree } from '../routeTree.gen.ts';
import { inflateJson } from './gzip.ts';
import css from '../styles.css?inline';

/** The tour's route (mirrors the CLI's `webPath`). */
function tourPath(ref: SourceRef): string {
  return ref.kind === 'github-pr'
    ? `/gh/${ref.owner}/${ref.repo}/pull/${ref.number}`
    : `/local?${new URLSearchParams({ repo: ref.repo, target: ref.target })}`;
}

async function start() {
  const embedded = document.getElementById('gloss-snapshot')?.textContent?.trim();
  if (!embedded) throw new Error('This page has no tour in it.');
  const snapshot = parseTourSnapshot(await inflateJson(embedded));
  window.__GLOSS__ = { snapshot };

  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);

  // The app's root route renders the whole document for TanStack Start; here it mounts in a div.
  Object.assign(routeTree.options, { shellComponent: ({ children }: { children: ReactNode }) => children });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [tourPath(snapshot.ref)] }),
  });
  createRoot(document.getElementById('gloss')!).render(<RouterProvider router={router} />);
}

start().catch((error: unknown) => {
  document.getElementById('gloss')!.textContent = error instanceof Error ? error.message : String(error);
});
