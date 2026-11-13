/**
 * EVAL ONLY (not for merge): offline experiments on where Jev could do more in a tour.
 *
 *   node packages/cli/experiments/jev-more.ts <mode> --tour <tour.json> --trace <trace.json> --out <out.json>
 *
 * Modes: place, verify, dedupe, precheck, diet. Each reads a finished tour (`gloss tour --json`)
 * and its trace (`GLOSS_EVAL_TRACE`), loads the diff from the cache, and writes one JSON file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { hashOf, type JudgeAnswer, JudgeClient, type JudgeQuestion, ModelClient, TourCache } from '@gloss/core';
import type { DiffPayload, FileChange, Tour } from '@gloss/protocol';
import { Effect, ManagedRuntime, Option } from 'effect';
import { fileState } from '../../core/src/pipeline/judge-questions.ts';
import {
  buildDefinePrompt,
  buildDescriptionCheckPrompt,
  DESCRIPTION_CHECK_SYSTEM,
  DESCRIPTION_CHECK_VERSION,
  DescriptionCheckSchema,
  quotedGaps,
  renderNumberedHunk,
} from '../../core/src/pipeline/prompts.ts';
import { HUNK_QUESTIONS, HUNK_SKIP, hunkCut, hunkState } from '../../core/src/pipeline/sections.ts';
import { BackendLayer } from '../src/backend.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { tour: { type: 'string' }, trace: { type: 'string' }, out: { type: 'string' } },
});
const mode = positionals[0];
if (!mode || !values.tour || !values.trace || !values.out) {
  throw new Error('Usage: jev-more.ts <place|verify|dedupe|precheck|diet> --tour T --trace R --out O');
}

type Step = { id: string; output?: any; prompt?: string; startMs?: number; endMs?: number };
const tour = JSON.parse(readFileSync(values.tour, 'utf8')) as Tour & { diffId: string };
const steps = new Map((JSON.parse(readFileSync(values.trace, 'utf8')) as Step[]).map((step) => [step.id, step]));

const runtime = ManagedRuntime.make(BackendLayer);
const cache = await runtime.runPromise(TourCache.use(Effect.succeed));
const model = await runtime.runPromise(ModelClient.use(Effect.succeed));
const judge = Option.getOrUndefined(await runtime.runPromise(Effect.serviceOption(JudgeClient)));
if (!judge) {
  throw new Error('No Jev client configured.');
}
const diff = cache.get<DiffPayload>(tour.diffId);
if (!diff) {
  throw new Error(`Diff ${tour.diffId} is not in the cache; run the tour first.`);
}
const { meta, files } = diff;
const byId = new Map(files.map((file) => [file.id, file]));
const byPath = new Map(files.map((file) => [file.path, file]));

type Answers = Record<string, JudgeAnswer>;
let jevCalls = 0;
let jevFresh = 0;
/** One Jev call, cached under `request` (pass the pipeline's own request shape to share its cache). */
async function ask(
  state: Record<string, unknown>,
  questions: Record<string, JudgeQuestion>,
  request: unknown = { kind: 'eval-jev-more', model: judge!.model, state, questions },
  fresh = false,
): Promise<Answers> {
  jevCalls++;
  const key = hashOf({ kind: 'judge-file', request });
  const hit = fresh ? undefined : cache.get<Answers>(key);
  if (hit) {
    return hit;
  }
  jevFresh++;
  const value = await runtime.runPromise(judge!.judge({ state, questions }));
  cache.put(key, 'judge-file', value, judge!.model);
  return value;
}

async function pool<T, R>(items: readonly T[], size: number, work: (item: T, index: number) => Promise<R>) {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const at = next++;
        out[at] = await work(items[at]!, at);
      }
    }),
  );
  return out;
}

const p = (answer: JudgeAnswer | undefined) => (answer?.type === 'bool' ? answer.probability : undefined);
const round = (value: number | undefined) => (value === undefined ? undefined : Math.round(value * 100) / 100);
const changed = (hunk: FileChange['hunks'][number]) =>
  hunk.patch.split('\n').filter((row) => row[0] === '+' || row[0] === '-').length;

