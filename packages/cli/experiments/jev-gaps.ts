/**
 * EVAL ONLY (not for merge): question wordings for the Jev check that drops a description gap
 * which one of define's decisions already makes. Reads the precheck runs' outputs and prints one
 * compact line per gap.
 *
 *   node packages/cli/experiments/jev-gaps.ts [outDir]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { type JudgeAnswer, JudgeClient, type JudgeQuestion } from '@gloss/core';
import { Effect, ManagedRuntime, Option } from 'effect';
import { BackendLayer } from '../src/backend.ts';

const dir = process.argv[2] ?? join(homedir(), 'Programming/gloss/.eval-out/jev-more');
const runtime = ManagedRuntime.make(BackendLayer);
const judge = Option.getOrUndefined(await runtime.runPromise(Effect.serviceOption(JudgeClient)));
if (!judge) {
  throw new Error('No Jev client configured.');
}

const QUESTIONS: Record<string, JudgeQuestion> = {
  covered: {
    type: 'bool',
    instructions: 'Does one of `listed_decisions` already make the point of `gap`, even in other words?',
    criteria: {
      true: 'A listed decision names the same mismatch, risk or reach that the gap names.',
      false: 'No listed decision says what the gap says, or one only touches the same code for another reason.',
    },
  },
  unmentioned: {
    type: 'bool',
    instructions:
      'Is `gap` only saying that the pull request description leaves out a change, where one of `listed_decisions` already describes that same change?',
    criteria: {
      true: 'The gap reports a change that the description does not mention, and a listed decision names that change.',
      false:
        'The gap says the description claims, promises or implies something that the diff contradicts, does only in part or goes beyond, such as a stated audience, platform, scope or approach; or no listed decision names the change.',
    },
  },
  contradicts: {
    type: 'bool',
    instructions:
      'Does `gap` say that the pull request description states something specific (a claim, a scope, a platform, an audience or an approach) that the code change does not match?',
    criteria: {
      true: 'The gap sets words of the description against what the diff does: described as one thing, but the diff does another, less or more.',
      false: 'The gap only reports a change or behavior that the description does not mention.',
    },
  },
  named: {
    type: 'bool',
    instructions: 'Does one of `listed_decisions` describe the same code change that `gap` is about?',
  },
};

const p = (answer: JudgeAnswer | undefined) =>
  answer?.type === 'bool' ? Math.round(answer.probability * 100) / 100 : -1;

for (const name of readdirSync(dir)
  .filter((file) => /-p[12]-(early|pre|prejev)\.json$/.test(file))
  .sort()) {
  const run = name.replace('.json', '');
  const tour = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  const listed = (tour.decisions ?? [])
    .filter((decision: { source?: string }) => decision.source !== 'description')
    .map((decision: { text: string }) => decision.text);
  const kept = (tour.decisions ?? [])
    .filter((decision: { source?: string }) => decision.source === 'description')
    .map((decision: { text: string }) => decision.text);
  const scored = [...readFileSync(join(dir, `${run}.stderr`), 'utf8').matchAll(/^EVAL gap (.*)$/gm)].map(
    (match) => JSON.parse(match[1]!).text as string,
  );
  for (const gap of new Set([...kept, ...scored])) {
    const base = { pr_title: tour.meta.title, gap, listed_decisions: listed };
    const [plain, described] = await Promise.all([
      runtime.runPromise(judge.judge({ state: base, questions: QUESTIONS })),
      runtime.runPromise(
        judge.judge({
          state: { ...base, pr_description: String(tour.meta.description ?? '').slice(0, 4000) },
          questions: { unmentioned: QUESTIONS.unmentioned!, contradicts: QUESTIONS.contradicts! },
        }),
      ),
    ]);
    console.log(
      [
        run,
        `covered=${p(plain.covered)}`,
        `unmentioned=${p(plain.unmentioned)}`,
        `contradicts=${p(plain.contradicts)}`,
        `named=${p(plain.named)}`,
        `unmentioned_d=${p(described.unmentioned)}`,
        `contradicts_d=${p(described.contradicts)}`,
        gap.slice(0, 70),
      ].join(' | '),
    );
  }
}
await runtime.dispose();
setTimeout(() => process.exit(0), 50).unref();
