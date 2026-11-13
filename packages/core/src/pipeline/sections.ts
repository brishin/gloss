/**
 * A group read like the overview and the walkthrough, above its open diffs: the group's walk.
 *
 * One call per group on the notes model, after its notes and the walkthrough, writes the walk: a
 * few stops in reading order, each a claim, its reason and the lines that show it. The change-wide
 * decisions whose code is in the group are placed among its own stops, so the tour has no separate
 * walkthrough stop. Beside that call Jev reads each hunk: one it is sure a reviewer can skip folds
 * inside its file, a contract change nothing points at gets a note, and a key hunk nothing points
 * at is offered to a small follow-up call for a stop of its own.
 *
 * The walk rides `GroupNotes.section`, so it needs no event of its own.
 */
import type {
  Decision,
  DecisionWalk,
  DiffMeta,
  FileChange,
  GroupNotes,
  ResolvedGroup,
  Section,
  SectionPoint,
  Snippet,
} from '@gloss/protocol';
import { DECISION_PRIORITIES } from '@gloss/protocol';
import * as v from 'valibot';
import type { JudgeQuestion } from '../adapters/types.ts';
import { hashOf } from '../hash.ts';
import { clip, normalizeSnippet, normalizeTree } from './normalize.ts';
import { collapsedReason, FILE_BUDGET, header, manifestLine, renderNumberedHunk, TOTAL_BUDGET } from './prompts.ts';

/**
 * Part of every section call's cache key, beside its system and prompt text. Bump when a result
 * schema changes in a way that should rerun the calls.
 */
export const SECTIONS_VERSION = 6;

const short = (description: string) => v.pipe(v.string(), v.description(description));

const snippet = v.object({
  fileId: short('Id of the file, from "## Files".'),
  hunkId: short('Id of the hunk, from its "@@ hunk" header.'),
  from: v.pipe(v.number(), v.description('First new-file line number to show, as printed in the diff.')),
  to: v.pipe(v.number(), v.description('Last new-file line number to show, as printed in the diff.')),
  focus: v.pipe(v.number(), v.description('The new-file line number, from..to, of the one line that matters most.')),
  caption: short('One sentence on what these lines show. Never paraphrase the code line by line.'),
  note: short(
    'One sentence pinned under the focus line, only for what the code does not say (a consequence, an edge case, what the line replaced); "" otherwise. A listed note about these lines goes here.',
  ),
});

const stopFields = {
  decision: v.pipe(
    v.number(),
    v.description('decision: its number under "Decisions in this group" when it is one of them, else -1. step: -1.'),
  ),
  priority: v.pipe(
    v.picklist([...DECISION_PRIORITIES, 'none']),
    v.description('decision: the listed priority, or your own for a decision that is not listed. step: none.'),
  ),
  title: short(
    'A few words, as a claim, e.g. "Catch-up replays share 24 slots per process" or "A send is queued before it is validated". No Markdown.',
  ),
  why: short(
    'One or two sentences. decision: why the change makes this choice and what it costs, from what the code shows. step: what happens here and why the reviewer needs it. Code names in backticks.',
  ),
  instead: short(
    'decision: the option it chose against, in a few words; "" when there was no real alternative or for a step.',
  ),
  check: short(
    'One sentence on what the reviewer should hold the code to: the consequence if this is wrong, or a case it does not cover. "" when there is none.',
  ),
};

const REST = short(
  'One sentence on what the walk leaves out of this group and why it can be skimmed, e.g. "The other four files only rename the import." "" when the walk shows everything.',
);

