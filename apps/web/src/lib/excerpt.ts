import type { CallFrame, DiffHunk, Excerpt, FileChange } from '@gloss/protocol';

/**
 * The lines of `hunk` whose new-side number is in `from`..`to`, with the removed lines that sit
 * between them, as a hunk of its own (header recomputed so line numbers stay true).
 */
export function sliceHunk(hunk: DiffHunk, from: number, to: number): DiffHunk {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const kept: string[] = [];
  let oldStart: number | undefined;
  let newStart: number | undefined;
  let oldLines = 0;
  let newLines = 0;
  for (const line of hunk.patch.split('\n')) {
    const kind = line[0];
    if (kind === '\\') {
      continue;
    }
    // A removed row sits at the new line after it, so rows removed right after `to` (at the
    // end of a hunk, say) still belong to the slice.
    const inside = newLine >= from && newLine <= (kind === '-' ? to + 1 : to);
    if (inside) {
      oldStart ??= oldLine;
      newStart ??= newLine;
      kept.push(line);
    }
    if (kind === '-') {
      oldLine++;
      oldLines += inside ? 1 : 0;
    } else if (kind === '+') {
      newLine++;
      newLines += inside ? 1 : 0;
    } else {
      oldLine++;
      newLine++;
      oldLines += inside ? 1 : 0;
      newLines += inside ? 1 : 0;
    }
  }
  const os = oldStart ?? hunk.oldStart;
  const ns = newStart ?? hunk.newStart;
  return {
    ...hunk,
    id: `${hunk.id}:${from}-${to}`,
    header: `@@ -${os},${oldLines} +${ns},${newLines} @@`,
    oldStart: os,
    oldLines,
    newStart: ns,
    newLines,
    patch: kept.join('\n'),
  };
}

/** The excerpt as a one-hunk file, ready for pierre. */
export function excerptFile(files: ReadonlyMap<string, FileChange>, excerpt: Excerpt): FileChange | undefined {
  const file = files.get(excerpt.fileId);
  const hunk = file?.hunks.find((candidate) => candidate.id === excerpt.hunkId);
  if (!file || !hunk) {
    return undefined;
  }
  return { ...file, hunks: [sliceHunk(hunk, excerpt.from, excerpt.to)] };
}

/** `dir/`, `base` and the new-side line range an excerpt shows, for its slim header. */
export function excerptLabel(file: FileChange): { dir: string; base: string; lines: string } {
  const at = file.path.lastIndexOf('/');
  const hunk = file.hunks[0]!;
  const end = hunk.newStart + Math.max(hunk.newLines, 1) - 1;
  return {
    dir: at < 0 ? '' : file.path.slice(0, at + 1),
    base: file.path.slice(at + 1),
    lines: hunk.newLines <= 1 ? `${hunk.newStart}` : `${hunk.newStart}–${end}`,
  };
}

/** Each row's parent: the nearest row before it one level up, or -1 for a root. */
export function callParents(rows: readonly { depth: number }[]): number[] {
  return rows.map((row, index) => {
    for (let at = index - 1; at >= 0; at--) {
      if (rows[at]!.depth < row.depth) {
        return at;
      }
    }
    return -1;
  });
}

/**
 * Which row each snippet hangs under: the last row of the first run of rows that point at it,
 * so a snippet several rows share shows once, after all of them. Row index to snippet index.
 */
export function snippetHosts(rows: readonly { snippet?: number }[]): Map<number, number> {
  const hosts = new Map<number, number>();
  const placed = new Set<number>();
  rows.forEach((row, index) => {
    const snippet = row.snippet;
    if (snippet === undefined || placed.has(snippet)) {
      return;
    }
    if (rows[index + 1]?.snippet !== snippet) {
      hosts.set(index, snippet);
      placed.add(snippet);
    }
  });
  return hosts;
}

/** The frames a step covers plus their callers, in tree order. */
export function stepFrames(
  frames: readonly CallFrame[],
  parents: readonly number[],
  picked: readonly number[],
): number[] {
  const keep = new Set<number>();
  for (const index of picked) {
    for (let at = index; at >= 0; at = parents[at]!) {
      keep.add(at);
    }
  }
  return frames.map((_, index) => index).filter((index) => keep.has(index));
}

/** Where each frame's definition is: the file only when it differs from the frame above. */
export function callLocations(frames: readonly CallFrame[]): string[] {
  return frames.map((frame, index) => {
    const file = frame.path?.split('/').at(-1) ?? '';
    const sameFile = index > 0 && frame.path !== undefined && frames[index - 1]!.path === frame.path;
    const line = frame.line === undefined ? '' : `:${frame.line}`;
    return sameFile && line ? line : `${file}${file ? line : ''}`;
  });
}
