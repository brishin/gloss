// Eval only (not for main): tours gloss PRs with the real backend, records Jev's visual pick
// with pictures, asks again text-only, and writes each candidate PNG plus results.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Visual } from '@gloss/protocol';
import { Effect, Layer, Stream } from 'effect';
import { JudgeClient } from '../core/src/adapters/types.ts';
import { pickVisual, visualQuestions, visualState } from '../core/src/pipeline/judge-questions.ts';
import { runTour } from '../core/src/pipeline/orchestrator.ts';
import { visualPng } from '../core/src/pipeline/visual-image.ts';
import { BackendLayer } from './src/backend.ts';

// Args: `owner/repo#number` (or a bare number for brishin/gloss). EVAL_OUT names the output folder.
const prs = process.argv.slice(2).map((arg) => {
  const [, owner = 'brishin', repo = 'gloss', number] = /^(?:([^/]+)\/([^#]+)#)?(\d+)$/.exec(arg) ?? [];
  return { owner, repo, number: Number(number) };
});
const out = join(import.meta.dirname, '..', '..', 'eval-out', process.env.EVAL_OUT ?? '');
const results: unknown[] = [];

await Effect.runPromise(
  Effect.gen(function* () {
    const judge = yield* JudgeClient;
    for (const { owner, repo, number } of prs) {
      const seen: { state: Record<string, unknown>; answers: unknown }[] = [];
      const recording = Layer.succeed(JudgeClient, {
        model: judge.model,
        judge: (request) => {
          if (!request.state.candidates) return judge.judge(request);
          const entry: { state: Record<string, unknown>; answers: unknown } = {
            state: request.state,
            answers: undefined,
          };
          seen.push(entry);
          return judge.judge(request).pipe(
            Effect.tap((answers) =>
              Effect.sync(() => {
                entry.answers = answers;
              }),
            ),
            Effect.tapError((error) =>
              Effect.sync(() => {
                entry.answers = { error: error.message };
              }),
            ),
          );
        },
      });
      const events = [
        ...(yield* Stream.runCollect(runTour({ ref: { kind: 'github-pr', owner, repo, number }, force: true })).pipe(
          Effect.provide(recording),
        )),
      ];
      const summaries = events.filter((event) => event.type === 'tour.summary');
      const shown = summaries.at(-1)?.visual;
      const call = seen[0];
      const dir = join(out, `${repo}-${number}`);
      mkdirSync(dir, { recursive: true });
      const candidates = call
        ? Object.values(call.state.candidates as Record<string, Visual & { picture?: string }>).map(
            ({ picture: _, ...visual }) => visual as Visual,
          )
        : shown
          ? [shown]
          : [];
      candidates.forEach((visual, i) => {
        const png = visualPng(visual);
        if (png) writeFileSync(join(dir, `c${i + 1}-${visual.kind}.png`), png);
      });
      let textOnly: unknown;
      if (candidates.length) {
        const state = visualState(
          String(call?.state.pr_title ?? ''),
          String(call?.state.summary ?? ''),
          [],
          candidates,
          false,
        );
        const answers = yield* judge.judge({
          state: { ...state, decisions: call?.state.decisions },
          questions: visualQuestions(candidates.length, false),
        });
        textOnly = {
          answers,
          pick: pickVisual(
            candidates.map((c) => c.kind),
            answers,
          ),
        };
      }
      const withImages = call && {
        images:
          call.state.candidates &&
          Object.values(call.state.candidates as Record<string, { picture?: string }>).some((c) => c.picture),
        answers: call.answers,
        pick: shown ? candidates.findIndex((c) => JSON.stringify(c) === JSON.stringify(shown)) : undefined,
      };
      results.push({
        repo: `${owner}/${repo}`,
        number,
        candidates,
        withImages,
        textOnly,
        warnings: events.filter((e) => e.type === 'job.warning').map((e) => e.message),
      });
      console.log(
        number,
        candidates.map((c) => c.kind),
        'images pick',
        withImages?.pick,
        'text pick',
        (textOnly as { pick?: number })?.pick,
        'workflow',
        (call?.answers as { workflow?: { probability?: number } } | undefined)?.workflow?.probability,
      );
    }
  }).pipe(Effect.provide(BackendLayer)),
);
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