/** Files Jev was unsure of: does a second Jev question place them where the LLM follow-up did? */
async function place() {
  const groups: { key: string; label: string; summary: string }[] = steps.get('define')?.output?.groups ?? [];
  const unsure: string[] = steps.get('place')?.output?.unsure ?? [];
  const placed: Record<string, string> = steps.get('place')?.output?.placed ?? {};
  const llm = new Map<string, string>(
    (steps.get('followup')?.output?.placements ?? []).map((entry: { fileId: string; groupKey: string }) => [
      entry.fileId,
      entry.groupKey,
    ]),
  );
  const first = steps.get('judge-groups')?.output ?? {};
  const members = new Map<string, string[]>();
  for (const [path, where] of Object.entries(placed)) {
    const [key, reason] = where.split(' ');
    if (!unsure.includes(path) && reason?.includes('jev')) {
      members.set(key!, [...(members.get(key!) ?? []), path]);
    }
  }
  const criteria = (withMembers: boolean) =>
    Object.fromEntries(
      groups.map((group) => {
        const here = (members.get(group.key) ?? []).slice(0, 10);
        return [
          group.key,
          `${group.label}: ${group.summary}${withMembers && here.length ? ` Files already placed in this group: ${here.join(', ')}.` : ''}`,
        ];
      }),
    );
  const question = (withMembers: boolean): Record<string, JudgeQuestion> => ({
    group: {
      type: 'choice',
      instructions: 'Which review group is the change in `file` part of?',
      criteria: criteria(withMembers),
    },
  });
  const choice = (answers: Answers) =>
    answers.group?.type === 'choice'
      ? { choice: answers.group.choice, confidence: round(answers.group.confidence) }
      : undefined;
  const rows = [];
  for (const path of unsure) {
    const file = byPath.get(path);
    if (!file) {
      continue;
    }
    const base = fileState(meta.title, file);
    const started = performance.now();
    const [withMembers, withSummary, both, perHunk] = await Promise.all([
      ask(base, question(true)),
      ask({ ...base, change_summary: tour.overallSummary ?? '' }, question(false)),
      ask({ ...base, change_summary: tour.overallSummary ?? '' }, question(true)),
      pool(file.hunks, 8, (hunk) =>
        ask(
          {
            pr_title: meta.title,
            file: { path: file.path, status: file.status },
            hunk: `${hunk.header}\n${hunk.patch}`.slice(0, 6000),
          },
          {
            group: {
              type: 'choice',
              instructions: 'Which review group is the change in `hunk` part of?',
              criteria: criteria(false),
            },
          },
        ),
      ),
    ]);
    const votes = new Map<string, number>();
    perHunk.forEach((answers, at) => {
      if (answers.group?.type === 'choice') {
        for (const [key, probability] of Object.entries(answers.group.probabilities)) {
          votes.set(key, (votes.get(key) ?? 0) + probability * changed(file.hunks[at]!));
        }
      }
    });
    const ranked = [...votes].sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((sum, [, weight]) => sum + weight, 0) || 1;
    rows.push({
      path,
      hunks: file.hunks.length,
      llm: llm.get(file.id),
      top: first[path]?.group
        ? {
            choice: first[path].group.choice,
            confidence: round(first[path].group.confidence),
            probabilities: first[path].group.probabilities,
          }
        : undefined,
      fitsAnyGroup: round(first[path]?.fitsAnyGroup),
      members: choice(withMembers),
      summary: choice(withSummary),
      both: choice(both),
      hunkVote: ranked[0] ? { choice: ranked[0][0], share: round(ranked[0][1] / total) } : undefined,
      ms: Math.round(performance.now() - started),
    });
  }
  return { groups: groups.map((group) => group.key), followupMs: stepMs('followup'), rows };
}

const stepMs = (id: string) => {
  const step = steps.get(id);
  return step?.endMs !== undefined && step.startMs !== undefined ? step.endMs - step.startMs : undefined;
};

function hunkOf(fileId: string, hunkId: string | undefined, line: number | undefined) {
  const file = byId.get(fileId);
  const hunk =
    file?.hunks.find((candidate) => candidate.id === hunkId) ??
    file?.hunks.find(
      (candidate) =>
        line !== undefined &&
        ((candidate.newStart <= line && line < candidate.newStart + Math.max(candidate.newLines, 1)) ||
          (candidate.oldStart <= line && line < candidate.oldStart + Math.max(candidate.oldLines, 1))),
    );
  return file && hunk ? { file, hunk } : undefined;
}