const point = v.object({
  kind: v.pipe(
    v.picklist(['decision', 'step', 'wide']),
    v.description(
      'wide: one of the stops under "Already written for this group", placed where it belongs in the reading order; give only its number in wide and leave the other fields empty. decision: a choice the reviewer should accept or reject on purpose. step: how a piece works, when the reviewer needs it to follow the group.',
    ),
  ),
  ...stopFields,
  snippets: v.pipe(
    v.array(snippet),
    v.description('1-2 snippets in reading order, 2-10 lines each. Empty for a wide stop.'),
  ),
  wide: v.pipe(v.number(), v.description('wide: the number of the already written stop. Otherwise -1.')),
  tree: v.pipe(
    v.picklist(['none', 'calls', 'concepts']),
    v.description(
      'calls: the stop runs across functions on a call path, or many callers now reach it (the callers are the rows). concepts: the stop defines a hierarchy (what counts, kinds, which case resolves how). none: the snippets say it all, which is common.',
    ),
  ),
  nodes: v.pipe(
    v.array(
      v.object({
        depth: v.pipe(v.number(), v.description('0 for a root; a child is one deeper than the row it belongs to.')),
        receiver: short('calls: what the function is called on, e.g. "self._slots"; "" otherwise.'),
        name: short('calls: the function or method name only; "" for a concept.'),
        args: short('calls: its parameters as short names, or "..."; "" otherwise.'),
        status: v.pipe(
          v.picklist(['new', 'changed', 'same']),
          v.description(
            'calls: new if the change adds it, changed if its body or signature changes, same otherwise. concepts: same.',
          ),
        ),
        label: short('concepts: the concept in a few words; "" for a call.'),
        note: short('A few words on its part in the stop; "" when none.'),
        fileId: short('Id of the file that defines it, or "".'),
        line: v.pipe(
          v.number(),
          v.description('The new-file line number printed before its definition in the diff, or 0.'),
        ),
        snippet: v.pipe(v.number(), v.description('Index (from 0) of the snippet that shows under this row, or -1.')),
      }),
    ),
    v.description('The tree, top down, 3-10 rows. Empty when tree is none.'),
  ),
});

/** What the section call returns: the group's walk and the files a reviewer can skip. */
export const SectionResultSchema = v.pipe(
  v.object({
    intro: short(
      'One sentence tying this group to the groups read before it, e.g. "The queue from the last section is drained here." "" for the first group or when nothing ties them.',
    ),
    points: v.pipe(
      v.array(point),
      v.description(
        'The stops in the order a reviewer should read them: every already written stop once (kind wide), plus at most 6 of your own. None of your own for a group with nothing more to decide or follow.',
      ),
    ),
    rest: REST,
    skim: v.pipe(
      v.array(v.string()),
      v.description(
        "Ids of this group's files that are truly unimportant to review: generated or vendored output, pure renames and moves, import-only or mechanical edits, snapshots and fixtures. They fold; every other file stays open below the walk. Empty when every file deserves a read. Never a file a stop or a note points at.",
      ),
    ),
  }),
  v.description('One group of the change, read as a short walk above its diffs.'),
);

/** What the key-hunk follow-up returns: stops only, each a claim and one snippet. */
export const KeyStopsResultSchema = v.pipe(
  v.object({
    points: v.pipe(
      v.array(
        v.object({
          kind: v.pipe(
            v.picklist(['decision', 'step']),
            v.description(
              'decision: a choice the reviewer should accept or reject on purpose. step: how a piece works, when the reviewer needs it to follow the group.',
            ),
          ),
          ...stopFields,
          snippets: v.pipe(v.array(snippet), v.description('1-3 snippets in reading order, 2-12 lines each.')),
        }),
      ),
      v.description(
        'The stops, in the order a reviewer should read them: usually 2-6, fewer for a small group, none for a group with nothing to decide or follow (tests that only cover the code, mechanical edits).',
      ),
    ),
    rest: REST,
  }),
  v.description('One group of the change, read as a short walk through its code.'),
);

