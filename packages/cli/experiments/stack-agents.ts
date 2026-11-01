// Experiment: one pipeline per PR (today) vs a stack coordinator plus one tour agent per PR.
// Not part of the product. Run from the repo root:
//   node packages/cli/experiments/stack-agents.ts <out-dir> owner/repo#12,13,14 [owner/repo#20,21] ...
// Each argument is one stack, bottom PR first. For every stack it writes:
//   brief.json              the coordinator's stack brief (arm B)
//   A-<n>.md, B-<n>.md       each PR's tour rendered as Markdown (A today, B multi-agent)
//   judge-<n>.json           blind pairwise verdicts, run in both orders
//   stack-judge.json         per arm: points repeated across PRs, false "missing" claims
// and <out-dir>/summary.md over all stacks.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createSource, ModelClient, runTour } from '@gloss/core';
import type { FileChange, SourceRef, Tour, TraceStep } from '@gloss/protocol';
import { Effect, ManagedRuntime, Stream } from 'effect';
import * as v from 'valibot';
import { BackendLayer } from '../src/backend.ts';

type Ref = Extract<SourceRef, { kind: 'github-pr' }>;
type Usage = { input: number; output: number; calls: number };

const [out = 'stack-agents', ...stackArgs] = process.argv.slice(2);
const runtime = ManagedRuntime.make(BackendLayer);

function parseStack(arg: string): Ref[] {
  const match = /^([\w.-]+)\/([\w.-]+)#([\d,]+)$/.exec(arg);
  if (!match) {
    throw new Error(`Expected owner/repo#1,2,3, got ${arg}`);
  }
  return match[3]!.split(',').map((n) => ({ kind: 'github-pr', owner: match[1]!, repo: match[2]!, number: Number(n) }));
}

const usageOf = (steps: Iterable<TraceStep>): Usage => {
  const usage = { input: 0, output: 0, calls: 0 };
  for (const step of steps) {
    if (step.usage) {
      usage.input += step.usage.input;
      usage.output += step.usage.output;
      usage.calls++;
    }
  }
  return usage;
};

async function tourOf(ref: Ref, context?: string) {
  const steps = new Map<string, TraceStep>();
  const started = Date.now();
  const last = await runtime.runPromise(
    runTour({ ref, force: true, context, onStep: (step) => steps.set(step.id, step) }).pipe(Stream.runLast),
  );
  if (last._tag === 'None' || last.value.type !== 'tour.complete') {
    throw new Error(`#${ref.number}: the tour did not finish`);
  }
  return { tour: last.value.tour, seconds: (Date.now() - started) / 1000, usage: usageOf(steps.values()) };
}

async function ask<S extends v.GenericSchema>(tier: 'define' | 'notes', system: string, prompt: string, result: S) {
  const response = await runtime.runPromise(
    Effect.gen(function* () {
      const model = yield* ModelClient;
      return yield* model.prompt({ tier, system, prompt, result, resultName: 'result' });
    }),
  );
  return { data: response.data as v.InferOutput<S>, usage: response.usage };
}

// ---------------------------------------------------------------- coordinator (arm B)

const ref = (what: string) =>
  v.array(
    v.object({
      number: v.pipe(v.number(), v.description('The other PR number.')),
      what: v.pipe(v.string(), v.description(what)),
    }),
  );

const BriefSchema = v.object({
  goal: v.pipe(
    v.string(),
    v.description('2-3 sentences: what the whole stack achieves, and how the work is split across its PRs.'),
  ),
  members: v.array(
    v.object({
      number: v.number(),
      role: v.pipe(v.string(), v.description("1-2 sentences: this PR's job in the stack, in the reviewer's words.")),
      buildsOn: v.pipe(
        ref('The piece from that lower PR this PR uses, e.g. "the `StackBrief` type".'),
        v.description('What this PR uses from PRs below it. Those were reviewed there; do not re-explain them here.'),
      ),
      setsUp: v.pipe(
        ref('What that higher PR adds or finishes on top of this one.'),
        v.description(
          'What this PR leaves for PRs above it: anything a reviewer of this PR alone might flag as missing or unused, that a later PR supplies.',
        ),
      ),
      focus: v.pipe(
        v.array(v.string()),
        v.description(
          '0-3 things to check in this PR that only matter with the whole stack in view, such as an interface later PRs depend on. Leave empty when nothing does.',
        ),
      ),
    }),
  ),
});
type Brief = v.InferOutput<typeof BriefSchema>;

