import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { fileImportQuery, type ImportQuery } from '../sources/importers.ts';
import { callerTree, countCallers, gateLines, renderCallerTree } from './callers.ts';

describe('gateLines', () => {
  it('keeps flag and role checks, not imports of their helpers or bare words', () => {
    const text = [
      "import { useFlag } from '@/flags';",
      'export function Button() {',
      "  const editor = useFlag('ts-web-editor');",
      '  if (user.role !== "admin") return null;',
      "  const label = 'Admin tools';",
      '  const canEditTitle = true;',
      '  return <div />;',
      '}',
    ].join('\n');
    expect(gateLines(text)).toEqual([
      "3: const editor = useFlag('ts-web-editor');",
      '4: if (user.role !== "admin") return null;',
    ]);
  });
});

describe('callerTree', () => {
  // editor <- lightbox <- button <- page, and editor <- story
  const importers: Record<string, string[]> = {
    Editor: [
      "web/Lightbox.tsx:2:import { Editor } from './Editor';",
      "web/Editor.stories.tsx:1:import { Editor } from './Editor';",
    ],
    Lightbox: ["web/Button.tsx:3:import { Lightbox } from './Lightbox';"],
    Button: ["web/Page.tsx:1:import { Button } from './Button';"],
  };
  const files: Record<string, string> = { 'web/Button.tsx': "const on = useFlag('ts-web-editor');" };
  const lookup = {
    importers: (query: ImportQuery) => Effect.succeed(importers[query.term] ?? []),
    read: (path: string) => Effect.succeed<string | undefined>(files[path] ?? ''),
  };

  it('follows importers up to the depth, with the gates where they sit', async () => {
    const nodes = await Effect.runPromise(
      callerTree(lookup, fileImportQuery('web/Editor.tsx')!, { depth: 2, fanout: 5, budget: 10 }),
    );
    expect(renderCallerTree(nodes)).toEqual([
      "web/Lightbox.tsx:2:import { Editor } from './Editor';",
      "  web/Button.tsx:3:import { Lightbox } from './Lightbox';",
      "    gate web/Button.tsx:1: const on = useFlag('ts-web-editor');",
    ]);
    // The story imports the editor too, but no one meets it.
    expect(countCallers(nodes)).toBe(2);
  });

  it('stops at the budget and never shows a file twice', async () => {
    const seen = new Set(['web/Button.tsx']);
    const nodes = await Effect.runPromise(
      callerTree(lookup, fileImportQuery('web/Editor.tsx')!, { depth: 3, fanout: 5, budget: 1 }, seen),
    );
    expect(nodes.map((node) => node.path)).toEqual(['web/Lightbox.tsx']);
    expect(countCallers(nodes)).toBe(1);
  });
});
