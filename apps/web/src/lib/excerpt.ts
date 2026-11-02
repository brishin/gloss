import type { CallFrame, DiffHunk, FileChange } from '@gloss/protocol';

/** A slice of one hunk: new-side lines `from`..`to` (the whole hunk when absent). */
export interface ExcerptRef {
  fileId: string;
  hunkId: string;
  from?: number;
  to?: number;
}

/**
 * The lines of `hunk` whose new-side number is in `from`..`to`, with the removed lines that sit
 * between them, as a hunk of its own (header recomputed so line numbers stay true).
 */
export function sliceHunk(hunk: DiffHunk, from = -Infinity, to = Infinity): DiffHunk {
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
export function excerptFile(files: ReadonlyMap<string, FileChange>, excerpt: ExcerptRef): FileChange | undefined {
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

/** A frame's ancestors, root first, ending with the frame itself. */
export function framePath(parents: readonly number[], index: number): number[] {
  const path: number[] = [];
  for (let at = index; at >= 0; at = parents[at]!) {
    path.unshift(at);
  }
  return path;
}

/** The frames a step covers plus their callers, in tree order. */
export function stepFrames(
  frames: readonly CallFrame[],
  parents: readonly number[],
  picked: readonly number[],
): number[] {
  const keep = new Set(picked.flatMap((index) => framePath(parents, index)));
  return frames.map((_, index) => index).filter((index) => keep.has(index));
}
