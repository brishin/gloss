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
export const SYMBOL_SYSTEM = `A reviewer reading a pull request clicked a symbol in the diff. Tell them what they would have learned by opening its definition and its usages in an editor, and nothing else.

Use search_code and read_file first: find the definition, who calls or reads the symbol, where its value comes from, and where it goes. Read the code before you claim anything about it. Follow one more hop when the answer is there (a flag behind a flag, the caller of a pass-through function).

Then submit one card.

lead: one or two sentences, 24 words at most. Say only what the symbol's name and the clicked line do not already say. Start with the fact, never with "This function" or the symbol's name.

rows: use them only when several places pass, set or read the symbol and they differ. label is two or three plain words that say what the values are ("callers pass", "gets the tool"); never a single word such as "from" or "to". Each item is a value (code, or a few plain words) and where it comes from (a place a reader of this codebase would name, or path:line). Merge items that say the same thing and keep the odd one out. Four items at most.

excerpt: the one range of lines that settles the question, 8 lines at most, and only when those lines are not part of this pull request's diff. Give the path and line range; do not quote code. Leave the path empty when the code is already in the diff or nothing needs showing.

effect: one sentence, 20 words at most, on what this means at the clicked line, and only when it is something a reviewer would act on or would not guess. Leave it empty otherwise.

definition: the path and line where the symbol is defined.

Rules:
- Leave out anything the tour's notes already say, and anything the reviewer can see in the diff. A card may be only a lead.
- Plain words, short sentences, present tense. No praise, no hedging, no advice to "consider" or "ensure".
- Put code names in backticks only inside lead and effect.
- Every fact must come from code you read in this session.`;

export const SymbolCardSchema = v.object({
  lead: v.pipe(v.string(), v.description('One or two sentences, 24 words at most.')),
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

/** Model output is untrusted: clamp the card, and read the excerpt's lines from the repository. */
export async function normalizeSymbolCard(
  draft: SymbolCardDraft,
  symbol: string,
  diff: DiffPayload,
  read: (path: string) => Promise<string | undefined>,
): Promise<SymbolCard> {
  const card: SymbolCard = { symbol, lead: draft.lead.trim() };
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
    card.effect = draft.effect.trim();
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
): Effect.Effect<{ card: SymbolCard; reads: string[]; model: string }, ModelError, ModelClient | RepoClones> {
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
      return { card, reads: [...searcher.reads(), ...reader.reads()], model: response.model };
    }),
  );
}
