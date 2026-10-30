import type { Decision, DecisionPriority, FileSummary, GroupView, RiskKey, RiskNote, TourState } from '@gloss/protocol';
import { DECISION_PRIORITIES } from '@gloss/protocol';

/** Sidebar/selection key of the tour overview (never a group key: those come from the model or are synthetic). */
export const OVERVIEW = '__overview';

/** Matches `--sticky-h` in styles.css (top bar + sub-bar): content scrolled under it is hidden. */
export const STICKY_OFFSET = 72;

export const RISK_SHORT: Record<RiskKey, string> = {
  authCheck: 'auth',
  storedData: 'stored data',
  secretsSigning: 'secrets',
  personalData: 'personal data',
};

/** Confirmed risk notes per file in a group. */
export function risksByFile(group: GroupView | undefined): Map<string, RiskNote[]> {
  const byFile = new Map<string, RiskNote[]>();
  for (const note of group?.notes?.riskNotes ?? []) {
    byFile.set(note.fileId, [...(byFile.get(note.fileId) ?? []), note]);
  }
  return byFile;
}

/** Files with a confirmed risk first, so the riskiest code is the first thing a reviewer reads. */
export function orderedFileIds(group: GroupView | undefined): string[] {
  if (!group) {
    return [];
  }
  const risky = risksByFile(group);
  return [...group.fileIds.filter((id) => risky.has(id)), ...group.fileIds.filter((id) => !risky.has(id))];
}

export function notedFileIds(group: GroupView | undefined): Set<string> {
  const notes = group?.notes;
  return new Set(
    [...(notes?.fileNotes ?? []), ...(notes?.lineNotes ?? []), ...(notes?.decisions ?? [])].flatMap((note) =>
      note.fileId ? [note.fileId] : [],
    ),
  );
}

/**
 * How loudly a flag asks for the reviewer: severe (take extra care), warning (a confirmed
 * risk), investigate (agree with it on purpose), info (explains the code). Most urgent first.
 */
export const FLAG_LEVELS = ['severe', 'warning', 'investigate', 'info'] as const;
export type FlagLevel = (typeof FLAG_LEVELS)[number];

export const FLAG_LABEL: Record<FlagLevel, string> = {
  severe: 'Severe',
  warning: 'Warning',
  investigate: 'Investigate',
  info: 'Informational',
};

const DECISION_FLAG: Record<DecisionPriority, FlagLevel> = {
  urgent: 'severe',
  high: 'investigate',
  medium: 'investigate',
  low: 'info',
};

export function noteFlag(note: { critical?: boolean }): FlagLevel {
  return note.critical ? 'severe' : 'info';
}

export function decisionFlag(decision: Decision): FlagLevel {
  return DECISION_FLAG[decision.priority];
}

/** Every flag shown in a group's section: its notes, risks and decisions, counted by level. */
export function sectionFlagCounts(state: TourState, group: GroupView): Record<FlagLevel, number> {
  const counts: Record<FlagLevel, number> = { severe: 0, warning: 0, investigate: 0, info: 0 };
  const notes = group.notes;
  for (const note of [...(notes?.fileNotes ?? []), ...(notes?.lineNotes ?? [])]) {
    counts[noteFlag(note)] += 1;
  }
  counts.warning += notes?.riskNotes.length ?? 0;
  for (const decision of [...(notes?.decisions ?? []), ...sectionDecisions(state, group.key)]) {
    counts[decisionFlag(decision)] += 1;
  }
  return counts;
}

export interface DecisionEntry {
  decision: Decision;
  /** The group holding the decision's file or section; absent for a decision about the whole change. */
  groupKey?: string;
}

/** Change-wide decisions the define call matched to this group's section. */
export function sectionDecisions(state: TourState, groupKey: string): Decision[] {
  return (state.decisions ?? []).filter((decision) => decision.groupKey === groupKey);
}

/** Every decision, most urgent first. Within a priority, change-wide ones lead, then tour order. */
export function decisionsInOrder(state: TourState, groups: readonly GroupView[]): DecisionEntry[] {
  const keys = new Set(groups.map((group) => group.key));
  const entries: DecisionEntry[] = [
    ...(state.decisions ?? []).map((decision) => ({
      decision,
      groupKey: decision.groupKey && keys.has(decision.groupKey) ? decision.groupKey : undefined,
    })),
    ...groups.flatMap((group) => (group.notes?.decisions ?? []).map((decision) => ({ decision, groupKey: group.key }))),
  ];
  const rank = (entry: DecisionEntry) => DECISION_PRIORITIES.indexOf(entry.decision.priority);
  return entries.toSorted((a, b) => rank(a) - rank(b));
}

export function isGeneratedFile(group: GroupView | undefined, file: FileSummary): boolean {
  return group?.key === 'generated' || file.generated === 'gitattributes';
}

/** Generated, binary, oversized and already-viewed files start collapsed. */
export function defaultExpanded(file: FileSummary, generated: boolean, viewed: boolean): boolean {
  return !(viewed || generated || file.isBinary || file.truncated || file.additions + file.deletions > 800);
}

export function splitPath(path: string): { dir: string; base: string } {
  const at = path.lastIndexOf('/');
  return at === -1 ? { dir: '', base: path } : { dir: path.slice(0, at + 1), base: path.slice(at + 1) };
}