export const SECTION_SYSTEM = `You are a senior engineer walking a reviewer through one group of a code change. The tour has no separate walkthrough: after the overview, the reviewer reads each group as a short walk and then its diffs, which stay open below it. So the walk is a guide to the diff, not a replacement: it says what to hold the code to before the reviewer reads it: a few stops in reading order, each one claim, its reason and the few lines of code that show it.

Some stops are already written: the change-wide decisions whose code lives in this group, listed under "Already written for this group" with the lines they show. Place each of them once, as a stop of kind wide, where it belongs in the reading order. Do not rewrite them; build your own stops around them. When a claim of yours rests on lines one of them shows, or on lines listed under "Code path read in this group", still write the stop and point its snippet at those lines: it is read as its claim with a link to that code, which is not shown twice. Change-wide decisions read in other groups are listed too: do not walk those.

A stop is one of:
- decision: a choice a reasonable engineer could have made differently. Give every listed decision of this group a stop unless it is trivial; say why the change makes it, what it chose against and what to hold the code to.
- step: how a piece works, when the reviewer cannot follow the group without it: where the path starts, the shape of the data, the line where the behavior changes. Use steps sparingly; never one that only narrates what the code plainly says.

For each stop: a title that is a short claim, why in one or two sentences, and 1-3 short slices of the diff (2-12 lines each) in reading order, with the one line that matters most as focus. The caption says what the lines show. A listed note about the same lines becomes the snippet's note, so nothing the notes found is lost; a note that fits no stop and matters gets a stop of its own.

Order the stops so each one prepares the next: what is defined before where it is used, the main path before its edge cases. Never show the same lines in two stops. Leave out tests (unless a test is the only place a rule is stated), generated files, renames and mechanical edits, then say in rest what you left out and why it is safe to skim. A group with nothing to decide or follow has no stops and only rest.

Point slices at the file id, the hunk id from its "@@ hunk" header, and new-file line numbers printed in the diff. When a diff is truncated or omitted, call read_file rather than guess; snippets still point only at lines the diff prints.

Keep the walk tight. The diff is open below, so only 3 of your stops show their code: the ones that matter most. Still write every decision in this group that a reviewer should accept or reject on purpose as a stop of kind decision with its priority, in reading order, each with the one snippet it rests on: past the first 3 a decision is read as its title and reason with a link to the line, so make those stand alone. Write a step only when the reviewer needs it to follow the group, at most 2. At most 6 stops of your own. One claim per stop: split a stop that argues two things, and drop the weaker of two stops that make the same point. The full diff is right below, so keep slices short: at most 2 snippets per stop, 2-6 lines each, just the lines the claim rests on. Prefer the stop a reviewer could disagree with over the one that only explains.

Use the pattern that fits each stop. Most stops are a claim and a snippet. Give a stop a tree only when it helps the reviewer see how the code connects: calls when the stop runs across functions on a call path or many callers now reach one function, concepts when it defines a hierarchy (what counts, which case resolves how). A row whose code a snippet shows points at that snippet. Leave out logging, framework plumbing and small getters.

The prompt lists the groups the reviewer read before this one. Write intro as one sentence that ties this group to them, when something does: what it consumes, completes or guards. Never restate the group's summary and never describe the walk itself.

For a group of tests, a stop is a rule the tests pin down or a case they leave uncovered, shown at the test that states it; never a description of what a test does. For documentation and agent guidance, a stop is a rule or intent the text sets that the code should be held to.

Last, list in skim the files that are truly unimportant to review: generated output, pure renames and moves, import-only or mechanical edits, snapshots and fixtures. They fold and every other file stays open, so be strict: a file with any logic a reviewer should read is not skim. Rest says in one sentence what the skimmed files are.

Call the submit tool once with the result.`;

export const KEY_STOPS_SYSTEM = `You are a senior engineer walking a reviewer through one group of a code change. The group's walk is written: its stops are listed in the prompt, and the group's diffs are open below it. A classifier marked the hunks under "Hunks the walk does not reach" as places where the main behavior of the change is decided, and no stop or note points at them.

For each of those hunks, write one stop if a reviewer should be pointed at it: what the code there decides, said as a claim a reviewer could disagree with. Leave a hunk out when a listed stop already makes its point, or when it holds nothing a reviewer should accept or reject on purpose. Writing no stops is a fine answer.

A stop is a decision (a choice a reasonable engineer could have made differently, with its priority, what it chose against and what to hold the code to) or a step (how a piece works, when the reviewer cannot follow the group without it). For each stop: a title that is a short claim, why in one or two sentences, and one slice of 2-6 lines from that hunk with the one line that matters most as focus. Point the slice at the file id, the hunk id from its "@@ hunk" header and the new-file line numbers printed in the diff. Leave decision as -1 and rest empty.

Call the submit tool once with the result.`;

/**
 * What Jev is asked about one hunk on its own. Only `skip` decides the fold: requiring a sure
 * "no" on `logic` as well only removed right folds. `logic` stays in the call because the skip
 * scores were measured with it beside them, and a question's company moves its score.
 */
export const HUNK_QUESTIONS: Record<string, JudgeQuestion> = {
  skip: {
    type: 'bool',
    instructions:
      'Can a code reviewer safely skip the change in `hunk` because it is mechanical and follows from changes made elsewhere?',
    criteria: {
      true: 'Only import or export lines, formatting or line wrapping, comments, moved code, a rename carried through, an existing call updated to pass a new or renamed argument, or, in a test file, setup, fixtures or fakes rewritten to a new helper or signature while what the test checks stays the same.',
      false:
        'It adds or changes what the code does or what a test checks, or a reviewer could disagree with it: a condition, a value, a default, a new function or parameter definition, a new test, a changed assertion, configuration or a prompt.',
    },
  },
  logic: {
    type: 'bool',
    instructions:
      'Does the change in `hunk` add or change behavior: a condition, a computed or default value, a new function, class or test, a changed assertion or expected value, or which options a feature offers?',
    criteria: {
      true: 'At least one changed line decides or computes something new, defines something new, or changes what a test expects.',
      false:
        'Every changed line is an import, a rename, formatting, a comment, or an existing call or test setup adjusted to match a change made elsewhere.',
    },
  },
};