const COORDINATOR_SYSTEM = `You coordinate the review of a stack of pull requests: each PR is based on the one before it. A separate agent writes each PR's review tour. That agent sees only its own PR's diff plus the brief you write for it, so your brief is its only view of the rest of the stack.

Write the brief so each agent attributes work to the right PR, does not re-explain what lower PRs already introduced, does not flag as missing what a higher PR adds, and checks what later PRs depend on. State only what the diffs and descriptions show; if a link between PRs is not visible, leave it out. Keep each entry short.

Call the submit tool once with the brief for every PR, bottom first.`;

function plainDiff(file: FileChange, budget: number): string {
  const text = file.hunks.map((hunk) => `${hunk.header}\n${hunk.patch}`).join('\n');
  return text.length > budget ? `${text.slice(0, budget)}\n... (truncated)` : text;
}

type Member = { ref: Ref; title: string; description?: string; files: FileChange[] };

function memberSection(member: Member, budget: number, perFile: number): string {
  const parts = [
    `# PR #${member.ref.number}: ${member.title}`,
    member.description?.trim() ? member.description.trim().slice(0, 1500) : '(no description)',
    '',
    '## Files',
    ...member.files.map((file) => `- ${file.path} +${file.additions} -${file.deletions}`),
  ];
  if (budget > 0) {
    parts.push('', '## Diffs');
    let remaining = budget;
    for (const file of member.files) {
      if (remaining <= 0 || file.isBinary || file.generated) {
        continue;
      }
      const body = plainDiff(file, Math.min(perFile, remaining));
      parts.push(`### ${file.path}`, body);
      remaining -= body.length;
    }
  }
  return parts.join('\n');
}

function renderContext(brief: Brief, members: Member[], index: number): string {
  const me = brief.members.find((entry) => entry.number === members[index]!.ref.number);
  const list = members.map(
    (member, i) => `${i + 1}. #${member.ref.number} ${member.title}${i === index ? ' (this PR)' : ''}`,
  );
  const lines = [
    `This PR is ${index + 1} of ${members.length} in a stack, bottom first:`,
    ...list,
    '',
    `Stack goal: ${brief.goal}`,
  ];
  if (me) {
    lines.push(`This PR's role: ${me.role}`);
    if (me.buildsOn.length) {
      lines.push(
        '',
        'Builds on (reviewed in lower PRs; do not re-explain or re-decide them here):',
        ...me.buildsOn.map((entry) => `- #${entry.number}: ${entry.what}`),
      );
    }
    if (me.setsUp.length) {
      lines.push(
        '',
        'Left for higher PRs (do not flag these as missing or unused here):',
        ...me.setsUp.map((entry) => `- #${entry.number}: ${entry.what}`),
      );
    }
    if (me.focus.length) {
      lines.push('', 'Check with the stack in mind:', ...me.focus.map((entry) => `- ${entry}`));
    }
  }
  lines.push('', "Use this only to frame the tour. Groups, notes and decisions still come from this PR's own diff.");
  return lines.join('\n');
}

// ---------------------------------------------------------------- rendering + judging

function renderTour(tour: Tour): string {
  const path = new Map(tour.files.map((file) => [file.id, file.path]));
  const lines = ['## Overview', tour.overallSummary ?? '(none)'];
  if (tour.visual) {
    lines.push('', `(Visual: ${tour.visual.kind}${tour.visual.caption ? `, "${tour.visual.caption}"` : ''})`);
  }
  if (tour.decisions?.length) {
    lines.push('', '## Change-wide decisions', ...tour.decisions.map((d) => `- [${d.priority}] ${d.text}`));
  }
  for (const group of tour.groups) {
    lines.push('', `## Section: ${group.label}${group.critical ? ' (critical)' : ''}`, group.summary);
    lines.push(`Files: ${group.fileIds.map((id) => path.get(id) ?? id).join(', ')}`);
    const notes = tour.notes[group.key];
    if (!notes) {
      continue;
    }
    for (const note of notes.fileNotes) {
      lines.push(`- note ${path.get(note.fileId)}: ${note.text}`);
    }
    for (const note of notes.lineNotes) {
      lines.push(`- note ${path.get(note.fileId)}:${note.line}: ${note.text}`);
    }
    for (const note of notes.riskNotes) {
      lines.push(`- risk (${note.risk}) ${path.get(note.fileId)}: ${note.text}`);
    }
    for (const decision of notes.decisions ?? []) {
      const at = decision.fileId ? ` ${path.get(decision.fileId)}${decision.line ? `:${decision.line}` : ''}` : '';
      lines.push(`- decision [${decision.priority}]${at}: ${decision.text}`);
    }
  }
  return lines.join('\n');
}

