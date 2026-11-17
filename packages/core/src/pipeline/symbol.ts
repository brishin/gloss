import type { DiffPayload, FileChange, Tour } from '@gloss/protocol';
import { Effect, FiberSet } from 'effect';
import * as v from 'valibot';
import { type ChatTool, ModelClient, type ModelError, type ModelTier, type ModelUsage } from '../adapters/types.ts';
import { RepoClones } from '../sources/clone.ts';
import { findSymbolLines, readRepoFile, readTreeFile, repoPath, searchRepo } from '../sources/contents.ts';
import { blocksAround, namedAt, type UseKind } from '../sources/symbol-uses.ts';
import { codeSearcher, fileReader } from './read-file.ts';

/**
 * Experiment: what a reviewer learns by opening a clicked symbol's definition and usages, as one
 * short card. The model reads and searches the repository at the PR's head, then names lines; the
 * code shown is read from the repository, never taken from the model.
 */
export const SYMBOL_SYSTEM = `A reviewer reading a pull request clicked a symbol in the diff. They can read code. Tell them the one or two things they would otherwise have to leave the diff to find out, and nothing else.

## Look first

Use search_code and read_file before you answer. Every fact must come from code you read in this session.
- Find the definition, then every place that calls, passes, sets or reads the symbol. When the prompt has "Every line that names the symbol", that list is complete: start from it instead of searching for the name. The list saves searching, not reading: it shows where the name appears, not what makes a gate true or what a caller's path reads. Still read the definition and go the one hop.
- Go one hop past the obvious. For a flag, gate or boolean: find what makes it true, then check each entry point: does it ever supply that? For a parameter or a stored value: check what each caller passes, and whether that caller's path ever reads it. A value that is passed but never read on some path is the finding.
- For a helper: find the default or edge case that matters at the clicked line. Stay on the helper; do not report on the feature around it.
- search_code shows at most 5 matches per file, so a missing match proves nothing. Before you say something has no caller, is never read or never runs, read the file where it would be used and find the lines. If you did not, do not make the claim.
- The card is about the clicked symbol at the clicked line. A finding about some other symbol belongs on that symbol's card, not this one.

## The card

checked: fill this first. One entry for each place you read that calls, passes, sets or reads the symbol: where it is, and what it does with the symbol in a few words. Only when the clicked symbol is itself a flag or gate, or a value that is read only behind one: list every entry point that reaches the clicked line (follow the callers of the enclosing function up to where requests come in) and set gate for each: "passes" when that path can make the gate true, "fails" when it never can, "none" for a place that is not an entry point, and for every place when the clicked symbol has nothing to do with a gate. Read each entry point's call before you set it; do not assume. List at least three places when that many exist. If you cannot fill this, search and read more before going on. The lead comes from what differs between these entries.

lead: ONE sentence, 20 words at most. It is the finding, not a description. Do not say what kind of thing the symbol is, do not restate its body, and do not start with its name, "Resolves", "Returns", "Helper", or "This". A lead that starts with the symbol's name is an error: make the subject the thing that happens ("A blank title still gets a line"), not the symbol. When some entry points fail a gate, the lead names them, by the name a reader of this codebase would use ("Slack and mini sessions never get the tool, so their source is never read").
  Too long and descriptive: "Resolves the thread's source into a kind and name, but only if that item is attached. The name is cleaned. Otherwise it returns None."
  Right: "The attached Capture or Collection this Session started from; None for anything else."

rows: most cards have none. Use rows only when the finding itself is that places differ and the lead cannot carry it. Never use rows to list callers that the lead does not talk about, to restate checked, or to show places that all behave the same. label is two or three plain words that say what the values are ("callers pass", "gets the tool"), never one word such as "from". Each item is a value (code, or a few plain words) and where (the name a reader of this codebase would use for the place, such as "threads" or "Slack"; add path:line only when the name is not enough). Group places that pass the same thing into one item ("threads, Slack"), and keep the odd one out as its own item. Four items at most.

excerpt: the few lines that decide the behavior (the condition, the default, the branch), 8 lines at most. Never a signature, a docstring or imports. Only lines that this pull request's diff does not show. Give the path and line range and do not quote code. Leave the path empty when nothing outside the diff needs showing.

uses: the prompt may list every line at the head that names the symbol, numbered. The reader is shown a count made from that list ("7 uses in 4 files"), so never write a count yourself.
  The list holds only lines whose syntax uses the name (each is marked call, pass, set or read); imports, definitions, comments and strings are already gone.
  skip: the numbers of the lines that use some other thing with the same name: a local variable, a method of another class, a field of another type. A use in a test, or one that does the same as the others, is still a use: never skip it. Skip only what you are sure is another thing; read a line's file when you cannot tell from the line.
  summary: one line, 14 words at most, that tells the uses apart by what they do ("threads and Slack pass the thread's source; admin passes None"). Name places the way a reader of this codebase would, never by line number or by position in the list. Empty when there is at most one use, when the uses all do the same thing the clicked line does, or when the lead already says it. When summary says how places differ, leave rows empty.

effect: ONE sentence, 20 words at most: what the finding means at the clicked line, when a reviewer would act on it or would not guess it. Empty otherwise.

definition: the path and line where the symbol is defined.

## Leave out

- Anything in "Notes the reviewer already has", even reworded. If your effect or lead repeats a note, drop it and say something else or nothing.
- Anything visible in the hunk shown to you.
- Praise, hedging, advice ("consider", "ensure"), and summaries of what you did.

A card that is only a lead is a good card. Plain words, present tense. Backticks around code names in lead and effect only. Before you submit, count the words in lead and effect and cut them to the limit.`;

