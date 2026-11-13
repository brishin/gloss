import type {
  Walkthrough,
  Decision,
  DecisionPriority,
  FileSummary,
  LfsPointer,
  GroupView,
  PullState,
  ReviewDecision,
  ReviewState,
  RiskNote,
  StackMember,
  TourState,
} from '@gloss/protocol';
import { DECISION_PRIORITIES } from '@gloss/protocol';

/** Sidebar/selection key of the tour overview (never a group key: those come from the model or are synthetic). */
export const OVERVIEW = '__overview';

/** Key of the walkthrough section between the overview and the groups, when the tour has one. */
export const WALKTHROUGH = '__walkthrough';

/** Matches `--sticky-h` in styles.css (top bar + PR head + sub-bar): content scrolled under it is hidden. */
export const STICKY_OFFSET = 136;

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

/**
 * A medium or low gap the description check found: folded into its own list on the overview,
 * since clean PRs get some of these. High and urgent ones stay with the decisions.
 */
export function isFoldedCheck(decision: Decision): boolean {
  return decision.source === 'description' && (decision.priority === 'medium' || decision.priority === 'low');
}

/** The description check's folded gaps, most urgent first. */
export function foldedChecks(state: TourState): Decision[] {
  const rank = (decision: Decision) => DECISION_PRIORITIES.indexOf(decision.priority);
  return (state.decisions ?? []).filter(isFoldedCheck).toSorted((a, b) => rank(a) - rank(b));
}

/**
 * The changed file an affected row's evidence names (`SupportCompose.tsx:118`, or a longer
 * path), so the overview can jump to it; undefined when it names code the diff does not change,
 * or a name more than one changed file ends with.
 */
export function evidenceFile(
  files: readonly Pick<FileSummary, 'id' | 'path'>[],
  evidence: string | undefined,
): { fileId: string; label: string } | undefined {
  const name = evidence
    ?.trim()
    .split(/[\s,]/)[0]
    ?.replace(/:\d+(-\d+)?$/, '');
  if (!name) {
    return undefined;
  }
  // An exact path wins; a base name or partial path links only when one changed file has it.
  const suffixed = files.filter((candidate) => candidate.path.endsWith(`/${name}`));
  const file = files.find((candidate) => candidate.path === name) ?? (suffixed.length === 1 ? suffixed[0] : undefined);
  return file && { fileId: file.id, label: evidence!.trim().split(/[\s,]/)[0]!.split('/').at(-1)! };
}

