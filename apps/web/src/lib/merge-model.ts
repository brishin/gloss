import type { MergeMethod, MergeRequest, PullMerge, StackMember } from '@gloss/protocol';
import type { PullRef } from './reviewers-model.ts';

export type MergeAction = MergeRequest['action'];

/** The Merge panel in the top bar (PRs the viewer may merge). */
export interface MergeModel {
  open: boolean;
  /** The method picked in the panel; the viewer's usual one until then. */
  method?: MergeMethod;
  /** An action is on its way to GitHub. */
  sending?: MergeAction;
  /** GitHub refused the last action; cleared by the next one. */
  error?: string;
}

export const emptyMerge: MergeModel = { open: false };

export type MergeMsg =
  | { type: 'MergeOpened' }
  | { type: 'MergeClosed' }
  | { type: 'MergeMethodPicked'; method: MergeMethod }
  | { type: 'MergeClicked'; action: MergeAction }
  | { type: 'MergeDone'; pull: StackMember }
  | { type: 'MergeFailed'; error: string };

export type MergeCmd = {
  type: 'MergePull';
  ref: PullRef;
  action: MergeAction;
  method?: MergeMethod;
  headOid?: string;
};

/**
 * The panel's state and the PR after an action. Opening asks for the stack again, so checks
 * and the queue are as GitHub has them now, not as they were when the tour opened. A refusal
 * keeps the panel open with GitHub's words, and reads the PR again.
 */
export function updateMerge(
  state: MergeModel,
  msg: MergeMsg,
  ref: PullRef | undefined,
  pull: StackMember | undefined,
  /** The head commit the tour read: a newer push must not merge unseen. */
  headOid: string | undefined,
): { state: MergeModel; pull?: StackMember; cmds: MergeCmd[]; refetch?: boolean } {
  switch (msg.type) {
    case 'MergeOpened':
      return { state: { ...state, open: true, error: undefined }, cmds: [], refetch: !state.open };
    case 'MergeClosed':
      return { state: { ...state, open: false, error: undefined }, cmds: [] };
    case 'MergeMethodPicked':
      return { state: { ...state, method: msg.method }, cmds: [] };
    case 'MergeClicked': {
      if (!ref || !pull?.merge || state.sending) {
        return { state, cmds: [] };
      }
      const method = pickedMethod(pull.merge, state);
      return {
        state: { ...state, sending: msg.action, error: undefined },
        cmds: [
          {
            type: 'MergePull',
            ref,
            action: msg.action,
            ...(method ? { method } : {}),
            ...((headOid ?? pull.merge.headOid) ? { headOid: headOid ?? pull.merge.headOid } : {}),
          },
        ],
      };
    }
    case 'MergeDone':
      return {
        state: {
          ...state,
          sending: undefined,
          error: undefined,
          open: msg.pull.state === 'merged' ? false : state.open,
        },
        pull: msg.pull,
        cmds: [],
      };
    case 'MergeFailed':
      return { state: { ...state, sending: undefined, open: true, error: msg.error }, cmds: [], refetch: true };
  }
}

/** The method a merge sends: the one picked, if the repo still allows it, else the viewer's usual one. */
export function pickedMethod(merge: PullMerge, state: MergeModel): MergeMethod | undefined {
  return state.method && merge.methods.includes(state.method) ? state.method : merge.methods[0];
}

/** One line of what merging waits on: ok, waiting, blocking, or plain information. */
export interface MergeRow {
  tone: 'ok' | 'wait' | 'bad' | 'info';
  text: string;
  /** Quieter words after the text: failing check names, who approved. */
  detail?: string;
  /** Right-aligned: a time estimate. */
  end?: string;
}

/** The button the panel ends with, and the words beside it. */
export interface MergeButton {
  action: MergeAction;
  label: string;
  kind: 'merge' | 'quiet';
}

export interface MergeView {
  rows: MergeRow[];
  /** Whether to offer the methods (a direct merge that can still happen). */
  methods: boolean;
  buttons: MergeButton[];
  note?: string;
}

const METHOD_LABEL: Record<MergeMethod, string> = {
  squash: 'Squash and merge',
  merge: 'Merge',
  rebase: 'Rebase and merge',
};

export const METHOD_NAME: Record<MergeMethod, string> = { squash: 'Squash', merge: 'Merge', rebase: 'Rebase' };

const ORDINAL = (n: number) =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;

