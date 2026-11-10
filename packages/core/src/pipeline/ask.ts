import type { AskContext, AskEvent, AskRef, AskTurn, DiffPayload, FileChange, Tour } from '@gloss/protocol';
import { parseAskRef } from '@gloss/protocol';
import { Effect, FiberSet, Queue, Stream } from 'effect';
import * as v from 'valibot';
import { type ChatTool, ModelClient } from '../adapters/types.ts';
import { RepoClones, type SearchTree } from '../sources/clone.ts';
import { readRepoFile, readTreeFile, repoPath, searchRepo } from '../sources/contents.ts';
import { Repos } from '../sources/repos.ts';
import { ASK_SYSTEM, buildAskPrompt } from './prompts.ts';
import { codeSearcher, fileReader } from './read-file.ts';

/** The most characters of a whole file `read_file` hands the model. */
const READ_BUDGET = 40_000;

export interface RunAskOptions {
  tour: Tour;
  diff: DiffPayload;
  question: string;
  context?: AskContext;
  history?: readonly AskTurn[];
  /** One of `ModelClient.config().ask.models`; the config's default when it names none. */
  model?: string;
}

/** What a question is about, in words for the prompt: lines of a file, a file, or a group. */
export function describeContext(context: AskContext | undefined, tour: Tour, diff: DiffPayload): string | undefined {
  if (!context) {
    return undefined;
  }
  const file = context.fileId ? diff.files.find((candidate) => candidate.id === context.fileId) : undefined;
  if (file) {
    const removed = context.side === 'deletions' ? ' (removed lines)' : '';
    if (context.from !== undefined) {
      const lines =
        context.to !== undefined && context.to !== context.from ? `${context.from}-${context.to}` : `${context.from}`;
      return `${file.id} ${file.path} line${lines.includes('-') ? 's' : ''} ${lines}${removed}`;
    }
    return `${file.id} ${file.path}`;
  }
  const group = tour.groups.find((candidate) => candidate.key === context.groupKey);
  return group ? `the group "${group.label}"` : undefined;
}

/** Whether `line` is shown on `side` of one of the file's hunks. */
function inHunks(file: FileChange, side: AskRef['side'], line: number): boolean {
  return file.hunks.some((hunk) =>
    side === 'additions'
      ? line >= hunk.newStart && line < hunk.newStart + Math.max(hunk.newLines, 1)
      : line >= hunk.oldStart && line < hunk.oldStart + Math.max(hunk.oldLines, 1),
  );
}

/**
 * The whole text of an added file's new side or a removed file's old side, from its diff:
 * `Repos.contents` only reads files that exist on both sides (it fills in unchanged lines), and
 * every line of an added or removed file is in its diff.
 */
export function wholeSideText(file: FileChange, side: 'new' | 'old'): string | undefined {
  const status = side === 'new' ? 'added' : 'removed';
  const mark = side === 'new' ? '+' : '-';
  return file.status === status && !file.truncated && !file.isBinary
    ? file.hunks
        .flatMap((hunk) => hunk.patch.split('\n').filter((line) => line.startsWith(mark)))
        .map((line) => line.slice(1))
        .join('\n')
    : undefined;
}

/**
 * The lines an answer cites, as `[label](fileId:line)` links, that exist: in the diff, or among
 * the lines `read_file` returned for that side (`read`: last line read, by `fileId:side`). Model
 * output is untrusted, so the page only links these.
 */
export function citedRefs(text: string, diff: DiffPayload, read: ReadonlyMap<string, number> = new Map()): AskRef[] {
  const refs = new Map<string, AskRef>();
  for (const match of text.matchAll(/\]\(\s*([^)\s]+)\s*\)/g)) {
    const ref = parseAskRef(match[1]!);
    const file = ref && diff.files.find((candidate) => candidate.id === ref.fileId);
    if (
      ref &&
      file &&
      ref.line > 0 &&
      (ref.line <= (read.get(`${file.id}:${ref.side}`) ?? 0) || inHunks(file, ref.side, ref.line))
    ) {
      refs.set(`${ref.fileId}:${ref.side}:${ref.line}`, ref);
    }
  }
  return [...refs.values()];
}

const ReadFileInput = v.object({
  path: v.pipe(
    v.string(),
    v.description('The id of a changed file from the file list (e.g. f1a2b3), or any other repository path.'),
  ),
  side: v.optional(
    v.pipe(
      v.picklist(['new', 'old']),
      v.description('For a changed file: read it after the change (new, the default) or before it.'),
    ),
  ),
  from: v.optional(
    v.pipe(
      v.number(),
      v.description(
        'For a file outside the change: the first line to read, from 1. Read on from where a read stopped.',
      ),
    ),
  ),
});

/** A file outside the change, from the PR's clone when it has one, else as `readRepoFile` reads it. */
async function readOutside(diff: DiffPayload, tree: SearchTree | undefined, path: string, signal: AbortSignal) {
  // A working-tree diff has no commit to read from the tree; `readRepoFile` reads its HEAD.
  const text = tree?.rev ? await readTreeFile(tree, path, signal) : undefined;
  return text ?? readRepoFile(diff, path, signal);
}