/** Every decision, most urgent first. Within a priority, change-wide ones lead, then tour order. */
export function decisionsInOrder(state: TourState, groups: readonly GroupView[]): DecisionEntry[] {
  const keys = new Set(groups.map((group) => group.key));
  const entries: DecisionEntry[] = [
    ...(state.decisions ?? [])
      .filter((decision) => !isFoldedCheck(decision))
      .map((decision) => ({
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

const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

/** A Git LFS image: the page shows both sides of it instead of the pointer diff. */
export function isLfsImage(file: Pick<FileSummary, 'path' | 'lfs'>): boolean {
  return Boolean(file.lfs) && IMAGE_PATH.test(file.path);
}

/** The LFS images to fetch as soon as the tour opens, so they are there when the reader gets to them. */
export function lfsImageOids(files: readonly Pick<FileSummary, 'path' | 'lfs'>[]): string[] {
  return files
    .filter(isLfsImage)
    .flatMap((file) => [file.lfs?.old?.oid, file.lfs?.new?.oid].filter((oid) => oid !== undefined));
}

/**
 * Generated, binary, Git LFS, oversized and already-viewed files start collapsed. An LFS image
 * opens even when generated: its picture is what there is to review (snapshots, say).
 */
export function defaultExpanded(file: FileSummary, generated: boolean, viewed: boolean): boolean {
  if (isLfsImage(file)) {
    return !viewed;
  }
  return !(viewed || generated || file.isBinary || file.lfs || file.truncated || file.additions + file.deletions > 800);
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** What a Git LFS file shows in place of its pointer diff: the object's size, or how it changed. */
export function lfsLabel(pointer: LfsPointer): string {
  const sizes = [...new Set([pointer.old?.size, pointer.new?.size])].filter((size) => size !== undefined);
  return ['Stored with Git LFS', ...(sizes.length ? [sizes.map(formatBytes).join(' → ')] : [])].join(' · ');
}

export function splitPath(path: string): { dir: string; base: string } {
  const at = path.lastIndexOf('/');
  return at === -1 ? { dir: '', base: path } : { dir: path.slice(0, at + 1), base: path.slice(at + 1) };
}

export const PULL_STATE_LABEL: Record<PullState, string> = {
  open: 'Open',
  draft: 'Draft',
  queued: 'In merge queue',
  merged: 'Merged',
  closed: 'Closed',
};

/** An open PR's review decision, after "Open" in the PR head. */
export const REVIEW_DECISION_LABEL: Record<ReviewDecision, string> = {
  approved: 'Approved',
  changes: 'Changes requested',
};

/** What a reviewer's mark means, after their login in its tooltip. */
export const REVIEW_STATE_LABEL: Record<ReviewState, string> = {
  approved: 'approved',
  changes: 'requested changes',
  commented: 'commented',
  pending: 'has not reviewed yet',
};

const AGO_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "3 hours ago", in the largest whole unit; under a minute is "just now". */
export function ago(iso: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(iso));
  const unit = AGO_UNITS.find(([, ms]) => elapsed >= ms);
  return unit
    ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-Math.floor(elapsed / unit[1]), unit[0])
    : 'just now';
}

/** What follows a PR state's label: when, who merged it, and its place in the merge queue. */
export function pullStateDetail(pull: StackMember, now: number): string {
  const when = pull.since ? ago(pull.since, now) : undefined;
  switch (pull.state) {
    case 'queued':
      return [pull.queuePosition && `position ${pull.queuePosition}`, when && `queued ${when}`]
        .filter(Boolean)
        .join(', ');
    case 'merged':
      return [pull.mergedBy && `by ${pull.mergedBy}`, when].filter(Boolean).join(' ');
    case 'closed':
      return ['without merging', when].filter(Boolean).join(' ');
    default:
      return when ? `opened ${when}` : '';
  }
}

/**
 * Where each change-wide decision the walkthrough reads is shown, by its number in the tour's
 * decisions: the group whose walk placed it.
 */
export function walkHomes(groups: readonly GroupView[]): Map<number, string> {
  const homes = new Map<number, string>();
  for (const group of groups) {
    for (const point of group.notes?.section?.points ?? []) {
      if (point.kind === 'wide' && point.wide !== undefined) {
        homes.set(point.wide, group.key);
      }
    }
  }
  return homes;
}

/** The group the key code path is read in, when a walk took it. */
export function pathHome(groups: readonly GroupView[]): string | undefined {
  return groups.find((group) => group.notes?.section?.path)?.key;
}

/**
 * The code path with each excerpt cut to its first `rows` lines: above open diffs the
 * excerpt only points at the code, which is in full right below.
 */
export function shortPath<P extends Pick<Walkthrough, 'frames' | 'steps'>>(path: P, rows = 8): P {
  return {
    ...path,
    steps: path.steps.map((step) => ({
      ...step,
      excerpts: step.excerpts.map((excerpt) => ({ ...excerpt, to: Math.min(excerpt.to, excerpt.from + rows - 1) })),
    })),
  };
}

/**
 * Whether the walkthrough has a stop of its own. The groups' walks read its decisions and its
 * code path, so it is a stop only for what no walk took: nothing while the walks are still
 * being written, and afterwards a decision or the code path that no walk took (its code is in
 * docs or tests groups, which have no walk, or a call failed).
 */
export function hasWalkStop(tour: Pick<TourState, 'walkthrough' | 'stages'>, groups: readonly GroupView[]): boolean {
  const walkthrough = tour.walkthrough;
  const writing = tour.stages.notes.state === 'pending' || tour.stages.notes.state === 'running';
  if (!walkthrough || writing) {
    return false;
  }
  const homes = walkHomes(groups);
  const pathLeft = walkthrough.steps.length > 0 && !pathHome(groups);
  return pathLeft || walkthrough.decisions.some((walk) => !homes.has(walk.decision));
}