/** "about 9 min", "about 2 h", "under a minute". */
export function aboutTime(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `about ${minutes} min` : `about ${Math.round(minutes / 60)} h`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * What the Merge panel says for a PR: what is left (checks, review, the base), then the one
 * thing to do. On a queued base that is joining the queue (or leaving it); elsewhere merging
 * now when nothing is left, or once it is, with an admin's merge past the rules beside it.
 */
export function mergeView(pull: StackMember, state: MergeModel): MergeView {
  const merge = pull.merge!;
  const base = pull.baseRef;
  const rows: MergeRow[] = [];
  const { passed, failed, pending, failing } = merge.checks;
  const total = passed + failed + pending;
  if (failed) {
    rows.push({
      tone: 'bad',
      text: `${failed} of ${plural(total, 'check')} failed`,
      detail: failing.slice(0, 2).join(', '),
    });
  } else if (pending) {
    rows.push({
      tone: 'wait',
      text: `${plural(pending, 'check')} running`,
      detail: passed ? `${passed} passed` : undefined,
    });
  } else if (passed) {
    rows.push({ tone: 'ok', text: `${plural(passed, 'check')} passed` });
  }
  const approvers = (pull.reviewers ?? []).filter((one) => one.state === 'approved').map((one) => one.login);
  const changers = (pull.reviewers ?? []).filter((one) => one.state === 'changes').map((one) => one.login);
  if (pull.reviewDecision === 'changes') {
    rows.push({
      tone: 'bad',
      text: changers.length ? `Changes requested by ${changers.join(', ')}` : 'Changes requested',
    });
  } else if (pull.reviewDecision === 'approved') {
    rows.push({ tone: 'ok', text: approvers.length ? `Approved by ${approvers.join(', ')}` : 'Approved' });
  } else if (merge.status === 'blocked' && !failed && !pending) {
    rows.push({ tone: 'wait', text: 'Waiting on a required review' });
  }
  if (merge.status === 'conflicts') {
    rows.push({ tone: 'bad', text: `Conflicts with ${base}` });
  } else if (merge.status === 'behind') {
    rows.push({ tone: 'wait', text: `Behind ${base}` });
  } else if (merge.status !== 'unknown') {
    rows.push({ tone: 'ok', text: `No conflicts with ${base}` });
  }
  const queued = pull.state === 'queued';
  if (merge.queue) {
    const eta = merge.queueEta === undefined ? undefined : aboutTime(merge.queueEta);
    if (queued && pull.queuePosition) {
      rows.push({
        tone: 'info',
        text: merge.queueSize
          ? `${ORDINAL(pull.queuePosition)} of ${merge.queueSize} in the ${base} queue`
          : `${ORDINAL(pull.queuePosition)} in the ${base} queue`,
        end: eta,
      });
    } else if (!queued) {
      rows.push({
        tone: 'info',
        text: merge.queueSize ? `${plural(merge.queueSize, 'PR')} in the ${base} queue` : `The ${base} queue is empty`,
        end: eta,
      });
    }
  }

  if (queued) {
    return { rows, methods: false, buttons: [{ action: 'dequeue', label: 'Remove from queue', kind: 'quiet' }] };
  }
  if (merge.auto) {
    return {
      rows,
      methods: false,
      note: merge.queue ? 'Joins the queue once it is ready' : 'Merges by itself once it is ready',
      buttons: [{ action: 'cancel', label: 'Cancel auto-merge', kind: 'quiet' }],
    };
  }
  const ready = merge.status === 'clean' || merge.status === 'unstable';
  const method = pickedMethod(merge, state) ?? 'merge';
  if (ready) {
    return merge.queue
      ? {
          rows,
          methods: false,
          note: `The queue merges into ${base}`,
          buttons: [{ action: 'ready', label: 'Add to queue', kind: 'merge' }],
        }
      : {
          rows,
          methods: merge.methods.length > 1,
          buttons: [{ action: 'ready', label: METHOD_LABEL[method], kind: 'merge' }],
        };
  }
  if (merge.status === 'conflicts') {
    return { rows, methods: false, note: 'Resolve the conflicts on GitHub first', buttons: [] };
  }
  const buttons: MergeButton[] = [];
  if (merge.canBypass && !merge.queue) {
    buttons.push({ action: 'now', label: 'Bypass and merge', kind: 'quiet' });
  }
  if (merge.canAuto) {
    buttons.push({ action: 'ready', label: merge.queue ? 'Add when ready' : 'Merge when ready', kind: 'merge' });
  }
  return {
    rows,
    methods: !merge.queue && merge.methods.length > 1 && buttons.length > 0,
    note: buttons.length ? undefined : 'Auto-merge is off for this repository',
    buttons,
  };
}
