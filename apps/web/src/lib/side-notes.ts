import type { CallFrame, Decision, DecisionPriority, DiffSide, GroupView, TourState } from '@gloss/protocol';
import { decisionFlag, type FlagLevel, orderedFileIds, sectionDecisions } from './tour-view.ts';

/**
 * A decision or walk stop of a group, read as a note beside the lines it is about: the column
 * next to the group's diffs (`NoteLane.tsx`) shows them in order down the page, and n/p step
 * through them.
 */
export interface SideNote {
  /** `<group key>/<source><index>`: stable while the tour's notes are. */
  id: string;
  groupKey: string;
  /** Its number down the group, from 1. */
  n: number;
  level?: FlagLevel;
  /** An urgent or high decision: its text shows without the note being current. */
  key: boolean;
  title: string;
  why?: string;
  instead?: string;
  check?: string;
  /** The lines it sits beside, when they are in one of the group's files. */
  fileId?: string;
  side?: DiffSide;
  from?: number;
  to?: number;
  /** The rest of its reach: other places its code is. */
  also: readonly { label?: string; fileId: string; line?: number }[];
}

type Draft = Omit<SideNote, 'n'>;

const isKey = (priority: DecisionPriority | undefined) => priority === 'urgent' || priority === 'high';

const flagOf = (priority: DecisionPriority | undefined): FlagLevel | undefined =>
  priority && decisionFlag({ text: '', priority });

/** The group a note id belongs to. */
export const noteGroup = (id: string): string => id.slice(0, id.lastIndexOf('/'));

/**
 * A group's notes in reading order: the ones about the group as a whole, then the ones on
 * lines, file by file down the page. `homes` says where each change-wide decision is read
 * (`walkHomes`).
 */
export function sideNotes(
  tour: Pick<TourState, 'decisions' | 'walkthrough'>,
  group: GroupView,
  homes: ReadonlyMap<number, string>,
): SideNote[] {
  const files = orderedFileIds(group);
  const inGroup = (fileId: string | undefined) => fileId !== undefined && files.includes(fileId);
  const own = group.notes?.decisions ?? [];
  const drafts: Draft[] = [];
  const base = (source: string) => ({ id: `${group.key}/${source}`, groupKey: group.key });
  const decisionAt = (decision: Decision) =>
    inGroup(decision.fileId)
      ? {
          fileId: decision.fileId,
          ...(decision.line !== undefined && {
            side: decision.side ?? ('additions' as const),
            from: decision.line,
            to: decision.line,
          }),
        }
      : {};
  const plain = (source: string, decision: Decision): Draft => ({
    ...base(source),
    level: decisionFlag(decision),
    key: isKey(decision.priority),
    title: decision.text,
    also: [],
    ...decisionAt(decision),
  });
  /** The first snippet in one of the group's files is where the note sits; the others are its reach. */
  const placed = (snippets: readonly { fileId: string; from: number; to: number }[]) => {
    const at = snippets.findIndex((snippet) => inGroup(snippet.fileId));
    const anchor = snippets[at];
    return {
      ...(anchor && { fileId: anchor.fileId, side: 'additions' as const, from: anchor.from, to: anchor.to }),
      also: snippets
        .filter((_, index) => index !== at)
        .map((snippet) => ({ fileId: snippet.fileId, line: snippet.from })),
    };
  };

  // Change-wide decisions the define call matched to this group that no walk reads.
  sectionDecisions(tour as TourState, group.key).forEach((decision) => {
    const index = tour.decisions?.indexOf(decision) ?? -1;
    if (!homes.has(index)) {
      drafts.push(plain(`c${index}`, decision));
    }
  });

  const read = new Set<number>();
  (group.notes?.section?.points ?? []).forEach((point, index) => {
    if (point.kind === 'wide') {
      const walk = tour.walkthrough?.decisions.find((candidate) => candidate.decision === point.wide);
      if (!walk) {
        return;
      }
      const priority = tour.decisions?.[walk.decision]?.priority;
      const { also, ...at } = placed(walk.snippets);
      drafts.push({
        ...base(`w${walk.decision}`),
        level: flagOf(priority),
        key: isKey(priority),
        title: walk.title,
        why: walk.why || undefined,
        instead: walk.instead,
        check: walk.check,
        ...at,
        also: [...also, ...walk.refs],
      });
      return;
    }
    const decision = point.decision === undefined ? undefined : own[point.decision];
    if (decision && point.decision !== undefined) {
      read.add(point.decision);
    }
    const priority = point.priority ?? decision?.priority;
    const { also, ...at } = placed(point.snippets);
    const see = point.see && inGroup(point.see.fileId) ? point.see : undefined;
    drafts.push({
      ...base(`p${index}`),
      level: flagOf(priority),
      key: isKey(priority),
      title: point.title,
      why: point.why || undefined,
      instead: point.instead,
      check: point.check,
      ...(at.fileId
        ? at
        : see
          ? { fileId: see.fileId, side: 'additions' as const, from: see.line, to: see.line }
          : decision
            ? decisionAt(decision)
            : {}),
      also,
    });
  });

  // The group's own decisions that no stop reads.
  own.forEach((decision, index) => {
    if (!read.has(index)) {
      drafts.push(plain(`d${index}`, decision));
    }
  });

  const rank = (note: Draft) => (note.fileId === undefined ? -1 : files.indexOf(note.fileId));
  return drafts
    .map((note, index) => ({ note, index }))
    .toSorted((a, b) => rank(a.note) - rank(b.note) || (a.note.from ?? 0) - (b.note.from ?? 0) || a.index - b.index)
    .map(({ note }, index) => ({ ...note, n: index + 1 }));
}

/** A place n/p stop at: a note, or a file that has none. */
export type ReadStop = { note: SideNote } | { fileId: string };

/**
 * Every stop down the page, in reading order. In each group: its notes about the group as a
 * whole, then each file, as its notes when it has some and as the file itself when it has none.
 */
export function readStops(
  tour: Pick<TourState, 'decisions' | 'walkthrough'>,
  groups: readonly GroupView[],
  homes: ReadonlyMap<number, string>,
): ReadStop[] {
  return groups.flatMap((group) => {
    const notes = sideNotes(tour, group, homes);
    return [
      ...notes.filter((note) => note.fileId === undefined).map((note) => ({ note })),
      ...orderedFileIds(group).flatMap((fileId): ReadStop[] => {
        const own = notes.filter((note) => note.fileId === fileId);
        return own.length ? own.map((note) => ({ note })) : [{ fileId }];
      }),
    ];
  });
}

/** `base.ts:12–18` for a note's lines. */
export function noteLines(note: Pick<SideNote, 'from' | 'to'>): string {
  return note.from === undefined
    ? ''
    : note.to !== undefined && note.to !== note.from
      ? `${note.from}–${note.to}`
      : `${note.from}`;
}

/**
 * The frame of the key code path each note is in: the last frame defined at or above the
 * note's first line in the same file. Note id to frame index.
 */
export function noteFrames(
  frames: readonly CallFrame[],
  notes: readonly SideNote[],
  pathOf: (fileId: string) => string | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const note of notes) {
    const path = note.fileId === undefined ? undefined : pathOf(note.fileId);
    if (path === undefined || note.from === undefined || note.side === 'deletions') {
      continue;
    }
    let best = -1;
    frames.forEach((frame, index) => {
      if (
        frame.path === path &&
        frame.line !== undefined &&
        frame.line <= note.from! &&
        frame.line >= (frames[best]?.line ?? 0)
      ) {
        best = index;
      }
    });
    if (best >= 0) {
      out.set(note.id, best);
    }
  }
  return out;
}