/**
 * What Jev is asked about one hunk given what the change is for. A call of its own: asked beside
 * `skip`, these lowered the skip scores and right folds were lost.
 */
export const HUNK_WIDE_QUESTIONS: Record<string, JudgeQuestion> = {
  contract: {
    type: 'bool',
    instructions:
      'Does the change in `hunk` change a shape that code or systems outside this module rely on: an HTTP or RPC request or response, an API schema or enum of allowed values, a database table or stored record, a message, event or wire format, or a configuration or environment default?',
    criteria: {
      true: 'A field, allowed value, route, column, stored key, message type or default is added, removed, renamed or retyped in a schema, model, migration, protocol or config definition, so clients, other services or stored data must agree with it.',
      false:
        'A function or method signature, an internal interface or protocol stub, a UI component prop, a local type, a prompt, a test, or code that only reads or passes along a shape defined elsewhere.',
    },
  },
  key: {
    type: 'bool',
    instructions:
      'Is `hunk` one of the few places where the main behavior of the change described in `change_summary` is decided?',
    criteria: {
      true: 'A reviewer who reads only a handful of hunks of this change must read this one: it holds the new rule, branch, query, prompt or state change itself.',
      false: 'It supports the change (plumbing, types, call sites, tests, docs) or is a minor part of it.',
    },
  },
};

/** How sure Jev must be that a hunk can be skipped before it folds. */
export const HUNK_SKIP = 0.7;
/** How sure Jev must be before a hunk is flagged as a contract change, or counted as a key hunk. */
export const HUNK_SURE = 0.8;
/** How many key hunks one group's follow-up call is offered. */
export const KEY_HUNKS = 2;

const HUNK_CHAR_CAP = 6_000;

/** The state Jev judges one hunk in; `context` says what the change and the hunk's group are for. */
export function hunkState(
  prTitle: string,
  file: FileChange,
  hunk: FileChange['hunks'][number],
  context?: { summary: string; group: string },
): Record<string, unknown> {
  const text = `${hunk.header}\n${hunk.patch}`;
  return {
    pr_title: prTitle,
    ...(context ? { change_summary: context.summary, review_group: context.group } : {}),
    file: { path: file.path, status: file.status },
    hunk: text.length > HUNK_CHAR_CAP ? `${text.slice(0, HUNK_CHAR_CAP)}\n... (rest of this hunk omitted)` : text,
  };
}

/** Jev's probabilities for one hunk; a question is absent when its call failed. */
export interface HunkScore {
  fileId: string;
  hunkId: string;
  skip?: number;
  contract?: number;
  key?: number;
}

type HunkRef = Pick<HunkScore, 'fileId' | 'hunkId'>;

const hunkKey = (hunk: HunkRef) => `${hunk.fileId}:${hunk.hunkId}`;

/** The hunks Jev is sure a reviewer can skip. */
export function skippableHunks(scores: readonly HunkScore[]): HunkRef[] {
  return scores.filter((score) => (score.skip ?? 0) >= HUNK_SKIP).map(({ fileId, hunkId }) => ({ fileId, hunkId }));
}

/** The contract flag: on the surest hunk of each file, and never on a skippable one. */
export function contractFlags(scores: readonly HunkScore[]): HunkRef[] {
  const best = new Map<string, HunkScore>();
  for (const score of scores) {
    const p = score.contract ?? 0;
    if (p >= HUNK_SURE && (score.skip ?? 0) < HUNK_SKIP && p > (best.get(score.fileId)?.contract ?? 0)) {
      best.set(score.fileId, score);
    }
  }
  return [...best.values()].map(({ fileId, hunkId }) => ({ fileId, hunkId }));
}

/** The key hunks nothing in the tour points at (`covered` holds `fileId:hunkId`), surest first. */
export function uncoveredKeyHunks(
  scores: readonly HunkScore[],
  section: Section,
  covered: ReadonlySet<string>,
): HunkScore[] {
  const folded = new Set((section.skimHunks ?? []).map(hunkKey));
  return scores
    .filter((score) => {
      const key = hunkKey(score);
      return (
        (score.key ?? 0) >= HUNK_SURE && !covered.has(key) && !folded.has(key) && !section.skim?.includes(score.fileId)
      );
    })
    .toSorted((a, b) => (b.key ?? 0) - (a.key ?? 0))
    .slice(0, KEY_HUNKS);
}

function numbered(file: FileChange, remaining: number): string {
  const body = file.hunks.map(renderNumberedHunk).join('\n');
  const budget = Math.min(FILE_BUDGET, Math.max(remaining, 0));
  if (body.length <= budget) {
    return body;
  }
  return budget > 500 ? `${body.slice(0, budget)}\n... (truncated)` : '(omitted for budget; read_file it)';
}