const score = (what: string) => v.pipe(v.number(), v.minValue(1), v.maxValue(5), v.description(what));
const TourScores = v.object({
  accuracy: score('1-5: every claim is true of the diff.'),
  scope: score(
    "1-5: explains this PR's own work; does not present lower-PR work as new or flag as missing what a higher PR adds.",
  ),
  stackFit: score('1-5: helps the reviewer see how this PR fits the stack (what it relies on, what depends on it).'),
  signal: score('1-5: notes and decisions save real effort; little filler or restated code.'),
  overall: score('1-5: how much you would want this tour when reviewing this PR.'),
  errors: v.pipe(v.array(v.string()), v.description('Each concrete false or out-of-scope claim, quoted briefly.')),
});
const PairSchema = v.object({
  tour1: TourScores,
  tour2: TourScores,
  winner: v.picklist(['1', '2', 'tie']),
  why: v.pipe(v.string(), v.description('2-4 sentences on what decided it, citing specific notes.')),
});

const JUDGE_SYSTEM = `You are a staff engineer judging two review tours of the same pull request. The PR is one of a stack of PRs, each based on the one before. You see every PR of the stack (titles, descriptions, files), the diff of the PR under review, and the two tours. The tours were made by different methods; do not guess which. Judge only what helps a reviewer of this PR, and check claims against the diff. Longer is not better. Call the submit tool once.`;

const StackJudgeSchema = v.object({
  repeated: v.pipe(
    v.array(v.object({ point: v.string(), prs: v.array(v.number()) })),
    v.description(
      'Points (a decision, risk or explanation) that the tours of two or more PRs both make about the same code.',
    ),
  ),
  falseMissing: v.pipe(
    v.array(v.object({ pr: v.number(), claim: v.string() })),
    v.description(
      "Claims in a PR's tour that something is missing, unused or unhandled when another PR in the stack supplies it.",
    ),
  ),
  crossLinks: v.pipe(
    v.number(),
    v.description('How many statements correctly tie a PR to another PR of the stack (e.g. "used by the next PR").'),
  ),
  coherence: score('1-5: read in order, the tours tell one clear story of the stack.'),
});

const STACK_JUDGE_SYSTEM = `You are a staff engineer reading the review tours of every PR in a stack, in order (bottom first). Each PR is based on the one before. Count what the instructions ask, quoting briefly. Call the submit tool once.`;

function stackHeader(members: Member[]): string {
  return members.map((member) => memberSection(member, 0, 0)).join('\n\n');
}

// ---------------------------------------------------------------- run

