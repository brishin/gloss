// Experiment, not part of the CLI: runs the symbol card prompt on a saved tour + diff.
// node packages/cli/eval-symbol.ts <dir with tour.json diff.json> [out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
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
  checked?: { place: string; does: string; gate: string }[];
  reads?: string[];
  model?: string;
  timing?: unknown;
  error?: string;
}

type Thinking = 'off' | 'minimal' | 'low' | 'medium' | 'high';
function fanoutFromEnv() {
  const env = process.env;
  return {
    ...(env.GLOSS_SYMBOL_SUB_MODEL ? { model: env.GLOSS_SYMBOL_SUB_MODEL } : {}),
    ...(env.GLOSS_SYMBOL_SUB_THINKING ? { thinking: env.GLOSS_SYMBOL_SUB_THINKING as Thinking } : {}),
    ...(env.GLOSS_SYMBOL_SYNTH_MODEL ? { synthModel: env.GLOSS_SYMBOL_SYNTH_MODEL } : {}),
    ...(env.GLOSS_SYMBOL_SYNTH_THINKING ? { synthThinking: env.GLOSS_SYMBOL_SYNTH_THINKING as Thinking } : {}),
  };
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
      return yield* runSymbol({
        tour,
        diff,
        fileId: file.id,
        line: c.line,
        symbol: c.symbol,
        // GLOSS_SYMBOL_TIER=followup, GLOSS_SYMBOL_PRELOAD=1: timing arms.
        tier: (process.env.GLOSS_SYMBOL_TIER as 'notes' | 'followup' | undefined) ?? 'notes',
        preload: process.env.GLOSS_SYMBOL_PRELOAD === '1',
        callers: process.env.GLOSS_SYMBOL_CALLERS === '1',
        lean: process.env.GLOSS_SYMBOL_LEAN === '1',
        // GLOSS_SYMBOL_FANOUT=1: parallel readers, then one card call; _SUB_ and _SYNTH_ pick their models.
        ...(process.env.GLOSS_SYMBOL_FANOUT === '1' ? { fanout: fanoutFromEnv() } : {}),
        // GLOSS_SYMBOL_STREAM=1: the lead is written as text before submit; timing.leadFirst is when it shows.
        ...(process.env.GLOSS_SYMBOL_STREAM === '1' ? { onLead: () => {} } : {}),
      }).pipe(
        Effect.map((result): Outcome => ({ ...c, ms: Date.now() - started, ...result })),
        Effect.catch((error) => Effect.succeed<Outcome>({ ...c, ms: Date.now() - started, error: error.message })),
      );
    }),
    // GLOSS_SYMBOL_CONCURRENCY=1 times one card at a time, as a reader clicks them.
    { concurrency: Number(process.env.GLOSS_SYMBOL_CONCURRENCY ?? 3) },
  ),
);
writeFileSync(out, JSON.stringify(results, null, 1));
for (const result of results) {
  console.log(`\n## ${result.symbol} (${result.ms} ms)`);
  console.log(JSON.stringify(result.card ?? result.error, null, 1));
}
await runtime.dispose();
