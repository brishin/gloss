import type { FileChange, GroupNotes, ResolvedGroup, Visual } from '@gloss/protocol';
import type * as v from 'valibot';
import type { DefineSchema, NotesSchema } from './prompts.ts';

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

type RawVisual = NonNullable<v.InferOutput<typeof DefineSchema>['visual']>;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};
const clamp = (at: number) => (Number.isFinite(at) ? Math.min(100, Math.max(0, at)) : 0);
const rows = (list: readonly string[] | undefined) =>
  (list ?? [])
    .map((row) => clip(row, 90))
    .filter(Boolean)
    .slice(0, 6);

/** Mermaid diagram types the client draws; anything else (sequence, gantt, pie...) is dropped. */
const MERMAID_HEADER = /^(?:flowchart|graph)\s+(?:TD|TB|BT|LR|RL)\b|^stateDiagram(?:-v2)?\s*$/;

/**
 * The trust boundary for the tour's visual. It keeps only what the client can draw
 * legibly: a few short rows, a few lanes on a 0-100 axis, or a small flowchart or
 * state diagram without styling, init blocks or click handlers. Anything that does not
 * survive is dropped with a warning; a tour never fails over its picture.
 */
export function normalizeVisual(raw: RawVisual | undefined): { visual?: Visual; warnings: string[] } {
  if (!raw) {
    return { warnings: [] };
  }
  const caption = raw.caption ? clip(raw.caption, 200) || undefined : undefined;
  const drop = (why: string) => ({ warnings: [`Dropped the ${raw.kind} visual: ${why}.`] });
  if (raw.kind === 'before-after') {
    const before = rows(raw.before);
    const after = rows(raw.after);
    return before.length && after.length
      ? { visual: { kind: 'before-after', caption, before, after }, warnings: [] }
      : drop('it needs rows on both sides');
  }
  if (raw.kind === 'timeline') {
    const lanes = (raw.lanes ?? []).slice(0, 4).flatMap((lane) => {
      const spans = lane.spans.slice(0, 4).flatMap((span) => {
        const [from, to] = [clamp(span.from), clamp(span.to)].sort((a, b) => a - b) as [number, number];
        const text = clip(span.text, 40);
        return to > from ? [{ from, to, text, ...(span.tone ? { tone: span.tone } : {}) }] : [];
      });
      const outcome = lane.outcome && {
        at: clamp(lane.outcome.at),
        text: clip(lane.outcome.text, 60),
        tone: lane.outcome.tone,
      };
      const label = clip(lane.label, 24);
      return label && (spans.length || outcome) ? [{ label, spans, ...(outcome ? { outcome } : {}) }] : [];
    });
    const markers = (raw.markers ?? [])
      .slice(0, 5)
      .map((marker) => ({ at: clamp(marker.at), text: clip(marker.text, 30) }))
      .filter((marker) => marker.text);
    return lanes.length
      ? { visual: { kind: 'timeline', caption, markers, lanes }, warnings: [] }
      : drop('no lane has anything on it');
  }
  const lines = (raw.mermaid ?? '')
    .replace(/^\s*```(?:mermaid)?\s*\n?|\n?\s*```\s*$/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !/^\s*(?:%%|click\b|style\b|classDef\b|class\b|linkStyle\b)/.test(line));
  if (!MERMAID_HEADER.test(lines[0]?.trim() ?? '')) {
    return drop('only flowcharts and state diagrams are drawn');
  }
  if (lines.length > 30) {
    return drop('it is too large to read in the overview');
  }
  return { visual: { kind: 'mermaid', caption, source: lines.join('\n') }, warnings: [] };
}
