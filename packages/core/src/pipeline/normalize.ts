import type { FileChange, GroupNotes, ResolvedGroup } from '@gloss/protocol';
import type * as v from 'valibot';
import type { NotesSchema } from './prompts.ts';

/** Line numbers each side of a hunk actually shows, so a note can only land on a visible line. */
function visibleLines(hunk: FileChange['hunks'][number]): { additions: Set<number>; deletions: Set<number> } {
  const additions = new Set<number>();
  const deletions = new Set<number>();
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const line of hunk.patch.split('\n')) {
    const marker = line[0] ?? ' ';
    if (marker === '\\') {
      continue;
    }
    if (marker === '-') {
      deletions.add(oldLine++);
    } else if (marker === '+') {
      additions.add(newLine++);
    } else {
      additions.add(newLine++);
      deletions.add(oldLine++);
    }
  }
  return { additions, deletions };
}

/**
 * The trust boundary for model-written notes. Notes for files outside the group are
 * dropped (with a warning); a line note whose hunk or line is not visible is demoted to a
 * file note, never discarded, so the text survives a model's off-by-one.
 */
export function normalizeNotes(
  raw: v.InferOutput<typeof NotesSchema>,
  group: ResolvedGroup,
  files: readonly FileChange[],
): { notes: GroupNotes; warnings: string[] } {
  const inGroup = new Map(files.filter((file) => group.fileIds.includes(file.id)).map((file) => [file.id, file]));
  const warnings: string[] = [];
  const notes: GroupNotes = { fileNotes: [], lineNotes: [], riskNotes: [] };
  const unknown = (fileId: string) => {
    warnings.push(`Dropped a note for unknown file ${fileId} in group ${group.key}.`);
  };
  for (const note of raw.fileNotes) {
    if (inGroup.has(note.fileId)) {
      notes.fileNotes.push(note);
    } else {
      unknown(note.fileId);
    }
  }
  for (const note of raw.lineNotes) {
    const file = inGroup.get(note.fileId);
    if (!file) {
      unknown(note.fileId);
      continue;
    }
    const hunk = file.hunks.find((candidate) => candidate.id === note.hunkId);
    const fileHunk =
      hunk ??
      file.hunks.find((candidate) => {
        const lines = visibleLines(candidate);
        return lines[note.side].has(note.line);
      });
    if (fileHunk && visibleLines(fileHunk)[note.side].has(note.line)) {
      notes.lineNotes.push({ ...note, hunkId: fileHunk.id });
    } else {
      notes.fileNotes.push({ fileId: note.fileId, text: note.text, critical: note.critical });
    }
  }
  for (const note of raw.riskNotes) {
    if (inGroup.has(note.fileId)) {
      notes.riskNotes.push(note);
    } else {
      unknown(note.fileId);
    }
  }
  return { notes, warnings };
}