function found(notes: GroupNotes, pathOf: (fileId: string) => string): string[] {
  const decisions = (notes.decisions ?? []).map(
    (decision, index) =>
      `${index}. (${decision.priority}) ${decision.fileId ? `${pathOf(decision.fileId)}${decision.line ? `:${decision.line}` : ''} ` : ''}${decision.text}`,
  );
  const lines = [
    ...notes.lineNotes.map(
      (note) => `- ${pathOf(note.fileId)}:${note.line}${note.critical ? ' (critical)' : ''} ${note.text}`,
    ),
    ...notes.fileNotes.map((note) => `- ${pathOf(note.fileId)}${note.critical ? ' (critical)' : ''} ${note.text}`),
    ...notes.riskNotes.map((note) => `- ${pathOf(note.fileId)} (risk: ${note.risk}) ${note.text}`),
  ];
  return [
    'Decisions in this group:',
    ...(decisions.length ? decisions : ['(none)']),
    'Notes already written:',
    ...(lines.length ? lines : ['(none)']),
  ];
}

/** Lines a section shows: a snippet, or an excerpt of the code path. */
export type Shown = Pick<Snippet, 'fileId' | 'hunkId' | 'from' | 'to'>;

/**
 * The section call's prompt: the change, the groups read before this one, the group's notes, the
 * change-wide decisions (`wideHere`) and code path excerpts (`pathHere`) read in it, and its diff.
 */
export function buildSectionPrompt(
  meta: DiffMeta,
  overallSummary: string | undefined,
  decisions: readonly Decision[],
  group: ResolvedGroup,
  files: readonly FileChange[],
  notes: GroupNotes,
  before: readonly ResolvedGroup[],
  wideHere: readonly DecisionWalk[],
  pathHere: readonly Shown[],
): string {
  const pathOf = (fileId: string) => files.find((file) => file.id === fileId)?.path ?? fileId;
  const parts = [
    header(meta),
    '',
    '## Overall',
    overallSummary ?? '',
    '',
    '## Change-wide decisions (each is read in the group that holds its code)',
    ...(decisions.length ? decisions.map((decision) => `- ${decision.text}`) : ['(none)']),
    '',
    '## Groups read before this one',
    ...(before.length ? before.map((other) => `- ${other.label}: ${other.summary}`) : ['(none; this is the first)']),
    '',
    `## This group: ${group.label}`,
    group.summary,
    '',
    ...found(notes, pathOf),
    '',
    '## Already written for this group (place each as a wide stop; never show these lines again)',
    ...(wideHere.length
      ? wideHere.map(
          (walk) =>
            `${walk.decision}. ${walk.title}: ${walk.why} Shows ${walk.snippets.map((shown) => `${pathOf(shown.fileId)}:${shown.from}-${shown.to}`).join(', ')}.`,
        )
      : ['(none)']),
  ];
  if (pathHere.length) {
    parts.push(
      '',
      '## Code path read in this group (shown above your stops; never show these lines again)',
      ...pathHere.map((shown) => `- ${pathOf(shown.fileId)}:${shown.from}-${shown.to}`),
    );
  }
  parts.push('', '## Files');
  let remaining = TOTAL_BUDGET;
  for (const file of files) {
    parts.push(`### ${manifestLine(file)}`);
    if (!collapsedReason(file)) {
      const body = numbered(file, remaining);
      remaining -= body.length;
      parts.push(body);
    }
  }
  return parts.join('\n');
}

/** The follow-up call's prompt: the group, the titles of its stops, and the key hunks none of them reach. */
export function buildKeyStopsPrompt(
  meta: DiffMeta,
  overallSummary: string | undefined,
  group: ResolvedGroup,
  files: readonly FileChange[],
  stops: readonly string[],
  hunks: readonly HunkRef[],
): string {
  const parts = [
    header(meta),
    '',
    '## Overall',
    overallSummary ?? '',
    '',
    `## This group: ${group.label}`,
    group.summary,
    '',
    '## Stops already written',
    ...(stops.length ? stops.map((title) => `- ${title}`) : ['(none)']),
    '',
    '## Hunks the walk does not reach',
  ];
  for (const { fileId, hunkId } of hunks) {
    const file = files.find((candidate) => candidate.id === fileId);
    const hunk = file?.hunks.find((candidate) => candidate.id === hunkId);
    if (file && hunk) {
      const body = renderNumberedHunk(hunk);
      parts.push(
        `### ${manifestLine(file)}`,
        body.length > FILE_BUDGET ? `${body.slice(0, FILE_BUDGET)}\n... (truncated)` : body,
      );
    }
  }
  return parts.join('\n');
}

