// Experiment, not part of the CLI: runs the symbol card prompt on a saved tour + diff.
// node packages/cli/eval-symbol.ts <dir with tour.json diff.json> [out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSymbol, type SymbolCard } from '@gloss/core';
import type { DiffPayload, Tour } from '@gloss/protocol';
import { Effect, ManagedRuntime } from 'effect';
import { BackendLayer } from './src/backend.ts';

const [dir = '.proof-symbol', out = join(dir, 'cards.json')] = process.argv.slice(2);
const tour = JSON.parse(readFileSync(join(dir, 'tour.json'), 'utf8')) as Tour;
const diff = JSON.parse(readFileSync(join(dir, 'diff.json'), 'utf8')) as DiffPayload;
const cases: { path: string; line: number; symbol: string }[] = JSON.parse(
  readFileSync(join(dir, 'cases.json'), 'utf8'),
);

interface Outcome {
  path: string;
  line: number;
  symbol: string;
  ms: number;
  card?: SymbolCard;
  reads?: string[];
  model?: string;
  error?: string;
}

const runtime = ManagedRuntime.make(BackendLayer);
const results = await runtime.runPromise(
  Effect.forEach(
    cases,
    Effect.fnUntraced(function* (c) {
      const file = diff.files.find((candidate) => candidate.path.endsWith(c.path));
      const started = Date.now();
      if (!file) {
        return { ...c, ms: 0, error: 'no such file in the diff' } satisfies Outcome as Outcome;
      }
      return yield* runSymbol({ tour, diff, fileId: file.id, line: c.line, symbol: c.symbol }).pipe(
        Effect.map((result): Outcome => ({ ...c, ms: Date.now() - started, ...result })),
        Effect.catch((error) => Effect.succeed<Outcome>({ ...c, ms: Date.now() - started, error: error.message })),
      );
    }),
    { concurrency: 3 },
  ),
);
writeFileSync(out, JSON.stringify(results, null, 1));
for (const result of results) {
  console.log(`\n## ${result.symbol} (${result.ms} ms)`);
  console.log(JSON.stringify(result.card ?? result.error, null, 1));
}
await runtime.dispose();
