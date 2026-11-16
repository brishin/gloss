import type { DiffPayload, FileChange, Tour } from '@gloss/protocol';
import { Effect, FiberSet } from 'effect';
import * as v from 'valibot';
import { ModelClient, type ModelError } from '../adapters/types.ts';
import { RepoClones } from '../sources/clone.ts';
import { readRepoFile, readTreeFile, repoPath, searchRepo } from '../sources/contents.ts';
import { codeSearcher, fileReader } from './read-file.ts';

/**
 * Experiment: what a reviewer learns by opening a clicked symbol's definition and usages, as one
 * short card. The model reads and searches the repository at the PR's head, then names lines; the
 * code shown is read from the repository, never taken from the model.
 */
export const SYMBOL_SYSTEM = `A reviewer reading a pull request clicked a symbol in the diff. They can read code. Tell them the one or two things they would otherwise have to leave the diff to find out, and nothing else.

## Look first

Use search_code and read_file before you answer. Every fact must come from code you read in this session.
- Find the definition, then every place that calls, passes, sets or reads the symbol.
- Go one hop past the obvious. For a flag, gate or boolean: find what makes it true, then check each entry point: does it ever supply that? For a parameter or a stored value: check what each caller passes, and whether that caller's path ever reads it. A value that is passed but never read on some path is the finding.
- For a helper: find the default or edge case that matters at the clicked line.

## The card

checked: fill this first. One entry for each place you read that calls, passes, sets or reads the symbol: where it is, and what it does with the symbol in a few words. For a flag or gate, and for a value that is only read behind one, list every entry point that reaches the clicked line (follow the callers of the enclosing function up to where requests come in) and set gate for each: "passes" when that path can make the gate true, "fails" when it never can, "none" for a place that is not an entry point. Read each entry point's call before you set it; do not assume. List at least three places when that many exist. If you cannot fill this, search and read more before going on. The lead comes from what differs between these entries.

lead: ONE sentence, 20 words at most. It is the finding, not a description. Do not say what kind of thing the symbol is, do not restate its body, and do not start with its name, "Resolves", "Returns", "Helper", or "This". A lead that starts with the symbol's name is an error: make the subject the thing that happens ("A blank title still gets a line"), not the symbol. When some entry points fail a gate, the lead names them, by the name a reader of this codebase would use ("Slack and mini sessions never get the tool, so their source is never read").
  Too long and descriptive: "Resolves the thread's source into a kind and name, but only if that item is attached. The name is cleaned. Otherwise it returns None."
  Right: "The attached Capture or Collection this Session started from; None for anything else."

rows: most cards have none. Use rows only when the finding itself is that places differ and the lead cannot carry it. Never use rows to list callers that the lead does not talk about, to restate checked, or to show places that all behave the same. label is two or three plain words that say what the values are ("callers pass", "gets the tool"), never one word such as "from". Each item is a value (code, or a few plain words) and where (the name a reader of this codebase would use for the place, such as "threads" or "Slack"; add path:line only when the name is not enough). Group places that pass the same thing into one item ("threads, Slack"), and keep the odd one out as its own item. Four items at most.

excerpt: the few lines that decide the behavior (the condition, the default, the branch), 8 lines at most. Never a signature, a docstring or imports. Only lines that this pull request's diff does not show. Give the path and line range and do not quote code. Leave the path empty when nothing outside the diff needs showing.

effect: ONE sentence, 20 words at most: what the finding means at the clicked line, when a reviewer would act on it or would not guess it. Empty otherwise.

definition: the path and line where the symbol is defined.

## Leave out

- Anything in "Notes the reviewer already has", even reworded. If your effect or lead repeats a note, drop it and say something else or nothing.
- Anything visible in the hunk shown to you.
- Praise, hedging, advice ("consider", "ensure"), and summaries of what you did.

A card that is only a lead is a good card. Plain words, present tense. Backticks around code names in lead and effect only. Before you submit, count the words in lead and effect and cut them to the limit.`;

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
  effect?: string;
  definition?: { path: string; line: number; inDiff: boolean };
}

export interface RunSymbolOptions {
  tour: Tour;
  diff: DiffPayload;
  fileId: string;
  /** New-side line the reviewer clicked. */
  line: number;
  symbol: string;
}

const EXCERPT_LINES = 8;
const ROW_ITEMS = 4;

/** Whether new-side `line` of `path` is shown in the diff. */
export function lineInDiff(diff: DiffPayload, path: string, line: number): boolean {
  const file = diff.files.find((candidate) => candidate.path === path);
  return !!file?.hunks.some((hunk) => line >= hunk.newStart && line < hunk.newStart + Math.max(hunk.newLines, 1));
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

export function buildSymbolPrompt({ tour, diff, fileId, line, symbol }: RunSymbolOptions): string {
  const file = diff.files.find((candidate) => candidate.id === fileId);
  const group = tour.groups.find((candidate) => candidate.fileIds.includes(fileId));
  const notes = Object.values(tour.notes).flatMap((groupNotes) => [
    ...groupNotes.fileNotes.map((note) => note.text),
    ...groupNotes.lineNotes.map((note) => note.text),
    ...(groupNotes.decisions ?? []).map((note) => note.text),
  ]);
  return [
    `# ${diff.meta.title}`,
    tour.overallSummary,
    `## Changed files\n${diff.files.map((candidate) => `${candidate.status} ${candidate.path}`).join('\n')}`,
    `## Notes the reviewer already has\n${notes.map((note) => `- ${note}`).join('\n') || '(none)'}`,
    `## The click\nSymbol: \`${symbol}\`\nFile: ${file?.path ?? fileId}\nLine: ${line}${group ? `\nGroup: ${group.label}` : ''}`,
    file ? `## The hunk around it (new line numbers)\n${numberedHunk(file, line)}` : '',
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
): Promise<SymbolCard> {
  const card: SymbolCard = { symbol, lead: firstSentence(draft.lead) };
  const items = draft.rows.items
    .map((item) => ({ value: item.value.trim(), where: item.where.trim(), code: item.code }))
    .filter((item) => item.value && item.where)
    .slice(0, ROW_ITEMS);
  if (draft.rows.label.trim() && items.length > 1) {
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

/** One card for one clicked symbol, with what the model read on the way. */
export function runSymbol(
  options: RunSymbolOptions,
): Effect.Effect<
  { card: SymbolCard; checked: SymbolCardDraft['checked']; reads: string[]; model: string },
  ModelError,
  ModelClient | RepoClones
> {
  const { diff } = options;
  return Effect.scoped(
    Effect.gen(function* () {
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
      const response = yield* model.prompt({
        tier: 'notes',
        system: SYMBOL_SYSTEM,
        prompt: buildSymbolPrompt(options),
        result: SymbolCardSchema,
        resultName: 'symbol',
        tools: [reader.tool, searcher.tool],
      });
      const card = yield* Effect.promise(() =>
        normalizeSymbolCard(response.data, options.symbol, diff, (path) => read(path).catch(() => undefined)),
      );
      return {
        card,
        checked: response.data.checked,
        reads: [...searcher.reads(), ...reader.reads()],
        model: response.model,
      };
    }),
  );
}