/** The hunk as the notes prompt numbers it, cut to about `cap` characters around `line`. */
function windowed(hunk: FileChange['hunks'][number], line: number | undefined, cap = 6000): string {
  const text = renderNumberedHunk(hunk);
  if (text.length <= cap) {
    return text;
  }
  const rows = text.split('\n');
  const at = Math.max(
    0,
    rows.findIndex((row) => line !== undefined && new RegExp(`^[+ -] ${line} `).test(row)),
  );
  let from = at;
  let to = at;
  let used = rows[at]!.length;
  while (used < cap && (from > 1 || to < rows.length - 1)) {
    if (from > 1) {
      used += rows[--from]!.length + 1;
    }
    if (to < rows.length - 1) {
      used += rows[++to]!.length + 1;
    }
  }
  return [rows[0], from > 1 ? '... (earlier lines omitted)' : '', ...rows.slice(Math.max(from, 1), to + 1)]
    .filter(Boolean)
    .join('\n');
}

const VERIFY_QUESTIONS: Record<string, JudgeQuestion> = {
  contradicted: {
    type: 'bool',
    instructions: 'Does the code in `hunk` contradict what `note` says the code does?',
    criteria: {
      true: 'The note states that the code does, checks, calls, sets or omits something, and the lines in the hunk show it does something else or the opposite.',
      false:
        'The hunk is consistent with the note, or the note is about code, behavior or consequences outside these lines that the hunk can neither confirm nor refute.',
    },
  },
  grounded: {
    type: 'bool',
    instructions:
      'Is the thing `note` is about (the function, value, condition, field or line it names) present in `hunk`?',
    criteria: {
      true: 'The names or behavior the note points at can be found in the lines shown.',
      false: 'The note talks about names or behavior that do not appear in the lines shown.',
    },
  },
  actionable: {
    type: 'bool',
    instructions:
      'Does `note` give a code reviewer something to check, question or decide, beyond describing what the code does?',
    criteria: {
      true: 'It names a risk, an uncovered case, a cost, a consequence or a choice someone could disagree with.',
      false: 'It only restates or explains what the changed lines do, or reassures that the change is safe.',
    },
  },
};

/** Every line note and pinned decision, checked by Jev against the hunk it sits on. */
async function verify() {
  const items: { group: string; kind: string; fileId: string; hunkId?: string; line?: number; text: string }[] = [];
  for (const [group, notes] of Object.entries(tour.notes)) {
    for (const note of notes.lineNotes) {
      items.push({
        group,
        kind: note.critical ? 'note!' : 'note',
        fileId: note.fileId,
        hunkId: note.hunkId,
        line: note.line,
        text: note.text,
      });
    }
    for (const decision of notes.decisions ?? []) {
      if (decision.fileId) {
        items.push({
          group,
          kind: `decision:${decision.priority}`,
          fileId: decision.fileId,
          hunkId: decision.hunkId,
          line: decision.line,
          text: decision.text,
        });
      }
    }
  }
  const started = performance.now();
  const rows = await pool(items, 12, async (item) => {
    const at = hunkOf(item.fileId, item.hunkId, item.line);
    if (!at) {
      return { ...item, path: byId.get(item.fileId)?.path, missing: true };
    }
    const hunk = windowed(at.hunk, item.line);
    const answers = await ask(
      { pr_title: meta.title, file: { path: at.file.path }, hunk, note: { line: item.line, text: item.text } },
      VERIFY_QUESTIONS,
    );
    return {
      group: item.group,
      kind: item.kind,
      path: at.file.path,
      line: item.line,
      text: item.text,
      contradicted: round(p(answers.contradicted)),
      grounded: round(p(answers.grounded)),
      actionable: round(p(answers.actionable)),
      hunk,
    };
  });
  return { ms: Math.round(performance.now() - started), rows };
}