/**
 * Answers one question about a finished tour with the model the reader picked. Streams the answer as it
 * is written, the files the model reads, then `ask.done` with the citations that check out. Never
 * fails: a model error ends the stream with `ask.failed`. Interrupting it stops the model.
 */
export function runAsk(options: RunAskOptions): Stream.Stream<AskEvent, never, ModelClient | Repos | RepoClones> {
  const { tour, diff } = options;
  return Stream.callback<AskEvent, never, ModelClient | Repos | RepoClones>((queue) =>
    Effect.gen(function* () {
      const model = yield* ModelClient;
      const repos = yield* Repos;
      // The PR's clone (the tour fetched it already, most often), looked up on the first search or read outside the change.
      const tree = yield* Effect.cached((yield* RepoClones).tree(diff));
      // Lines the model has read whole, by `fileId:side`: up to this line number.
      const read = new Map<string, number>();
      // Tool calls run as fibers of this stream's scope, so stopping the answer stops their git/gh reads too.
      const runPromise = yield* FiberSet.makeRuntimePromise<never>();
      const outside = fileReader(diff, (path) =>
        runPromise(tree.pipe(Effect.flatMap((t) => Effect.tryPromise((signal) => readOutside(diff, t, path, signal))))),
      );
      const search = codeSearcher(diff, (text, path) =>
        runPromise(
          tree.pipe(Effect.flatMap((t) => Effect.tryPromise((signal) => searchRepo(diff, t, text, path, signal)))),
        ),
      );
      const readFile: ChatTool = {
        name: 'read_file',
        description:
          'Read a file with line numbers: a whole changed file, when the diff does not show enough of it, or any other file of the repository at the head of the change, 400 lines at a time.',
        input: ReadFileInput,
        run: async (input) => {
          const parsed = v.safeParse(ReadFileInput, input);
          if (!parsed.success) {
            return 'Give a file id or a repository path.';
          }
          const { side = 'new', from } = parsed.output;
          const named = parsed.output.path.trim();
          const file = diff.files.find((candidate) => candidate.id === named || candidate.path === repoPath(named));
          if (!file) {
            return outside.tool.run({ path: named, ...(from === undefined ? {} : { from }) });
          }
          const text =
            wholeSideText(file, side) ??
            (await runPromise(
              repos.contents(diff, file).pipe(
                Effect.map((contents) => (side === 'old' ? contents?.oldContents : contents?.newContents)),
                Effect.orElseSucceed(() => undefined),
              ),
            ));
          if (text === undefined) {
            return `${file.path} cannot be read; use the diff.`;
          }
          const lines: string[] = [];
          let size = 0;
          for (const [index, line] of text.split('\n').entries()) {
            const numbered = `${index + 1} ${line}`;
            if (size + numbered.length > READ_BUDGET) {
              break;
            }
            lines.push(numbered);
            size += numbered.length + 1;
          }
          const key = `${file.id}:${side === 'old' ? 'deletions' : 'additions'}`;
          read.set(key, Math.max(read.get(key) ?? 0, lines.length));
          const total = text.split('\n').length;
          return lines.length < total
            ? `${lines.join('\n')}\n... (truncated at line ${lines.length} of ${total})`
            : lines.join('\n');
        },
      };
      /** What a tool call is about, for the page: the file read, or the text searched for. */
      const targetOf = (name: string, input: unknown) => {
        const { path, text } = (input ?? {}) as { path?: unknown; text?: unknown };
        if (name === 'search_code') {
          return typeof text === 'string' ? text : undefined;
        }
        return typeof path === 'string' ? (diff.files.find((file) => file.id === path)?.path ?? path) : undefined;
      };
      const history = (options.history ?? []).map((turn) => ({
        question: turn.question,
        answer: turn.answer,
        context: describeContext(turn.context, tour, diff),
      }));
      const prompt = buildAskPrompt({
        meta: diff.meta,
        files: diff.files,
        tour,
        history,
        question: options.question,
        context: describeContext(options.context, tour, diff),
      });
      const result = yield* model
        .chat({
          model: options.model ?? model.config().ask.default,
          system: ASK_SYSTEM,
          prompt,
          tools: [readFile, search.tool],
          onEvent: (event) =>
            Queue.offerUnsafe(
              queue,
              event.type === 'text'
                ? { type: 'ask.delta', text: event.text }
                : {
                    type: 'ask.tool',
                    id: event.id,
                    name: event.name,
                    target: targetOf(event.name, event.input),
                    state: event.state,
                  },
            ),
        })
        .pipe(Effect.result);
      Queue.offerUnsafe(
        queue,
        result._tag === 'Success'
          ? { type: 'ask.done', model: result.success.model, refs: citedRefs(result.success.text, diff, read) }
          : { type: 'ask.failed', message: result.failure.message },
      );
      yield* Queue.end(queue);
    }),
  );
}
