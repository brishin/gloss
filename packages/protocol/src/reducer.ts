import type { DiffMeta, FileSummary } from './diff.ts';
import type { ProvisionalGroup, Stage, StageState, TourEvent, TourEventBody } from './events.ts';
import { STAGES } from './events.ts';
import type { SourceRef } from './source-ref.ts';
import type {
  Category,
  Decision,
  FileJudgment,
  GroupDefinition,
  GroupNotes,
  ModelConfig,
  Placement,
  ResolvedGroup,
  Tour,
} from './tour.ts';

export type TourStatus = 'idle' | 'running' | 'complete' | 'error' | 'aborted';

export interface StageStatus {
  state: StageState;
  detail?: string;
  progress?: { done: number; total: number };
}

export interface TourState {
  status: TourStatus;
  jobId?: string;
  lastSeq: number;
  ref?: SourceRef;
  sourceKey?: string;
  models?: ModelConfig;
  cached: boolean;
  diffId?: string;
  meta?: DiffMeta;
  files: FileSummary[];
  provisional: ProvisionalGroup[];
  definitions: GroupDefinition[];
  definitionsDone: boolean;
  overallSummary?: string;
  /** Decisions about the change as a whole; per-group ones live in `notes`. */
  decisions?: Decision[];
  judgments: Record<string, FileJudgment>;
  placements: Record<string, Placement>;
  resolved?: ResolvedGroup[];
  notes: Record<string, GroupNotes>;
  stages: Record<Stage, StageStatus>;
  warnings: string[];
  error?: { code: string; message: string; stage?: Stage };
}

export function initialTourState(): TourState {
  return {
    status: 'idle',
    lastSeq: 0,
    cached: false,
    files: [],
    provisional: [],
    definitions: [],
    definitionsDone: false,
    judgments: {},
    placements: {},
    notes: {},
    stages: Object.fromEntries(STAGES.map((stage) => [stage, { state: 'pending' }])) as Record<Stage, StageStatus>,
    warnings: [],
  };
}

/** Pure and total: the server builds `tour.complete` from it, so clients and server agree by construction. */
export function reduceTourEvent(state: TourState, event: TourEvent | TourEventBody): TourState {
  const next: TourState = 'seq' in event ? { ...state, lastSeq: event.seq, jobId: event.jobId } : { ...state };
  switch (event.type) {
    case 'job.started':
      return {
        ...initialTourState(),
        jobId: next.jobId,
        lastSeq: next.lastSeq,
        status: 'running',
        ref: event.ref,
        sourceKey: event.sourceKey,
        models: event.models,
        cached: event.cached,
      };
    case 'diff.ready':
      return { ...next, diffId: event.diffId, meta: event.meta, files: event.files };
    case 'groups.provisional': {
      const placements = { ...next.placements };
      for (const group of event.groups) {
        for (const fileId of group.fileIds) {
          placements[fileId] ??= { groupKey: group.key, reason: 'heuristic' };
        }
      }
      return { ...next, provisional: event.groups, placements };
    }
    case 'stage.status':
      return {
        ...next,
        stages: {
          ...next.stages,
          [event.stage]: { state: event.state, detail: event.detail, progress: event.progress },
        },
      };
    case 'group.defined':
      return {
        ...next,
        definitions: [...next.definitions.filter((group) => group.key !== event.group.key), event.group],
      };
    case 'groups.defined': {
      const order = new Map(event.keys.map((key, index) => [key, index]));
      const definitions = next.definitions
        .filter((group) => order.has(group.key))
        .toSorted((a, b) => order.get(a.key)! - order.get(b.key)!);
      return { ...next, definitions, definitionsDone: true };
    }
    case 'tour.summary':
      return { ...next, overallSummary: event.overallSummary, decisions: event.decisions };
    case 'file.judged':
      return {
        ...next,
        judgments: { ...next.judgments, [event.fileId]: { ...next.judgments[event.fileId], ...event.judgment } },
      };
    case 'placement':
      return { ...next, placements: { ...next.placements, [event.fileId]: event.placement } };
    case 'groups.resolved':
      return { ...next, resolved: event.groups };
    case 'group.notes':
      return { ...next, notes: { ...next.notes, [event.groupKey]: event.notes } };
    case 'job.warning':
      return { ...next, warnings: [...next.warnings, event.message] };
    case 'job.error':
      return event.fatal
        ? { ...next, status: 'error', error: { code: event.code, message: event.message, stage: event.stage } }
        : { ...next, warnings: [...next.warnings, event.message] };
    case 'job.aborted':
      return { ...next, status: 'aborted' };
    case 'tour.complete':
      return hydrateFromTour(next, event.tour, event.cached);
  }
}