async function runStack(refs: Ref[]) {
  const name = `${refs[0]!.owner}-${refs[0]!.repo}-${refs.map((r) => r.number).join('-')}`;
  const dir = `${out}/${name}`;
  mkdirSync(dir, { recursive: true });
  const members: Member[] = await Promise.all(
    refs.map(async (ref) => {
      const { meta, files } = await createSource(ref).fetch();
      return { ref, title: meta.title, description: meta.description, files };
    }),
  );
  console.error(`${name}: ${members.map((m) => `#${m.ref.number} (${m.files.length} files)`).join(', ')}`);

  // Arm A: today, one independent pipeline per PR (run concurrently, as the app would on open).
  const startA = Date.now();
  const armA = await Promise.all(refs.map((ref) => tourOf(ref)));
  const secondsA = (Date.now() - startA) / 1000;

  // Arm B: the coordinator briefs every PR, then one tour agent per PR runs in parallel.
  const startB = Date.now();
  const budget = Math.floor(60_000 / members.length);
  const coordinatorPrompt = members.map((member) => memberSection(member, budget, 4000)).join('\n\n');
  const coordinator = await ask('define', COORDINATOR_SYSTEM, coordinatorPrompt, BriefSchema);
  const contexts = members.map((_, i) => renderContext(coordinator.data, members, i));
  const armB = await Promise.all(refs.map((ref, i) => tourOf(ref, contexts[i])));
  const secondsB = (Date.now() - startB) / 1000;
  writeFileSync(
    `${dir}/brief.json`,
    JSON.stringify({ brief: coordinator.data, contexts, usage: coordinator.usage }, null, 2),
  );

  const header = stackHeader(members);
  const perPr = [];
  for (const [i, member] of members.entries()) {
    const n = member.ref.number;
    const a = renderTour(armA[i]!.tour);
    const b = renderTour(armB[i]!.tour);
    writeFileSync(`${dir}/A-${n}.md`, `# A (today) #${n} ${member.title}\n\n${a}\n`);
    writeFileSync(`${dir}/B-${n}.md`, `# B (multi-agent) #${n} ${member.title}\n\n${b}\n`);
    const diff = memberSection(member, 40_000, 8000);
    const judge = (first: string, second: string) =>
      ask(
        'notes',
        JUDGE_SYSTEM,
        [
          `# The stack (bottom first)`,
          header,
          '',
          `# The PR under review: #${n}`,
          diff,
          '',
          '# Tour 1',
          first,
          '',
          '# Tour 2',
          second,
        ].join('\n'),
        PairSchema,
      );
    // Both orders, to cancel position bias.
    const [ab, ba] = await Promise.all([judge(a, b), judge(b, a)]);
    const verdict = {
      ab: ab.data,
      ba: ba.data,
      A: avgScores(ab.data.tour1, ba.data.tour2),
      B: avgScores(ab.data.tour2, ba.data.tour1),
      wins: {
        A: +(ab.data.winner === '1') + +(ba.data.winner === '2'),
        B: +(ab.data.winner === '2') + +(ba.data.winner === '1'),
      },
    };
    writeFileSync(`${dir}/judge-${n}.json`, JSON.stringify(verdict, null, 2));
    perPr.push({ number: n, title: member.title, files: member.files.length, ...verdict });
    console.error(
      `  #${n}: A ${verdict.A.overall} vs B ${verdict.B.overall}, wins A${verdict.wins.A}/B${verdict.wins.B}`,
    );
  }

  const stackJudge = async (arm: typeof armA) => {
    const prompt = members
      .map((member, i) => `# Tour of PR #${member.ref.number}: ${member.title}\n${renderTour(arm[i]!.tour)}`)
      .join('\n\n');
    return (await ask('notes', STACK_JUDGE_SYSTEM, `# The stack\n${header}\n\n${prompt}`, StackJudgeSchema)).data;
  };
  const [stackA, stackB] = await Promise.all([stackJudge(armA), stackJudge(armB)]);
  writeFileSync(`${dir}/stack-judge.json`, JSON.stringify({ A: stackA, B: stackB }, null, 2));

  const sum = (arm: typeof armA, extra?: { input: number; output: number }) =>
    arm.reduce(
      (acc, run) => ({
        input: acc.input + run.usage.input,
        output: acc.output + run.usage.output,
        calls: acc.calls + run.usage.calls,
      }),
      { input: extra?.input ?? 0, output: extra?.output ?? 0, calls: extra ? 1 : 0 },
    );
  return {
    name,
    perPr,
    stack: { A: stackA, B: stackB },
    cost: { A: { seconds: secondsA, ...sum(armA) }, B: { seconds: secondsB, ...sum(armB, coordinator.usage) } },
  };
}

function avgScores(x: v.InferOutput<typeof TourScores>, y: v.InferOutput<typeof TourScores>) {
  const keys = ['accuracy', 'scope', 'stackFit', 'signal', 'overall'] as const;
  const result = Object.fromEntries(keys.map((key) => [key, (x[key] + y[key]) / 2])) as Record<
    (typeof keys)[number],
    number
  >;
  return { ...result, errors: x.errors.length + y.errors.length };
}

mkdirSync(out, { recursive: true });
const results = [];
for (const arg of stackArgs) {
  try {
    results.push(await runStack(parseStack(arg)));
  } catch (error) {
    console.error(`${arg}: FAILED ${error instanceof Error ? error.stack : String(error)}`);
  }
}
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));

const md = ['# Stack tours: today (A) vs coordinator + per-PR agents (B)', ''];
md.push(
  '| PR | files | overall A | overall B | scope A | scope B | stackFit A | stackFit B | errors A | errors B | wins A/B |',
);
md.push('|---|---|---|---|---|---|---|---|---|---|---|');
for (const stack of results) {
  for (const pr of stack.perPr) {
    md.push(
      `| ${stack.name.split('-').slice(0, 2).join('/')}#${pr.number} | ${pr.files} | ${pr.A.overall} | ${pr.B.overall} | ${pr.A.scope} | ${pr.B.scope} | ${pr.A.stackFit} | ${pr.B.stackFit} | ${pr.A.errors} | ${pr.B.errors} | ${pr.wins.A}/${pr.wins.B} |`,
    );
  }
}
md.push(
  '',
  '| stack | repeated A | repeated B | false missing A | false missing B | cross-links A | cross-links B | coherence A | coherence B | s A | s B | tokens in A | tokens in B |',
);
md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const stack of results) {
  const { A, B } = stack.stack;
  md.push(
    `| ${stack.name} | ${A.repeated.length} | ${B.repeated.length} | ${A.falseMissing.length} | ${B.falseMissing.length} | ${A.crossLinks} | ${B.crossLinks} | ${A.coherence} | ${B.coherence} | ${Math.round(stack.cost.A.seconds)} | ${Math.round(stack.cost.B.seconds)} | ${stack.cost.A.input} | ${stack.cost.B.input} |`,
  );
}
writeFileSync(`${out}/summary.md`, `${md.join('\n')}\n`);
console.error(md.join('\n'));
await runtime.dispose();
