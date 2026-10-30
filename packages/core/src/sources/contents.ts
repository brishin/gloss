import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiffHunk, DiffPayload, FileChange, FileContents } from '@gloss/protocol';
import { git } from './exec.ts';
import { gh } from './github.ts';

/**
 * The old side of a file, rebuilt from its new side by undoing the hunks. Only the head
 * is fetched: a PR's old side is the merge base, which `base.sha` is not once the base
 * branch moves, and the patch already says exactly what changed.
 */
export function reverseApply(
  newContents: string,
  hunks: readonly Pick<DiffHunk, 'newStart' | 'newLines' | 'patch'>[],
): string {
  const newLines = newContents.split('\n');
  const newEol = newLines.at(-1) === '';
  if (newEol) {
    newLines.pop();
  }
  const oldLines: string[] = [];
  // Without a marker, the end is unchanged: the old side ends like the new one.
  let oldMarker = false;
  let newMarker = false;
  let next = 0;
  for (const hunk of hunks) {
    // A hunk with no new lines names the line it follows; any other start is 1-based.
    const start = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
    oldLines.push(...newLines.slice(next, start));
    next = start;
    let previous = '';
    for (const line of hunk.patch.split('\n')) {
      const kind = line[0];
      if (kind === '\\') {
        // "\ No newline at end of file" ends whichever side the line before it is on.
        oldMarker ||= previous !== '+';
        newMarker ||= previous !== '-';
        continue;
      }
      if (kind === '-' || kind === ' ' || line === '') {
        oldLines.push(line.slice(1));
      }
      if (kind === '+' || kind === ' ' || line === '') {
        next++;
      }
      previous = kind ?? ' ';
    }
  }
  oldLines.push(...newLines.slice(next));
  const oldEol = !oldMarker && (newMarker || newEol);
  return oldLines.join('\n') + (oldEol && oldLines.length ? '\n' : '');
}

async function readHead(diff: DiffPayload, path: string, signal?: AbortSignal): Promise<string> {
  const { ref, meta } = diff;
  if (ref.kind === 'github-pr') {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return gh(
      [
        '-H',
        'Accept: application/vnd.github.raw+json',
        `repos/${ref.owner}/${ref.repo}/contents/${encoded}?ref=${encodeURIComponent(meta.headSha ?? meta.headRef)}`,
      ],
      signal,
    );
  }
  // No head sha is the working tree.
  return meta.headSha
    ? git(ref.repo, ['cat-file', 'blob', `${meta.headSha}:${path}`], { signal })
    : readFile(join(ref.repo, path), { encoding: 'utf8', signal });
}

/**
 * Both sides of a changed file in full, so the page can show the unchanged lines between
 * hunks. Undefined for files without a partial diff to fill in: added, removed, binary, truncated.
 */
export async function readFileContents(
  diff: DiffPayload,
  file: FileChange,
  signal?: AbortSignal,
): Promise<FileContents | undefined> {
  if (file.status === 'added' || file.status === 'removed' || file.isBinary || file.truncated || !file.hunks.length) {
    return undefined;
  }
  const newContents = await readHead(diff, file.path, signal);
  return { oldContents: reverseApply(newContents, file.hunks), newContents };
}