type RawStop = Partial<v.InferOutput<typeof point>>;

/** Stops read from one call, wide placements included. */
const MAX_STOPS = 8;
/** Rows a snippet shows: the full diff is open right below it. */
const SNIPPET_ROWS = 8;
/** Own stops that show their code; a decision past them is read as its claim. */
const CODED_STOPS = 3;

/**
 * The trust boundary for model-written stops: snippets must be in the group's files and in the
 * diff (`normalizeSnippet`), and a decision number must name one of the group's decisions.
 *
 * `shown` holds lines the section shows already. With `claims`, a stop whose lines are among
 * them stays as its claim with a link to the line (`see`); without, a stop with no code left is
 * dropped. `wideHere` are the change-wide stops the call may place.
 */
function readStops(
  rawPoints: unknown,
  group: ResolvedGroup,
  byKey: ReadonlyMap<string, FileChange>,
  notes: GroupNotes,
  shown: Shown[],
  wideHere: readonly DecisionWalk[],
  claims: boolean,
): { points: SectionPoint[]; placed: Set<number>; warnings: string[] } {
  const warnings: string[] = [];
  const points: SectionPoint[] = [];
  const claimed = new Set<number>();
  const placed = new Set<number>();
  let own = 0;
  const entries: RawStop[] = Array.isArray(rawPoints) ? rawPoints.slice(0, MAX_STOPS + wideHere.length) : [];
  for (const entry of entries) {
    if (entry.kind === 'wide') {
      const wide = entry.wide;
      if (wide !== undefined && wideHere.some((walk) => walk.decision === wide) && !placed.has(wide)) {
        placed.add(wide);
        points.push({ kind: 'wide', wide, title: '', why: '', snippets: [] });
      }
      continue;
    }
    if (own >= MAX_STOPS) {
      continue;
    }
    let see: SectionPoint['see'];
    const title = clip(String(entry.title ?? ''), 90);
    const snippets: Snippet[] = [];
    const kept = new Map<number, number>();
    for (const [at, rawSnippet] of (Array.isArray(entry.snippets) ? entry.snippets : []).entries()) {
      const snippet = normalizeSnippet(rawSnippet, byKey, SNIPPET_ROWS);
      if (typeof snippet === 'string') {
        warnings.push(`Dropped a snippet in ${group.key}: ${rawSnippet.fileId}:${rawSnippet.from} ${snippet}.`);
        continue;
      }
      const same = [...shown, ...snippets].some(
        (other) =>
          other.hunkId === snippet.hunkId &&
          other.fileId === snippet.fileId &&
          ((other.from <= snippet.focus && snippet.focus <= other.to) ||
            // Half the snippet's lines already shown is a repeat too.
            (claims &&
              (Math.min(other.to, snippet.to) - Math.max(other.from, snippet.from) + 1) * 2 >=
                snippet.to - snippet.from + 1)),
      );
      if (same) {
        see ??= { fileId: snippet.fileId, line: snippet.focus };
      }
      kept.set(at, same || snippets.length >= 3 ? -1 : snippets.length);
      if (!same && snippets.length < 3) {
        snippets.push(snippet);
      }
    }
    const live = new Map([...kept].filter(([, to]) => to >= 0));
    const tree = normalizeTree(entry.tree, Array.isArray(entry.nodes) ? entry.nodes : [], byKey, live);
    const claimOnly = claims && !!title && snippets.length === 0 && !!see;
    if (!claimOnly && (!title || snippets.length === 0)) {
      warnings.push(`Dropped a stop in ${group.key}: "${title}" has no code in the diff.`);
      continue;
    }
    shown.push(...snippets);
    own++;
    const listed = notes.decisions?.[Number(entry.decision)];
    const index = listed && !claimed.has(Number(entry.decision)) ? Number(entry.decision) : undefined;
    if (index !== undefined) {
      claimed.add(index);
    }
    const kind = entry.kind === 'step' && index === undefined ? 'step' : 'decision';
    const priority =
      listed && index !== undefined ? listed.priority : DECISION_PRIORITIES.find((p) => p === entry.priority);
    const instead = clip(String(entry.instead ?? ''), 160);
    const check = clip(String(entry.check ?? ''), 300);
    points.push({
      kind: kind === 'decision' && !priority ? 'step' : kind,
      ...(index === undefined ? {} : { decision: index }),
      ...(kind === 'decision' && priority ? { priority } : {}),
      title,
      why: clip(String(entry.why ?? ''), 400),
      ...(instead && kind === 'decision' ? { instead } : {}),
      ...(check ? { check } : {}),
      ...(tree && !claimOnly ? { tree } : {}),
      ...(claimOnly ? { see } : {}),
      snippets,
    });
  }
  return { points, placed, warnings };
}