const SAME: Record<string, JudgeQuestion> = {
  same: {
    type: 'bool',
    instructions:
      'Do `a` and `b` make the same point about this code change, so that a reviewer who has read `a` learns nothing new from `b`?',
    criteria: {
      true: 'Both name the same choice, risk or behavior in the same code, even in different words.',
      false:
        'They are about different code, or about different choices or risks in the same code, or one adds a consequence, case or cost the other lacks.',
    },
  },
};

/** Pairs of claims in one tour that Jev says make the same point. */
async function dedupe() {
  type Item = { id: string; where: string; group?: string; text: string; listed?: number };
  const items: Item[] = (tour.decisions ?? []).map((decision, index) => ({
    id: `D${index}`,
    where: decision.source === 'description' ? 'description gap' : 'change-wide decision',
    text: decision.text,
  }));
  for (const [group, notes] of Object.entries(tour.notes)) {
    (notes.decisions ?? []).forEach((decision, index) =>
      items.push({ id: `G:${group}:${index}`, where: 'group decision', group, text: decision.text, listed: index }),
    );
    (notes.section?.points ?? []).forEach((point, index) => {
      if (point.kind !== 'wide') {
        items.push({
          id: `S:${group}:${index}`,
          where: point.decision === undefined ? `own ${point.kind} stop` : 'stop for a group decision',
          group,
          text: `${point.title}. ${point.why}`,
          ...(point.decision === undefined ? {} : { listed: point.decision }),
        });
      }
    });
    for (const [index, note] of notes.lineNotes.entries()) {
      items.push({ id: `N:${group}:${index}`, where: 'line note', group, text: note.text });
    }
  }
  const kind = (item: Item) => item.id[0]!;
  const pairs: [Item, Item][] = [];
  for (const [i, a] of items.entries()) {
    for (const b of items.slice(i + 1)) {
      // A stop written for a listed group decision repeats it by design.
      const byDesign = a.group === b.group && a.listed !== undefined && a.listed === b.listed && kind(a) !== kind(b);
      // Notes are compared only inside their group.
      const noteAcross = (kind(a) === 'N' || kind(b) === 'N') && a.group !== b.group;
      if (!byDesign && !noteAcross) {
        pairs.push([a, b]);
      }
    }
  }
  const started = performance.now();
  const scored = await pool(pairs, 16, async ([a, b]) => {
    const answers = await ask({ pr_title: meta.title, a: a.text, b: b.text }, SAME);
    return { a, b, same: round(p(answers.same)) ?? 0 };
  });
  return {
    items: items.length,
    pairs: pairs.length,
    ms: Math.round(performance.now() - started),
    over: {
      '0.5': scored.filter((pair) => pair.same >= 0.5).length,
      '0.7': scored.filter((pair) => pair.same >= 0.7).length,
      '0.9': scored.filter((pair) => pair.same >= 0.9).length,
    },
    hits: scored.filter((pair) => pair.same >= 0.4).sort((x, y) => y.same - x.same),
  };
}

/**
 * The description check started beside define (no decisions listed), with Jev dropping the gaps
 * define's decisions already make, against today's check that waits for define.
 */
