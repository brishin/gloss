import type { FileChange, FileJudgment, GroupDefinition, Placement, ResolvedGroup } from '@gloss/protocol';
import { SYNTHETIC_GROUPS } from '@gloss/protocol';
import { isAgentGuidance, isDocumentation } from './guidance.ts';
import { looksLikeTest } from './heuristics.ts';
import { NO, YES } from './judge-questions.ts';
import { flaggedRisks } from './prompts.ts';
import { isSnapshot, snapshotSubjects } from './snapshots.ts';

/** Below these, Jev's group choice goes back to the LLM. */
export const MIN_CONFIDENCE = 0.5;
export const MIN_MARGIN = 0.15;
/** At this confidence Jev's choice stands even when it doubts the file fits any group. */
export const SURE_CHOICE = 0.8;

export interface PlaceOutcome {
  placements: Record<string, Placement>;
  /** Files Jev was unsure about; the LLM places them in one follow-up turn. */
  uncertain: string[];
  /** Snapshots and the code files they capture; each joins its code's group once that is known. */
  snapshots?: Record<string, string[]>;
}

function margin(probabilities: Record<string, number>): number {
  const [first = 0, second = 0] = Object.values(probabilities).toSorted((a, b) => b - a);
  return first - second;
}

function testsGroupKey(definitions: readonly GroupDefinition[]): string {
  return definitions.find((group) => group.category === 'tests')?.key ?? SYNTHETIC_GROUPS.tests.key;
}

function guidanceGroupKey(definitions: readonly GroupDefinition[]): string {
  return definitions.find((group) => group.category === 'docs')?.key ?? SYNTHETIC_GROUPS.guidance.key;
}

/**
 * Agent instructions always lead the tour; prose docs do too unless they are test
 * fixtures or Jev says they were generated (API reference output, for example).
 */
function guidancePlacement(
  file: FileChange,
  judgment: FileJudgment | undefined,
  definitions: readonly GroupDefinition[],
): Placement | undefined {
  const guidance =
    isAgentGuidance(file.path) ||
    (isDocumentation(file.path) && !looksLikeTest(file.path) && (judgment?.generated ?? 0) < YES);
  return guidance ? { groupKey: guidanceGroupKey(definitions), reason: 'guidance' } : undefined;
}

/**
 * The truth table that turns Jev's answers into placements (pulls.review report, "Code
 * holds the truth table"). Pure: every file gets a placement or lands in `uncertain`.
 */
export function placeFiles(
  files: readonly FileChange[],
  definitions: readonly GroupDefinition[],
  judgments: Record<string, FileJudgment>,
): PlaceOutcome {
  const keys = new Set(definitions.map((group) => group.key));
  const placements: Record<string, Placement> = {};
  const uncertain: string[] = [];
  const snapshots = snapshotSubjects(files);
  for (const file of files) {
    if (snapshots[file.id]) {
      continue;
    }
    const judgment = judgments[file.id] ?? {};
    // A snapshot with no code file of its name still reads with code: Jev or the LLM picks the group.
    const snapshot = isSnapshot(file.path);
    if (file.generated === 'gitattributes' && !snapshot) {
      placements[file.id] = { groupKey: SYNTHETIC_GROUPS.generated.key, reason: 'gitattributes' };
      continue;
    }
    const guidance = guidancePlacement(file, judgment, definitions);
    if (guidance) {
      placements[file.id] = guidance;
      continue;
    }
    if ((judgment.generated ?? 0) >= YES && !snapshot) {
      placements[file.id] = { groupKey: SYNTHETIC_GROUPS.generated.key, reason: 'jev', confidence: judgment.generated };
      continue;
    }
    if ((judgment.testsOnly ?? 0) >= YES && !snapshot) {
      placements[file.id] = { groupKey: testsGroupKey(definitions), reason: 'jev', confidence: judgment.testsOnly };
      continue;
    }
    const choice = judgment.group;
    if (
      !choice ||
      !keys.has(choice.choice) ||
      ((judgment.fitsAnyGroup ?? 1) <= NO && choice.confidence < SURE_CHOICE) ||
      choice.confidence < MIN_CONFIDENCE ||
      margin(choice.probabilities) < MIN_MARGIN
    ) {
      uncertain.push(file.id);
      continue;
    }
    placements[file.id] = { groupKey: choice.choice, reason: 'jev', confidence: choice.confidence };
  }
  return { placements, uncertain, snapshots };
}

/**
 * Without Jev the LLM lists each group's files. The first group to claim a file keeps it;
 * unknown ids are dropped; unclaimed files are returned for the follow-up turn.
 */
export function reconcileListedFiles(
  files: readonly FileChange[],
  groups: readonly (GroupDefinition & { fileIds: readonly string[] })[],
): PlaceOutcome & { unknownIds: string[] } {
  const known = new Set(files.map((file) => file.id));
  const placements: Record<string, Placement> = {};
  const unknownIds: string[] = [];
  for (const group of groups) {
    for (const fileId of group.fileIds) {
      if (!known.has(fileId)) {
        unknownIds.push(fileId);
      } else {
        placements[fileId] ??= { groupKey: group.key, reason: 'llm' };
      }
    }
  }
  const snapshots = snapshotSubjects(files);
  for (const file of files) {
    const guidance = guidancePlacement(file, undefined, groups);
    if (snapshots[file.id]) {
      delete placements[file.id];
    } else if (file.generated === 'gitattributes' && !isSnapshot(file.path)) {
      placements[file.id] = { groupKey: SYNTHETIC_GROUPS.generated.key, reason: 'gitattributes' };
    } else if (guidance) {
      placements[file.id] = guidance;
    }
  }
  const uncertain = files.filter((file) => !placements[file.id] && !snapshots[file.id]).map((file) => file.id);
  return { placements, uncertain, snapshots, unknownIds };
}

