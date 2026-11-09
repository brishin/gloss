import type { DiffPayload } from '@gloss/protocol';
import * as v from 'valibot';
import type { ChatTool } from '../adapters/types.ts';
import { repoPath } from '../sources/contents.ts';
import { fileImportQuery, type ImportQuery, packageImportQuery } from '../sources/importers.ts';

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
        const body = lines[line - 1]!;
        // One huge line (a minified bundle) is clipped too.
        const clipped = body.length > READ_CHARS ? `${body.slice(0, READ_CHARS)} ... (line cut)` : body;
        const numbered = `${line} ${clipped}`;
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

/** Searches one model call may make. */
const MAX_SEARCHES = 8;

const SearchCodeInput = v.object({
  text: v.pipe(
    v.string(),
    v.description('A fixed string to find, such as a function, component, module or route name. Not a regex.'),
  ),
  path: v.optional(v.pipe(v.string(), v.description('A directory to search under, e.g. apps/web/src.'))),
});

/**
 * `search_code` for a pipeline stage: where a name appears in the repository, to find who uses
 * the code a change edits. `search` runs `searchRepo` through the tour's scope.
 */
export function codeSearcher(
  diff: DiffPayload,
  search: (text: string, path: string | undefined) => Promise<string[]>,
): FileReader {
  const searches: string[] = [];
  const tool: ChatTool = {
    name: 'search_code',
    description: `Find where a fixed string appears in the repository, up to 40 matching lines. Use it to find who imports, calls or renders the code the change edits. At most ${MAX_SEARCHES} searches.`,
    input: SearchCodeInput,
    run: async (input) => {
      const parsed = v.safeParse(SearchCodeInput, input);
      const text = parsed.success ? parsed.output.text.trim() : '';
      if (text.length < 3) {
        return 'Give a string of at least 3 characters to find.';
      }
      const named = parsed.success ? parsed.output.path?.trim() : undefined;
      const path = named ? repoPath(named.replace(/\/$/, '')) : undefined;
      if (named && !path) {
        return `${named} is not a path inside the repository.`;
      }
      if (searches.length >= MAX_SEARCHES) {
        return 'No searches left. Answer with what you have.';
      }
      searches.push(`search ${JSON.stringify(text)}${path ? ` in ${path}` : ''}`);
      try {
        const lines = await search(text, path);
        return lines.length ? lines.join('\n') : 'No matches.';
      } catch {
        return 'The search failed. Read the files you know instead.';
      }
    },
  };
  return { tool, reads: () => [...searches] };
}

const FindImportersInput = v.object({
  path: v.optional(v.pipe(v.string(), v.description('A repository file, e.g. src/editor/session.ts.'))),
  package: v.optional(v.pipe(v.string(), v.description('A package name, e.g. prosemirror-model.'))),
});

/**
 * `find_importers` for a pipeline stage: the files that import a repository file or a package,
 * outside the change. `find` runs `findImporters` through the tour's scope.
 */
export function importerFinder(find: (query: ImportQuery) => Promise<string[]>): FileReader {
  const finds: string[] = [];
  const tool: ChatTool = {
    name: 'find_importers',
    description: `List the files outside this change that import a repository file (give path) or a package (give package), up to 40 import lines. Use it to find which screens, services and jobs use shared code the change edits. At most ${MAX_SEARCHES} calls.`,
    input: FindImportersInput,
    run: async (input) => {
      const parsed = v.safeParse(FindImportersInput, input);
      const named = parsed.success ? (parsed.output.path ?? '').trim() : '';
      const pkg = parsed.success ? (parsed.output.package ?? '').trim() : '';
      const path = named ? repoPath(named) : undefined;
      if (named && !path) {
        return `${named} is not a path inside the repository.`;
      }
      const query = path ? fileImportQuery(path) : pkg.length >= 2 ? packageImportQuery(pkg) : undefined;
      if (!query) {
        return path
          ? `${path} is not imported by its path (only script and Python files are). Call search_code with a type or function name it defines.`
          : 'Give a path or a package.';
      }
      if (finds.length >= MAX_SEARCHES) {
        return 'No calls left. Answer with what you have.';
      }
      finds.push(`importers of ${query.label}`);
      try {
        const lines = await find(query);
        return lines.length ? lines.join('\n') : 'Nothing outside this change imports it.';
      } catch {
        return 'The lookup failed. Call search_code instead.';
      }
    },
  };
  return { tool, reads: () => [...finds] };
}
