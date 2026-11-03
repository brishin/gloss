import type { DiffPayload } from '@gloss/protocol';
import * as v from 'valibot';
import type { ChatTool } from '../adapters/types.ts';
import { repoPath } from '../sources/contents.ts';

/** Lines and characters one read hands the model; it asks again from a later line for more. */
const READ_LINES = 400;
const READ_CHARS = 24_000;
/** Reads one model call may make; past this the tool tells it to answer with what it has. */
const MAX_READS = 8;

const ReadFileInput = v.object({
  path: v.pipe(
    v.string(),
    v.description('A repository path, e.g. src/app/service.py: a changed file from the list, or any other file.'),
  ),
  from: v.optional(
    v.pipe(v.number(), v.description('The first line to read, from 1. Read on from where a read stopped.')),
  ),
});

export interface FileReader {
  tool: ChatTool;
  /** What the model read so far, one `path lines a-b` entry per read, for the trace. */
  reads(): string[];
}

/**
 * `read_file` for a pipeline stage: any file at the diff's head, numbered, a window at a time,
 * for code the prompt's diff cuts off or calls into without showing. `read` fetches a whole
 * file (`readRepoFile` through the tour's scope); the path is checked before it is called.
 */
export function fileReader(diff: DiffPayload, read: (path: string) => Promise<string>): FileReader {
  const reads: string[] = [];
  let count = 0;
  const tool: ChatTool = {
    name: 'read_file',
    description: `Read a file of the repository as it is after the change, with line numbers, ${READ_LINES} lines at a time. Use it when the diff is truncated or omitted, or a changed line depends on code the diff does not show. At most ${MAX_READS} reads.`,
    input: ReadFileInput,
    run: async (input) => {
      const parsed = v.safeParse(ReadFileInput, input);
      if (!parsed.success) {
        return 'Give a path, and optionally the first line to read.';
      }
      // A file id from the list works too.
      const named = parsed.output.path.trim();
      const path = repoPath(diff.files.find((file) => file.id === named)?.path ?? named);
      if (!path) {
        return `${named} is not a path inside the repository.`;
      }
      if (diff.files.some((file) => file.path === path && file.status === 'removed')) {
        return `${path} is removed by this change; its lines are in the diff.`;
      }
      if (count >= MAX_READS) {
        return 'No reads left. Answer with what you have.';
      }
      count++;
      let text: string;
      try {
        text = await read(path);
      } catch {
        return `${path} cannot be read at the head of this change.`;
      }
      if (text.includes('\0')) {
        return `${path} is a binary file.`;
      }
      const lines = text.replace(/\n$/, '').split('\n');
      const from = Math.min(Math.max(Math.floor(parsed.output.from ?? 1), 1), lines.length);
      const out: string[] = [];
      let size = 0;
      for (let line = from; line <= lines.length && out.length < READ_LINES; line++) {
        const numbered = `${line} ${lines[line - 1]}`;
        if (out.length && size + numbered.length > READ_CHARS) {
          break;
        }
        out.push(numbered);
        size += numbered.length + 1;
      }
      const to = from + out.length - 1;
      reads.push(`${path} lines ${from}-${to}`);
      return to < lines.length
        ? `${out.join('\n')}\n... (lines ${from}-${to} of ${lines.length}; read from ${to + 1} for more)`
        : out.join('\n');
    },
  };
  return { tool, reads: () => [...reads] };
}