/** Added to the system prompt when the lead streams: text is the only output that reaches the reader before submit. */
export const SYMBOL_LEAD_FIRST = `

## Say the lead first

The reader sees your text as you write it. When you have finished reading and know the finding, write one line of plain text: "LEAD: " and then the lead sentence, word for word as you will submit it. Then call submit, with that same lead. Write no other text: nothing before a tool call, nothing between tool calls, nothing after the lead.`;

/** The lead in the text streamed so far: what follows the last "LEAD:", up to the end of its line. */
export function streamedLead(text: string): string | undefined {
  const at = text.lastIndexOf('LEAD:');
  return at === -1
    ? undefined
    : text
        .slice(at + 5)
        .split('\n')[0]!
        .trim();
}

export const SymbolCardSchema = v.object({
  checked: v.array(
    v.object({
      place: v.pipe(v.string(), v.description('path:line, or the entry point by name with its path:line.')),
      does: v.pipe(v.string(), v.description('What this place does with the symbol, a few words.')),
      gate: v.pipe(
        v.picklist(['passes', 'fails', 'none']),
        v.description('For an entry point: whether the gate at the clicked line can be true on this path.'),
      ),
    }),
  ),
  lead: v.pipe(v.string(), v.description('One sentence, 20 words at most. Never starts with the symbol name.')),
  rows: v.object({
    label: v.pipe(v.string(), v.description('Two or three plain words; empty when there are no items.')),
    items: v.array(
      v.object({
        value: v.pipe(v.string(), v.description('Code, or a few plain words.')),
        where: v.pipe(v.string(), v.description('A named place, or path:line.')),
        code: v.pipe(v.boolean(), v.description('True when value is code.')),
      }),
    ),
  }),
  excerpt: v.object({
    path: v.pipe(v.string(), v.description('Repository path; empty for no excerpt.')),
    from: v.number(),
    to: v.number(),
  }),
  uses: v.object({
    skip: v.pipe(v.array(v.number()), v.description('Numbers of the listed lines that are not a use of the symbol.')),
    summary: v.pipe(v.string(), v.description('One line, 14 words at most, or empty.')),
  }),
  effect: v.pipe(v.string(), v.description('One sentence, 20 words at most, or empty.')),
  definition: v.object({ path: v.string(), line: v.number() }),
});
export type SymbolCardDraft = v.InferOutput<typeof SymbolCardSchema>;

export interface SymbolCard {
  symbol: string;
  lead: string;
  rows?: { label: string; items: { value: string; where: string; code: boolean }[] };
  /** Lines read from the repository at the head. */
  excerpt?: { path: string; from: number; lines: string[] };
  /** Counted from grep at the head, less the lines the model says are not uses; the summary is the model's. */
  uses?: {
    count: number;
    files: number;
    tests: number;
    added: number;
    /** How many of the uses call it; the rest pass, set or read it. */
    calls: number;
    /** Whether every counted line is the clicked symbol for certain; otherwise other things of the same name may be counted. */
    exact: boolean;
    /** Lines whose syntax uses the name that the model said are some other thing. */
    skipped: number;
    summary?: string;
    lines: SymbolLine[];
  };
  effect?: string;
  definition?: { path: string; line: number; inDiff: boolean };
}