/** Where a hunk's first changed line is, for a note pinned to the hunk. */
function firstChange(hunk: FileChange['hunks'][number]): { side: 'additions' | 'deletions'; line: number } | undefined {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const row of hunk.patch.split('\n')) {
    if (row[0] === '+') {
      return { side: 'additions', line: newLine };
    }
    if (row[0] === '-') {
      return { side: 'deletions', line: oldLine };
    }
    if (row[0] !== '\\') {
      oldLine++;
      newLine++;
    }
  }
  return undefined;
}

/** What the rest of the tour shows of a group, and what Jev says of its hunks. */
export interface SectionContext {
  /** The change-wide decisions read in this group. */
  wideHere: readonly DecisionWalk[];
  /** The code path excerpts read above the group's stops. */
  pathHere: readonly Shown[];
  /** Everything the walkthrough shows anywhere, change-wide snippets and code path excerpts: a file among them never folds, nor a hunk. */
  shownInTour: readonly Pick<Shown, 'fileId' | 'hunkId'>[];
  /** Hunks Jev is sure can be skipped, and hunks it flags as contract changes; absent without Jev. */
  hunks?: { skip: readonly HunkRef[]; contract: readonly HunkRef[] };
}

/**
 * The trust boundary for a model-written walk. Beyond `readStops`: only the `CODED_STOPS` own
 * stops that matter most keep their code, a file or hunk that anything in the tour points at
 * never folds, and a flag sits only on a hunk the tour says nothing about. `covered` holds the
 * `fileId:hunkId` of every hunk something points at, when Jev scored the hunks.
 */
