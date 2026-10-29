import type { Decision, FileChange, GroupNotes, ResolvedGroup } from '@gloss/protocol';
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

/** The hunk that shows `line` on `side`, preferring the one the model named. */
function pinnedHunk(file: FileChange, hunkId: string, side: 'additions' | 'deletions', line: number) {
  const named = file.hunks.find((candidate) => candidate.id === hunkId);
  const hunk = named ?? file.hunks.find((candidate) => visibleLines(candidate)[side].has(line));
  return hunk && visibleLines(hunk)[side].has(line) ? hunk : undefined;
}

/**
 * Change-wide decisions from the define call, with each `groupKey` checked against the
 * defined groups: an unknown key is dropped, so the decision stays change-wide.
 */
export function normalizeDecisionGroups(decisions: readonly Decision[], groupKeys: readonly string[]): Decision[] {
  const known = new Set(groupKeys);
  return decisions.map(({ groupKey, ...decision }) =>
    groupKey !== undefined && known.has(groupKey) ? { ...decision, groupKey } : decision,
  );
}

/**
 * The trust boundary for model-written notes. Notes for files outside the group are
 * dropped (with a warning); a line note whose hunk or line is not visible is demoted to a
 * file note, never discarded, so the text survives a model's off-by-one. Decisions follow
 * the same rule: one on an invisible line keeps its file and loses its line. A model that
 * names a file by its path instead of its id is understood.
 */
export function normalizeNotes(
  raw: v.InferOutput<typeof NotesSchema>,
  group: ResolvedGroup,
  files: readonly FileChange[],
): { notes: GroupNotes; warnings: string[] } {
  const members = files.filter((file) => group.fileIds.includes(file.id));
  const inGroup = new Map(members.flatMap((file) => [[file.id, file] as const, [file.path, file] as const]));
  const warnings: string[] = [];
  const notes: GroupNotes = { fileNotes: [], lineNotes: [], riskNotes: [], decisions: [] };
  const unknown = (fileId: string) => {
    warnings.push(`Dropped a note for unknown file ${fileId} in group ${group.key}.`);
  };
  for (const note of raw.fileNotes) {
    const file = inGroup.get(note.fileId);
    if (file) {
      notes.fileNotes.push({ ...note, fileId: file.id });
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
    const hunk = pinnedHunk(file, note.hunkId, note.side, note.line);
    if (hunk) {
      notes.lineNotes.push({ ...note, fileId: file.id, hunkId: hunk.id });
    } else {
      notes.fileNotes.push({ fileId: file.id, text: note.text, critical: note.critical });
    }
  }
  for (const note of raw.riskNotes) {
    const file = inGroup.get(note.fileId);
    if (file) {
      notes.riskNotes.push({ ...note, fileId: file.id });
    } else {
      unknown(note.fileId);
    }
  }
  for (const { fileId, hunkId, side, line, text, priority } of raw.decisions) {
    const file = inGroup.get(fileId);
    if (!file) {
      unknown(fileId);
      continue;
    }
    const hunk = pinnedHunk(file, hunkId, side, line);
    const id = file.id;
    notes.decisions!.push(
      hunk ? { text, priority, fileId: id, hunkId: hunk.id, side, line } : { text, priority, fileId: id },
    );
  }
  return { notes, warnings };
}