/**
 * Folds the follow-up turn's answers in, then puts each snapshot in the group most of its code
 * files landed in (the nearest one on a tie). Anything still unplaced goes to `uncategorized`.
 * Never drops a file.
 */
export function applyFollowup(
  outcome: PlaceOutcome,
  definitions: readonly GroupDefinition[],
  answers: readonly { fileId: string; groupKey: string }[],
): Record<string, Placement> {
  const keys = new Set(definitions.map((group) => group.key));
  const pending = new Set(outcome.uncertain);
  const placements = { ...outcome.placements };
  for (const answer of answers) {
    if (pending.has(answer.fileId) && keys.has(answer.groupKey)) {
      placements[answer.fileId] = { groupKey: answer.groupKey, reason: 'llm-followup' };
      pending.delete(answer.fileId);
    }
  }
  for (const fileId of pending) {
    placements[fileId] = { groupKey: SYNTHETIC_GROUPS.uncategorized.key, reason: 'uncategorized' };
  }
  for (const [fileId, subjects] of Object.entries(outcome.snapshots ?? {})) {
    const votes = new Map<string, number>();
    for (const subject of subjects) {
      const key = placements[subject]?.groupKey;
      if (key) {
        votes.set(key, (votes.get(key) ?? 0) + 1);
      }
    }
    const [groupKey] = [...votes].reduce<[string | undefined, number]>(
      (best, [key, count]) => (count > best[1] ? [key, count] : best),
      [undefined, 0],
    );
    placements[fileId] = groupKey
      ? { groupKey, reason: 'snapshot' }
      : { groupKey: SYNTHETIC_GROUPS.uncategorized.key, reason: 'uncategorized' };
  }
  return placements;
}

/** Each snapshot right after the last code file it captures in the same list; the rest stay in order. */
function besideSubjects(fileIds: readonly string[], subjects: Record<string, string[]>): string[] {
  const after = new Map<string, string[]>();
  const order: string[] = [];
  for (const fileId of fileIds) {
    const anchor = (subjects[fileId] ?? []).findLast((subject) => fileIds.includes(subject));
    if (anchor) {
      after.set(anchor, [...(after.get(anchor) ?? []), fileId]);
    } else {
      order.push(fileId);
    }
  }
  return order.flatMap((fileId) => [fileId, ...(after.get(fileId) ?? [])]);
}

const SYNTHETIC_TRAILING = [SYNTHETIC_GROUPS.tests, SYNTHETIC_GROUPS.generated, SYNTHETIC_GROUPS.uncategorized];
const SYNTHETIC_KEYS = new Set<string>([SYNTHETIC_GROUPS.guidance, ...SYNTHETIC_TRAILING].map((group) => group.key));

/**
 * Final groups in reading order: docs and agent guidance first (they state the intent
 * and rules the code should follow), then the LLM's order, then tests, then synthetic
 * groups. Empty groups are dropped; a group is critical when any member file is flagged
 * on a risk question (or the LLM marked it, when there is no judge).
 */
export function resolveGroups(
  files: readonly FileChange[],
  definitions: readonly (GroupDefinition & { critical?: boolean })[],
  placements: Record<string, Placement>,
  judgments: Record<string, FileJudgment>,
): ResolvedGroup[] {
  const members = new Map<string, string[]>();
  const defined = new Set(definitions.map((group) => group.key));
  for (const file of files) {
    let key = placements[file.id]?.groupKey;
    if (!key || (!defined.has(key) && !SYNTHETIC_KEYS.has(key))) {
      key = SYNTHETIC_GROUPS.uncategorized.key;
      placements[file.id] = { groupKey: key, reason: 'uncategorized' };
    }
    members.set(key, [...(members.get(key) ?? []), file.id]);
  }
  const subjects = snapshotSubjects(files);
  for (const [key, fileIds] of members) {
    members.set(key, besideSubjects(fileIds, subjects));
  }
  /** Tests and generated files flag what the code beside them does, so only code files count. */
  const critical = (fileIds: readonly string[]) =>
    fileIds.some((fileId) => {
      const judgment = judgments[fileId];
      return (judgment?.testsOnly ?? 0) < YES && (judgment?.generated ?? 0) < YES && flaggedRisks(judgment).length > 0;
    });
  const resolve = ({
    key,
    label,
    summary,
    category,
    ...rest
  }: GroupDefinition & { critical?: boolean }): ResolvedGroup => {
    const fileIds = members.get(key) ?? [];
    return { key, label, summary, category, fileIds, critical: (rest.critical ?? false) || critical(fileIds) };
  };
  const synthetic = (group: GroupDefinition): ResolvedGroup[] => {
    const fileIds = members.get(group.key);
    return !defined.has(group.key) && fileIds
      ? [{ ...group, fileIds, critical: critical(fileIds), synthetic: true }]
      : [];
  };
  const resolved: ResolvedGroup[] = [
    ...synthetic(SYNTHETIC_GROUPS.guidance),
    ...definitions.filter((group) => group.category === 'docs').map(resolve),
    ...definitions.filter((group) => group.category !== 'docs' && group.category !== 'tests').map(resolve),
    ...definitions.filter((group) => group.category === 'tests').map(resolve),
    ...SYNTHETIC_TRAILING.flatMap(synthetic),
  ];
  return resolved.filter((group) => group.fileIds.length > 0);
}