/** One line at the head that names the symbol. */
export interface SymbolLine {
  path: string;
  line: number;
  text: string;
  /** What the line does with the symbol, from the file's syntax tree; absent when the file has no grammar. */
  kind?: UseKind;
}

export interface RunSymbolOptions {
  tour: Tour;
  diff: DiffPayload;
  fileId: string;
  /** New-side line the reviewer clicked. */
  line: number;
  symbol: string;
  /** Every line that names the symbol, from grep; absent when there are too many to list or no clone. */
  lines?: readonly SymbolLine[];
  /** Every listed line is a use of the clicked symbol for certain. */
  exact?: boolean;
  /** Code read ahead of the model: the definition and the code around the uses, numbered. */
  code?: string;
  /** Experiment: the model tier that writes the card (default `notes`). */
  tier?: ModelTier;
  /** Experiment: read the definition and the code around the uses into the prompt. */
  preload?: boolean;
  /** Experiment: a short prompt (no summary, file list or notes, the first uses only) with tools that fetch the rest. */
  lean?: boolean;
  /** Experiment: the model writes the lead as plain text before it submits, and it is handed on as it streams. */
  onLead?: (lead: string) => void;
}

/** More lines than this name the symbol: too common a name to list or count. */
export const SYMBOL_LINES = 200;
const EXCERPT_LINES = 8;
const ROW_ITEMS = 4;

/** Whether new-side `line` of `path` is shown in the diff. */
export function lineInDiff(diff: DiffPayload, path: string, line: number): boolean {
  const file = diff.files.find((candidate) => candidate.path === path);
  return !!file?.hunks.some((hunk) => line >= hunk.newStart && line < hunk.newStart + Math.max(hunk.newLines, 1));
}

/** Whether this pull request adds new-side `line` of `path`. */
export function lineAdded(diff: DiffPayload, path: string, line: number): boolean {
  for (const hunk of diff.files.find((candidate) => candidate.path === path)?.hunks ?? []) {
    let at = hunk.newStart;
    for (const row of hunk.patch.split('\n')) {
      if (row.startsWith('-') || row.startsWith('\\')) {
        continue;
      }
      if (at === line && row.startsWith('+')) {
        return true;
      }
      at += 1;
    }
  }
  return false;
}

const TEST_PATH = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;