async function precheck() {
  const listed = (tour.decisions ?? []).filter((decision) => decision.source !== 'description');
  const define = model.config().define;
  const run = async (prompt: string) => {
    const key = hashOf({ kind: 'description-check', request: { DESCRIPTION_CHECK_VERSION, model: define, prompt } });
    const hit = cache.get<any>(key);
    const started = performance.now();
    const value =
      hit ??
      (
        await runtime.runPromise(
          model.prompt({
            tier: 'define',
            system: DESCRIPTION_CHECK_SYSTEM,
            prompt,
            result: DescriptionCheckSchema,
            resultName: 'descriptionCheck',
          }),
        )
      ).data;
    if (!hit) {
      cache.put(key, 'description-check', value, define);
    }
    const quoted = value.claims.length ? quotedGaps(meta, value.decisions as { quote: string }[]) : [];
    const gaps = (quoted as any[]).filter((gap) => !String(gap.admittedBy ?? '').trim());
    return {
      cached: !!hit,
      ms: hit ? undefined : Math.round(performance.now() - started),
      raw: value.decisions.length,
      gaps: gaps.map((gap) => ({ text: gap.text as string, priority: gap.priority as string })),
    };
  };
  const [after, beside] = await Promise.all([
    run(buildDescriptionCheckPrompt(meta, files, listed)),
    run(buildDescriptionCheckPrompt(meta, files, [])),
  ]);
  const covered = async (gap: { text: string }) =>
    round(
      p(
        (
          await ask(
            { pr_title: meta.title, gap: gap.text, listed_decisions: listed.map((decision) => decision.text) },
            {
              covered: {
                type: 'bool',
                instructions: 'Does one of `listed_decisions` already make the point of `gap`, even in other words?',
                criteria: {
                  true: 'A listed decision names the same mismatch, risk or reach that the gap names.',
                  false:
                    'No listed decision says what the gap says, or one only touches the same code for another reason.',
                },
              },
            },
          )
        ).covered,
      ),
    );
  return {
    listed: listed.map((decision) => decision.text),
    inTour: (tour.decisions ?? []).filter((decision) => decision.source === 'description').map((d) => d.text),
    after: {
      ...after,
      gaps: await Promise.all(after.gaps.map(async (gap) => ({ ...gap, covered: await covered(gap) }))),
    },
    beside: {
      ...beside,
      gaps: await Promise.all(beside.gaps.map(async (gap) => ({ ...gap, covered: await covered(gap) }))),
    },
    checkMsInTour: stepMs('description-check'),
  };
}

/** What folding Jev's mechanical hunks frees in the define prompt, and how long Jev takes on every hunk. */
async function diet() {
  const hunks = files
    .filter((file) => !file.isBinary && !file.truncated)
    .flatMap((file) => file.hunks.map((hunk) => ({ file, hunk })));
  const started = performance.now();
  // Timed without the cache: this is what a tour would wait for before define.
  const answers = await pool(hunks, 16, ({ file, hunk }) => {
    const state = hunkState(meta.title, file, hunk);
    return ask(state, HUNK_QUESTIONS, { kind: 'hunk', model: judge!.model, state, questions: HUNK_QUESTIONS }, true);
  });
  const jevMs = Math.round(performance.now() - started);
  const folded = new Set(
    hunks.flatMap(({ file, hunk }, at) =>
      !hunkCut(hunk) && (p(answers[at]!.skip) ?? 0) >= HUNK_SKIP ? [`${file.id}:${hunk.id}`] : [],
    ),
  );
  const cut = (prompt: string) => {
    const omitted = /\(Diffs omitted for budget: ([^.]*)\./.exec(prompt)?.[1]?.split(', ') ?? [];
    const truncated: string[] = [];
    let current = '';
    for (const line of prompt.split('\n')) {
      if (line.startsWith('### ')) {
        current = line.slice(4).split(' ')[1] ?? '';
      } else if (line.startsWith('... (truncated)')) {
        truncated.push(current);
      }
    }
    return { chars: prompt.length, omitted: omitted.map((id) => byId.get(id)?.path ?? id), truncated };
  };
  const today = cut(buildDefinePrompt(meta, files, false));
  const dieted = cut(buildDefinePrompt(meta, files, false, [], { folded }));
  const foldedChars = hunks.reduce(
    (sum, { file, hunk }) => sum + (folded.has(`${file.id}:${hunk.id}`) ? hunk.patch.length : 0),
    0,
  );
  return {
    files: files.length,
    hunks: hunks.length,
    folded: folded.size,
    foldedChars,
    diffChars: hunks.reduce((sum, { hunk }) => sum + hunk.patch.length, 0),
    jevMs,
    today,
    dieted,
  };
}

const modes: Record<string, () => Promise<unknown>> = { place, verify, dedupe, precheck, diet };
const runMode = modes[mode];
if (!runMode) {
  throw new Error(`Unknown mode ${mode}`);
}
try {
  const result = await runMode();
  writeFileSync(
    values.out,
    JSON.stringify({ mode, title: meta.title, jev: { calls: jevCalls, fresh: jevFresh }, result }, null, 2),
  );
  console.error(`${mode}: wrote ${values.out} (${jevCalls} Jev calls, ${jevFresh} fresh)`);
} finally {
  await runtime.dispose();
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
}
