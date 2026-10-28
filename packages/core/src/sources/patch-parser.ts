import type { FileChange, FileStatus } from '@gloss/protocol';
import { sha256 } from '../hash.ts';

/** A parsed file before ids are assigned. */
export type ParsedFile = Omit<FileChange, 'id' | 'hunks' | 'generated'> & {
  hunks: Omit<FileChange['hunks'][number], 'id'>[];
};

const GIT_HEADER_RE = /^diff --git a\/.* b\/(.*)$/;
const QUOTED_GIT_HEADER_RE = /^diff --git "a\/(?:[^"\\]|\\.)*" "b\/((?:[^"\\]|\\.)*)"$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/;
const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Reverses git's C-style path quoting (`"x\"y"` -> `x"y`); octal escapes are UTF-8 bytes. */
function unquoteGitPath(text: string): string {
  if (!text.startsWith('"') || !text.endsWith('"')) {
    return text;
  }
  const bytes: number[] = [];
  const body = text.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (char !== '\\') {
      bytes.push(...new TextEncoder().encode(char));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(C_ESCAPES[body[i + 1]!] ?? body.charCodeAt(i + 1));
      i++;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Parses `@@` hunk blocks out of diff lines (a GitHub `patch` field, or the body of a git chunk). */
export function parseHunks(lines: readonly string[]): ParsedFile['hunks'] {
  const hunks: ParsedFile['hunks'] = [];
  let i = 0;
  while (i < lines.length) {
    const match = HUNK_HEADER_RE.exec(lines[i]!);
    if (!match) {
      i++;
      continue;
    }
    const header = lines[i]!;
    i++;
    const body: string[] = [];
    while (i < lines.length && !HUNK_HEADER_RE.test(lines[i]!)) {
      body.push(lines[i]!);
      i++;
    }
    while (body.length > 0 && body.at(-1) === '') {
      body.pop();
    }
    hunks.push({
      header,
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
      patch: body.join('\n'),
    });
  }
  return hunks;
}

export function countChanges(hunks: ParsedFile['hunks']): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.patch.split('\n')) {
      if (line.startsWith('+')) {
        additions++;
      } else if (line.startsWith('-')) {
        deletions++;
      }
    }
  }
  return { additions, deletions };
}

function parseGitChunk(chunk: string): ParsedFile {
  const lines = chunk.split('\n');
  const header = lines[0] ?? '';
  const quoted = QUOTED_GIT_HEADER_RE.exec(header)?.[1];
  const headerPath = quoted === undefined ? (GIT_HEADER_RE.exec(header)?.[1] ?? '') : unquoteGitPath(`"${quoted}"`);
  let status: FileStatus = 'modified';
  let isBinary = false;
  let from: string | undefined;
  let to: string | undefined;
  let hunkStart = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('@@ ')) {
      hunkStart = i;
      break;
    }
    if (line.startsWith('new file mode')) {
      status = 'added';
    } else if (line.startsWith('deleted file mode')) {
      status = 'removed';
    } else if ((line.startsWith('Binary files ') && line.endsWith(' differ')) || line === 'GIT binary patch') {
      isBinary = true;
    } else if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
      from = unquoteGitPath(line.replace(/^(rename|copy) from /, ''));
      status = line.startsWith('rename') ? 'renamed' : 'copied';
    } else if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
      to = unquoteGitPath(line.replace(/^(rename|copy) to /, ''));
    }
  }
  const hunks = isBinary || hunkStart === -1 ? [] : parseHunks(lines.slice(hunkStart));
  const moved = (status === 'renamed' || status === 'copied') && from !== undefined && to !== undefined;
  return {
    path: moved ? to! : headerPath,
    previousPath: moved ? from : undefined,
    status,
    isBinary,
    truncated: false,
    hunks,
    ...countChanges(hunks),
  };
}

/** Parses `git diff` output (also what GitHub's `.diff` media type returns). */
export function parsePatch(text: string): ParsedFile[] {
  return text
    .split(/(?=^diff --git )/m)
    .filter((chunk) => chunk.startsWith('diff --git '))
    .map(parseGitChunk);
}

/** Gives every file and hunk a short id derived from its content, so model output can reference them across runs. */
export function assignIds(files: readonly ParsedFile[]): FileChange[] {
  const seen = new Set<string>();
  const unique = (id: string) => {
    let candidate = id;
    for (let n = 2; seen.has(candidate); n++) {
      candidate = `${id}-${n}`;
    }
    seen.add(candidate);
    return candidate;
  };
  return files.map((file) => {
    const hunks = file.hunks.map((hunk) => ({
      ...hunk,
      id: unique(`h${sha256(`${file.path}\0${hunk.header}\0${hunk.patch}`).slice(0, 8)}`),
    }));
    const content = hunks.map((hunk) => hunk.id).join(',');
    const id = unique(
      `f${sha256(`${file.path}\0${file.previousPath ?? ''}\0${file.status}\0${file.additions}/${file.deletions}\0${content}`).slice(0, 8)}`,
    );
    return { ...file, id, hunks };
  });
}