/** `path:line:text` rows of grep output as lines; rows that do not parse are dropped. */
export function parseSymbolLines(rows: readonly string[]): SymbolLine[] {
  return rows.flatMap((row) => {
    const match = /^(.+?):(\d+):(.*)$/.exec(row);
    return match ? [{ path: match[1]!, line: Number(match[2]), text: match[3]!.trim().slice(0, 160) }] : [];
  });
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a line that names `symbol` can be a use of it: not an import, a comment, or the line
 * that defines it. What only the code around the line tells (a namesake, a parameter) is the model's to skip.
 */
export function mayUse(text: string, symbol: string): boolean {
  const defines = new RegExp(
    `^(export\\s+)?(default\\s+)?(async\\s+)?(function\\*?|class|const|let|var|def|type|interface|enum)\\s+${escaped(symbol)}\\b`,
  );
  return !(
    /^(import\b|from\s+\S+\s+import\b|export\s.*\sfrom\s|#|\/\/|\/\*|\*)/.test(text) ||
    /\bimport\s*\(/.test(text) ||
    defines.test(text)
  );
}

const PROSE = /\.(md|mdx|txt|rst|json|ya?ml|toml|lock|snap|html?|csv|svg)$/i;
/** Files parsed for one symbol; lines in files past this fall back to the line's text. */
const PARSED_FILES = 150;

/**
 * The lines that use the symbol, out of every line that names it: each file is parsed, so imports,
 * definitions, comments and strings are dropped by syntax. A name defined inside a function of the
 * clicked file, or at the top of a module that does not export it, is counted only where it can be
 * seen; any other bare name is counted only in files that import or define it, and then the count
 * is `exact`. A name clicked as a member (`router.invalidate`) or as a parameter is counted wherever
 * a member or a named argument has that name: syntax cannot tell whose it is.
 */
export async function symbolUses(
  named: readonly SymbolLine[],
  symbol: string,
  clicked: { path: string; line: number },
  read: (path: string) => Promise<string | undefined>,
): Promise<{ lines: SymbolLine[]; exact: boolean; definitions: SymbolLine[] }> {
  const paths = [...new Set([clicked.path, ...named.map((use) => use.path)])];
  const trees = new Map(
    await Promise.all(
      paths.slice(0, PARSED_FILES).map(async (path) => {
        const source = await read(path);
        const lines = named.filter((use) => use.path === path).map((use) => use.line);
        return [
          path,
          source === undefined ? undefined : await namedAt(path, source, symbol, [...lines, clicked.line]),
        ] as const;
      }),
    ),
  );
  const here = trees.get(clicked.path);
  const at = here?.get(clicked.line);
  const defined = here ? [...here.values()].filter((entry) => entry.kind === 'define') : [];
  const local = defined.find(
    (entry) => entry.within && clicked.line >= entry.within.from && clicked.line <= entry.within.to,
  )?.within;
  const fileOnly = !!local || defined.some((entry) => entry.unexported);
  const bare = !!at && at.kind !== 'text' && !at.member && !at.parameter;
  // Files where the bare name is the clicked symbol: they import it, or define it at their top.
  const owns = new Set(
    [...trees].flatMap(([path, entries]) =>
      entries &&
      [...entries.values()].some(
        (entry) => entry.kind === 'import' || (entry.kind === 'define' && !entry.within && !entry.parameter),
      )
        ? [path]
        : [],
    ),
  );
  const lines = named.flatMap((use) => {
    const entry = trees.get(use.path)?.get(use.line);
    if (!entry) {
      // No grammar for the file: prose and data are not code, the rest is judged by the line's text.
      return !PROSE.test(use.path) && mayUse(use.text, symbol) ? [use] : [];
    }
    if (entry.kind === 'define' || entry.kind === 'import' || entry.kind === 'text') {
      return [];
    }
    if (bare && fileOnly && (use.path !== clicked.path || (local && (use.line < local.from || use.line > local.to)))) {
      return [];
    }
    if (at?.member && !entry.member) {
      return [];
    }
    // A parameter is used from outside by the callers that pass it by name.
    if (at?.parameter && entry.kind !== 'pass') {
      return [];
    }
    if (bare && !fileOnly && !entry.member && !owns.has(use.path) && use.path !== clicked.path) {
      return [];
    }
    return [{ ...use, kind: entry.kind }];
  });
  // Where the symbol is defined: a definition that is not a parameter, in a file that owns the name first.
  const definitions = named
    .filter((use) => {
      const entry = trees.get(use.path)?.get(use.line);
      return entry?.kind === 'define' && !entry.parameter;
    })
    .sort((a, b) => Number(b.path === clicked.path) - Number(a.path === clicked.path));
  return { lines, exact: bare, definitions: bare || at?.parameter ? definitions : definitions.slice(0, 3) };
}

/** The hunk that shows new-side `line`, with new-side line numbers. */
function numberedHunk(file: FileChange, line: number): string {
  const hunk = file.hunks.find(
    (candidate) => line >= candidate.newStart && line < candidate.newStart + Math.max(candidate.newLines, 1),
  );
  if (!hunk) {
    return '';
  }
  let at = hunk.newStart;
  return hunk.patch
    .split('\n')
    .map((row) => (row.startsWith('-') ? `      ${row}` : `${String(at++).padStart(5)} ${row}`))
    .join('\n');
}

/** Uses the lean prompt shows; `list_uses` hands over the rest. */
export const LEAN_LINES = 8;

function tourNotes(tour: Tour): string[] {
  return Object.values(tour.notes).flatMap((groupNotes) => [
    ...groupNotes.fileNotes.map((note) => note.text),
    ...groupNotes.lineNotes.map((note) => note.text),
    ...(groupNotes.decisions ?? []).map((note) => note.text),
  ]);
}

const useLine = (use: SymbolLine, index: number) =>
  `[${index}] ${use.kind ? `${use.kind} ` : ''}${use.path}:${use.line}: ${use.text}`;

/** The tools that give back what the lean prompt leaves out. */
export function leanTools(
  { tour, diff }: Pick<RunSymbolOptions, 'tour' | 'diff'>,
  lines: readonly SymbolLine[],
): ChatTool[] {
  return [
    {
      name: 'tour_context',
      description:
        "The pull request's summary, its changed files, and every note the reviewer already has. Call it once before you write the card, so the card repeats none of the notes.",
      input: v.object({}),
      run: async () =>
        [
          tour.overallSummary,
          `## Changed files\n${diff.files.map((file) => `${file.status} ${file.path}`).join('\n')}`,
          `## Notes the reviewer already has\n${
            tourNotes(tour)
              .map((note) => `- ${note}`)
              .join('\n') || '(none)'
          }`,
        ].join('\n\n'),
    },
    {
      name: 'list_uses',
      description: 'Every line that names the symbol, numbered: the prompt shows only the first few.',
      input: v.object({}),
      run: async () => lines.map(useLine).join('\n') || '(none)',
    },
  ];
}

export function buildSymbolPrompt({
  tour,
  diff,
  fileId,
  line,
  symbol,
  lines,
  exact,
  code,
  lean,
}: RunSymbolOptions): string {
  const file = diff.files.find((candidate) => candidate.id === fileId);
  const group = tour.groups.find((candidate) => candidate.fileIds.includes(fileId));
  const notes = tourNotes(tour);
  const shown = lean ? (lines ?? []).slice(0, LEAN_LINES) : (lines ?? []);
  const more = (lines?.length ?? 0) - shown.length;
  return [
    `# ${diff.meta.title}`,
    lean
      ? `The summary, the changed files and the ${notes.length} notes the reviewer already has are not shown here: tour_context returns them.`
      : tour.overallSummary,
    lean
      ? ''
      : `## Changed files\n${diff.files.map((candidate) => `${candidate.status} ${candidate.path}`).join('\n')}`,
    lean ? '' : `## Notes the reviewer already has\n${notes.map((note) => `- ${note}`).join('\n') || '(none)'}`,
    `## The click\nSymbol: \`${symbol}\`\nFile: ${file?.path ?? fileId}\nLine: ${line}${group ? `\nGroup: ${group.label}` : ''}`,
    file ? `## The hunk around it (new line numbers)\n${numberedHunk(file, line)}` : '',
    lines?.length
      ? `## ${more > 0 ? `The first ${shown.length} of ${lines.length} lines that name the symbol (list_uses returns all of them` : 'Every line that names the symbol (complete, numbered'}${exact ? '; all of them are the clicked symbol, so skip is empty' : ''})\n${shown.map(useLine).join('\n')}`
      : '',
    code
      ? `## Code already read for you (at the head, numbered)\nThe definition and the code around the uses: these replace your first reads only. They show where the symbol is defined and used, not what makes a gate true, which entry points reach the clicked line, or what a caller's own callers pass. Still go the one hop with read_file and search_code before you answer, and do not read the lines below again.\n\n${code}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The first sentence of `text`: a full stop, then a space and a capital or backtick, ends it. */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/[.!?](?=\s+[A-Z`])/);
  return end === -1 ? trimmed : trimmed.slice(0, end + 1);
}

/** Model output is untrusted: clamp the card, and read the excerpt's lines from the repository. */
export async function normalizeSymbolCard(
  draft: SymbolCardDraft,
  symbol: string,
  diff: DiffPayload,
  read: (path: string) => Promise<string | undefined>,
  lines: readonly SymbolLine[] = [],
  /** The lines are the symbol's uses for certain, so the model's skips do not count. */
  exact = false,
): Promise<SymbolCard> {
  const card: SymbolCard = { symbol, lead: firstSentence(draft.lead) };
  const skip = new Set(exact ? [] : draft.uses.skip);
  const uses = lines.filter((_, index) => !skip.has(index));
  if (uses.length > 0) {
    const summary = firstSentence(draft.uses.summary);
    card.uses = {
      count: uses.length,
      files: new Set(uses.map((use) => use.path)).size,
      tests: uses.filter((use) => TEST_PATH.test(use.path)).length,
      added: uses.filter((use) => lineAdded(diff, use.path, use.line)).length,
      calls: uses.filter((use) => use.kind === 'call').length,
      exact,
      skipped: lines.length - uses.length,
      ...(summary && uses.length > 1 ? { summary } : {}),
      lines: uses,
    };
  }
  const items = draft.rows.items
    .map((item) => ({ value: item.value.trim(), where: item.where.trim(), code: item.code }))
    .filter((item) => item.value && item.where)
    .slice(0, ROW_ITEMS);
  // The uses line already tells the places apart: rows would say it twice.
  if (draft.rows.label.trim() && items.length > 1 && !card.uses?.summary) {
    card.rows = { label: draft.rows.label.trim(), items };
  }
  const path = repoPath(draft.excerpt.path.trim());
  if (path) {
    const text = await read(path);
    const lines = text?.replace(/\n$/, '').split('\n');
    const from = Math.floor(draft.excerpt.from);
    const to = Math.min(Math.floor(draft.excerpt.to), from + EXCERPT_LINES - 1);
    // Code the diff already shows is pointed to, not repeated.
    const shown = Array.from({ length: Math.max(to - from + 1, 0) }, (_, index) => from + index).every((line) =>
      lineInDiff(diff, path, line),
    );
    if (lines && from >= 1 && to >= from && to <= lines.length && !shown) {
      card.excerpt = { path, from, lines: lines.slice(from - 1, to) };
    }
  }
  if (draft.effect.trim()) {
    card.effect = firstSentence(draft.effect);
  }
  const definedAt = repoPath(draft.definition.path.trim());
  if (definedAt && draft.definition.line >= 1) {
    const text = await read(definedAt);
    if (text && draft.definition.line <= text.split('\n').length) {
      card.definition = {
        path: definedAt,
        line: Math.floor(draft.definition.line),
        inDiff: lineInDiff(diff, definedAt, Math.floor(draft.definition.line)),
      };
    }
  }
  return card;
}

/** Characters of code read ahead for one card, and lines of one block. */
const PRELOAD_CHARS = 14_000;
const PRELOAD_BLOCK = 60;
const PRELOAD_AROUND = 12;
const PRELOAD_USES = 10;

/**
 * The code a reader would open first, as numbered excerpts: the symbol's definition, then the
 * function around the clicked line and around each use (uses outside tests first, one per
 * function). A long function is cut to the lines around the use.
 */
export async function symbolCode(
  definitions: readonly SymbolLine[],
  uses: readonly SymbolLine[],
  clicked: { path: string; line: number },
  read: (path: string) => Promise<string | undefined>,
): Promise<string> {
  const ordered = [
    ...definitions.slice(0, 2).map((at) => ({ ...at, whole: true })),
    { ...clicked, whole: false },
    ...[...uses]
      .sort((a, b) => Number(TEST_PATH.test(a.path)) - Number(TEST_PATH.test(b.path)))
      .map((at) => ({ path: at.path, line: at.line, whole: false })),
  ];
  const sources = new Map<string, string[] | undefined>();
  const taken = new Map<string, { from: number; to: number }[]>();
  const out: string[] = [];
  let size = 0;
  let count = 0;
  for (const at of ordered) {
    if (count >= PRELOAD_USES + 3 || size >= PRELOAD_CHARS) {
      break;
    }
    if (!sources.has(at.path)) {
      sources.set(at.path, (await read(at.path))?.replace(/\n$/, '').split('\n'));
    }
    const rows = sources.get(at.path);
    if (!rows || at.line > rows.length) {
      continue;
    }
    const block = (await blocksAround(at.path, rows.join('\n'), [at.line]).catch(() => undefined))?.get(at.line) ?? {
      from: at.line,
      to: at.line,
    };
    const limit = at.whole ? PRELOAD_BLOCK : PRELOAD_AROUND * 2 + 1;
    let from = block.from === block.to ? Math.max(1, at.line - 3) : block.from;
    let to = block.from === block.to ? Math.min(rows.length, at.line + 3) : block.to;
    if (to - from + 1 > limit) {
      from = at.whole ? from : Math.max(from, at.line - PRELOAD_AROUND);
      to = Math.min(to, from + limit - 1);
    }
    const seen = taken.get(at.path) ?? [];
    if (seen.some((range) => from >= range.from && to <= range.to)) {
      continue;
    }
    seen.push({ from, to });
    taken.set(at.path, seen);
    const text = `### ${at.path}:${from}-${to}\n${rows
      .slice(from - 1, to)
      .map((row, index) => `${String(from + index).padStart(5)} ${row}`)
      .join('\n')}`;
    size += text.length;
    out.push(text);
    count += 1;
  }
  return out.join('\n\n');
}

/** One card for one clicked symbol, with what the model read on the way. */
export function runSymbol(options: RunSymbolOptions): Effect.Effect<
  {
    card: SymbolCard;
    checked: SymbolCardDraft['checked'];
    reads: string[];
    model: string;
    timing: {
      prepare: number;
      model: number;
      first?: number;
      /** Streamed lead: its first and last characters, and what was streamed. */
      leadFirst?: number;
      leadLast?: number;
      lead?: string;
      steps: { tool: string; at: number }[];
      usage?: ModelUsage;
      preloaded: number;
    };
  },
  ModelError,
  ModelClient | RepoClones
> {
  const { diff } = options;
  return Effect.scoped(
    Effect.gen(function* () {
      const begun = Date.now();
      const model = yield* ModelClient;
      const tree = yield* (yield* RepoClones).tree(diff);
      const runPromise = yield* FiberSet.makeRuntimePromise<never>();
      const read = (path: string) =>
        runPromise(
          Effect.tryPromise(async (signal) =>
            tree?.rev
              ? ((await readTreeFile(tree, path, signal)) ?? (await readRepoFile(diff, path, signal)))
              : readRepoFile(diff, path, signal),
          ),
        );
      const reader = fileReader(diff, read);
      const searcher = codeSearcher(diff, (text, path) =>
        runPromise(Effect.tryPromise((signal) => searchRepo(diff, tree, text, path, signal))),
      );
      const found = yield* Effect.promise(() =>
        runPromise(
          Effect.tryPromise((signal) => findSymbolLines(tree, options.symbol, SYMBOL_LINES * 4, signal)),
        ).catch(() => []),
      );
      const clickedPath = diff.files.find((candidate) => candidate.id === options.fileId)?.path;
      const named = yield* Effect.promise(() =>
        clickedPath
          ? symbolUses(parseSymbolLines(found), options.symbol, { path: clickedPath, line: options.line }, (path) =>
              read(path).catch(() => undefined),
            ).catch(() => ({ lines: [], exact: false, definitions: [] }))
          : Promise.resolve({ lines: [], exact: false, definitions: [] }),
      );
      // Past the cap the model is not shown the list: an exact count still stands, a loose one does not.
      const lines = named.lines.length > SYMBOL_LINES && !named.exact ? [] : named.lines;
      const listed = lines.length > SYMBOL_LINES ? [] : lines;
      const code =
        options.preload && clickedPath
          ? yield* Effect.promise(() =>
              symbolCode(named.definitions, listed, { path: clickedPath, line: options.line }, (path) =>
                read(path).catch(() => undefined),
              ).catch(() => ''),
            )
          : '';
      // When each tool call started, and when the model first wrote, in ms from the start of the call.
      const started = Date.now();
      const steps: { tool: string; at: number }[] = [];
      let first: number | undefined;
      let text = '';
      let lead: { first: number; last: number; text: string } | undefined;
      const timed = (tool: (typeof reader)['tool']) => ({
        ...tool,
        run: (input: unknown) => {
          steps.push({ tool: tool.name, at: Date.now() - started });
          return tool.run(input);
        },
      });
      const response = yield* model.prompt({
        tier: options.tier ?? 'notes',
        system: options.onLead ? SYMBOL_SYSTEM + SYMBOL_LEAD_FIRST : SYMBOL_SYSTEM,
        prompt: buildSymbolPrompt({ ...options, lines: listed, exact: named.exact, code }),
        result: SymbolCardSchema,
        resultName: 'symbol',
        tools: [reader.tool, searcher.tool, ...(options.lean ? leanTools(options, listed) : [])].map(timed),
        onDelta: (delta) => {
          const at = Date.now() - started;
          first ??= at;
          if (!options.onLead || delta.kind !== 'text') {
            return;
          }
          text += delta.text;
          const said = streamedLead(text);
          if (said && said !== lead?.text) {
            lead = { first: lead?.first ?? at, last: at, text: said };
            options.onLead(said);
          }
        },
      });
      const timing = {
        prepare: started - begun,
        model: Date.now() - started,
        first,
        ...(lead ? { leadFirst: lead.first, leadLast: lead.last, lead: lead.text } : {}),
        steps,
        usage: response.usage,
        preloaded: code.length,
      };
      const card = yield* Effect.promise(() =>
        normalizeSymbolCard(
          response.data,
          options.symbol,
          diff,
          (path) => read(path).catch(() => undefined),
          lines,
          named.exact,
        ),
      );
      return {
        card,
        checked: response.data.checked,
        reads: [...searcher.reads(), ...reader.reads()],
        model: response.model,
        timing,
      };
    }),
  );
}