function hydrateFromTour(state: TourState, tour: Tour, cached: boolean): TourState {
  return {
    ...state,
    status: 'complete',
    cached: state.cached || cached,
    ref: tour.ref,
    models: tour.models,
    diffId: tour.diffId,
    meta: tour.meta,
    files: tour.files,
    overallSummary: tour.overallSummary,
    decisions: tour.decisions,
    definitions: tour.groups.map(({ key, label, summary, category }) => ({ key, label, summary, category })),
    definitionsDone: true,
    judgments: tour.judgments,
    placements: tour.placements,
    resolved: tour.groups,
    notes: tour.notes,
    stages: Object.fromEntries(
      STAGES.map((stage) => [stage, state.stages[stage].state === 'pending' ? { state: 'done' } : state.stages[stage]]),
    ) as Record<Stage, StageStatus>,
  };
}

/** The finished tour, or `undefined` while required parts are missing. */
export function tourFromState(state: TourState): Tour | undefined {
  if (!state.ref || !state.diffId || !state.meta || !state.models || !state.resolved) {
    return undefined;
  }
  return {
    diffId: state.diffId,
    ref: state.ref,
    meta: state.meta,
    files: state.files,
    overallSummary: state.overallSummary,
    decisions: state.decisions,
    groups: state.resolved,
    placements: state.placements,
    judgments: state.judgments,
    notes: state.notes,
    models: state.models,
  };
}

export type GroupPhase = 'provisional' | 'defined' | 'resolved';

export interface GroupView {
  key: string;
  label: string;
  summary?: string;
  category: Category;
  critical: boolean;
  fileIds: string[];
  phase: GroupPhase;
  synthetic: boolean;
  notes?: GroupNotes;
}

/**
 * The best grouping known so far: resolved groups once placement is done, else the
 * LLM's definitions filled from current placements, else the heuristic groups.
 * Every file appears in exactly one group at every stage.
 */
export function groupsInOrder(state: TourState): GroupView[] {
  if (state.resolved) {
    return state.resolved.map((group) => ({
      ...group,
      synthetic: group.synthetic ?? false,
      phase: 'resolved',
      notes: state.notes[group.key],
    }));
  }
  const base: { group: GroupDefinition; phase: GroupPhase }[] = state.definitions.length
    ? state.definitions.map((group) => ({ group, phase: 'defined' }))
    : state.provisional.map((group) => ({ group, phase: 'provisional' }));
  const views = new Map<string, GroupView>(
    base.map(({ group, phase }) => [
      group.key,
      { ...group, critical: false, fileIds: [], phase, synthetic: false, notes: state.notes[group.key] },
    ]),
  );
  const pending: string[] = [];
  for (const file of state.files) {
    const view = views.get(state.placements[file.id]?.groupKey ?? '');
    if (view) {
      view.fileIds.push(file.id);
    } else {
      pending.push(file.id);
    }
  }
  const groups = [...views.values()];
  if (pending.length) {
    groups.push({
      key: '__pending',
      label: state.definitions.length ? 'Being placed' : 'Files',
      category: 'other',
      critical: false,
      fileIds: pending,
      phase: 'provisional',
      synthetic: true,
    });
  }
  return groups.filter((group) => group.fileIds.length > 0 || group.phase === 'defined');
}