export function normalizeSection(
  raw: { intro?: unknown; points?: unknown; rest?: unknown; skim?: unknown },
  group: ResolvedGroup,
  files: readonly FileChange[],
  notes: GroupNotes,
  context: SectionContext,
): { section: Section; warnings: string[]; covered?: ReadonlySet<string> } {
  const { wideHere } = context;
  const members = files.filter((file) => group.fileIds.includes(file.id));
  const byKey = new Map(members.flatMap((file) => [[file.id, file] as const, [file.path, file] as const]));
  // The already written stops' lines and the code path's count as shown, so no stop repeats them.
  const shown: Shown[] = [...wideHere.flatMap((walk) => walk.snippets), ...context.pathHere];
  const { points, placed, warnings } = readStops(raw.points, group, byKey, notes, shown, wideHere, true);

  // A decision past the stops that keep their code stays as its claim with a link to the line; a step past them is dropped.
  const rank = (entry: SectionPoint) =>
    entry.kind === 'decision' ? DECISION_PRIORITIES.indexOf(entry.priority!) : DECISION_PRIORITIES.length;
  const coded = points.filter((entry) => entry.kind !== 'wide' && entry.snippets.length > 0);
  const keep = new Set(coded.toSorted((a, b) => rank(a) - rank(b)).slice(0, CODED_STOPS));
  for (const entry of coded) {
    if (keep.has(entry)) {
      continue;
    }
    const at = points.indexOf(entry);
    if (entry.kind === 'decision') {
      const { tree: _tree, ...claim } = entry;
      points[at] = {
        ...claim,
        see: { fileId: entry.snippets[0]!.fileId, line: entry.snippets[0]!.focus },
        snippets: [],
      };
    } else {
      points.splice(at, 1);
    }
  }
  // An already written stop the model did not place still leads the walk.
  points.unshift(
    ...wideHere
      .filter((walk) => !placed.has(walk.decision))
      .map((walk): SectionPoint => ({ kind: 'wide', wide: walk.decision, title: '', why: '', snippets: [] })),
  );

  // A file a stop, a note or the walkthrough points at is never skimmed.
  const pointed = new Set([
    ...points.flatMap((entry) => entry.snippets.map((snippet) => snippet.fileId)),
    ...wideHere.flatMap((walk) => walk.snippets.map((snippet) => snippet.fileId)),
    ...context.shownInTour.map((entry) => entry.fileId),
    ...[...notes.lineNotes, ...notes.fileNotes, ...notes.riskNotes, ...(notes.decisions ?? [])].map(
      (note) => note.fileId,
    ),
  ]);
  const skim = [
    ...new Set(
      (Array.isArray(raw.skim) ? raw.skim : [])
        .map((id) => byKey.get(String(id))?.id)
        .filter((id): id is string => !!id && !pointed.has(id)),
    ),
  ];

  let skimHunks: Section['skimHunks'];
  let hunkFlags: Section['hunkFlags'];
  let covered: Set<string> | undefined;
  if (context.hunks) {
    // A hunk anything points at is never folded: a note, a decision, a stop or a line the walkthrough shows.
    covered = new Set(context.shownInTour.map(hunkKey));
    const cover = (fileId: string | undefined, hunkId?: string, line?: number) => {
      const file = fileId === undefined ? undefined : byKey.get(fileId);
      const hunk =
        file?.hunks.find((candidate) => candidate.id === hunkId) ??
        file?.hunks.find(
          (candidate) =>
            line !== undefined &&
            ((candidate.newStart <= line && line < candidate.newStart + Math.max(candidate.newLines, 1)) ||
              (candidate.oldStart <= line && line < candidate.oldStart + Math.max(candidate.oldLines, 1))),
        );
      if (file && hunk) {
        covered!.add(`${file.id}:${hunk.id}`);
      }
    };
    notes.lineNotes.forEach((note) => cover(note.fileId, note.hunkId, note.line));
    (notes.decisions ?? []).forEach((decision) => cover(decision.fileId, decision.hunkId, decision.line));
    for (const entry of points) {
      entry.snippets.forEach((snippet) => cover(snippet.fileId, snippet.hunkId));
      cover(entry.see?.fileId, undefined, entry.see?.line);
    }
    // A fold or a flag is only for a hunk of this group that is open and that nothing points at; one hunk gets one of them.
    const seen = new Set<string>();
    const free = (ref: HunkRef) => {
      const file = byKey.get(ref.fileId);
      const hunk = file?.hunks.find((candidate) => candidate.id === ref.hunkId);
      const key = `${file?.id}:${hunk?.id}`;
      if (!file || !hunk || skim.includes(file.id) || covered!.has(key) || seen.has(key)) {
        return undefined;
      }
      seen.add(key);
      return { file, hunk };
    };
    skimHunks = context.hunks.skip.flatMap((ref) => {
      const at = free(ref);
      return at ? [{ fileId: at.file.id, hunkId: at.hunk.id }] : [];
    });
    hunkFlags = context.hunks.contract.flatMap((ref) => {
      const at = free(ref);
      const change = at && firstChange(at.hunk);
      return at && change ? [{ fileId: at.file.id, hunkId: at.hunk.id, ...change, flag: 'contract' as const }] : [];
    });
  }

  const intro = clip(typeof raw.intro === 'string' ? raw.intro : '', 240);
  const rest = clip(typeof raw.rest === 'string' ? raw.rest : '', 240);
  return {
    section: {
      ...(intro ? { intro } : {}),
      points,
      ...(rest ? { rest } : {}),
      skim,
      ...(skimHunks?.length ? { skimHunks } : {}),
      ...(hunkFlags?.length ? { hunkFlags } : {}),
    },
    warnings,
    ...(covered ? { covered } : {}),
  };
}

/**
 * The follow-up call's stops, read like any other and then held to what was asked: each on one
 * of the `offered` hunks, one snippet, no tree, and no more stops than hunks.
 */
export function normalizeKeyStops(
  raw: { points?: unknown },
  group: ResolvedGroup,
  files: readonly FileChange[],
  offered: readonly HunkRef[],
): SectionPoint[] {
  const members = files.filter((file) => group.fileIds.includes(file.id));
  const byKey = new Map(members.flatMap((file) => [[file.id, file] as const, [file.path, file] as const]));
  const only = new Set(offered.map(hunkKey));
  const none: GroupNotes = { fileNotes: [], lineNotes: [], riskNotes: [], decisions: [] };
  return readStops(raw.points, group, byKey, none, [], [], false)
    .points.filter((entry) => entry.snippets.length > 0 && entry.snippets.every((shown) => only.has(hunkKey(shown))))
    .slice(0, offered.length)
    .map(({ tree: _tree, ...entry }) => ({ ...entry, snippets: entry.snippets.slice(0, 1) }));
}

/** Everything that shapes a group's walk, for the finished tour's cache key. */
export const SECTIONS_KEY = hashOf({
  SECTIONS_VERSION,
  SECTION_SYSTEM,
  KEY_STOPS_SYSTEM,
  HUNK_QUESTIONS,
  HUNK_WIDE_QUESTIONS,
  HUNK_SKIP,
  HUNK_SURE,
  KEY_HUNKS,
}).slice(0, 12);
