import type { PullActivity, PullState, RecentTours, Reviewer } from '@gloss/protocol';
import { serializeRef } from '@gloss/protocol';

/**
 * Whose move a PR is: the viewer's (review it, fix it, merge it), someone else's, a draft of the
 * viewer's, or unknown (no inbox data, such as a recent tour of a merged PR).
 */
export type Move = 'mine' | 'theirs' | 'draft' | 'unknown';

/** Where a PR stands for the viewer, in words for the home page and the rail. */
export interface Stand {
  move: Move;
  /** A short phrase for the home page row; empty when there is nothing to say. */
  reason: string;
  /** One or two words for the rail, only on the viewer's move; the rail shows faces otherwise. */
  short?: string;
  /** Something is broken: failing checks. */
  urgent: boolean;
  /** Lower comes first: others waiting on the viewer, then what blocks the viewer's PRs. */
  rank: number;
}

/** What `standOf` reads of a PR. */
export interface PullFacts {
  author?: string | undefined;
  state?: PullState | undefined;
  activity?: PullActivity | undefined;
  /** GitHub asks the viewer to review it. */
  requested: boolean;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

const VIEWER_REVIEW: Partial<Record<Reviewer['state'], string>> = {
  approved: 'You approved',
  changes: 'You asked for changes',
  commented: 'You commented',
};

export function standOf(pull: PullFacts, viewer: string | undefined): Stand {
  const { activity } = pull;
  const unknown: Stand = { move: 'unknown', reason: '', urgent: false, rank: 30 };
  if (!activity || !viewer || pull.state === 'merged' || pull.state === 'closed') {
    return unknown;
  }
  if (pull.author !== viewer) {
    const reviewedAt = activity.viewerReviewedAt;
    if (pull.requested && !reviewedAt) {
      return { move: 'mine', reason: 'Review requested', short: 'Review', urgent: false, rank: 0 };
    }
    if (reviewedAt && activity.pushedAt && activity.pushedAt > reviewedAt) {
      return { move: 'mine', reason: 'Pushed since your review', short: 'New push', urgent: false, rank: 1 };
    }
    if (pull.requested) {
      return { move: 'mine', reason: 'Review requested again', short: 'Review', urgent: false, rank: 0 };
    }
    const mine = activity.reviewers.find((reviewer) => reviewer.login === viewer);
    return { move: 'theirs', reason: (mine && VIEWER_REVIEW[mine.state]) ?? '', urgent: false, rank: 10 };
  }
  if (pull.state === 'draft') {
    return { move: 'draft', reason: 'Draft', urgent: false, rank: 20 };
  }
  const threads = activity.openThreads ? plural(activity.openThreads, 'open thread') : '';
  if (activity.checks === 'failing') {
    return {
      move: 'mine',
      reason: ['Checks failing', threads].filter(Boolean).join(' · '),
      short: 'Checks failing',
      urgent: true,
      rank: 2,
    };
  }
  if (activity.reviewDecision === 'changes') {
    return { move: 'mine', reason: 'Changes requested', short: 'Changes', urgent: false, rank: 3 };
  }
  if (activity.openThreads) {
    return { move: 'mine', reason: threads, short: plural(activity.openThreads, 'thread'), urgent: false, rank: 4 };
  }
  if (activity.reviewDecision === 'approved' && pull.state !== 'queued') {
    return { move: 'mine', reason: 'Ready to merge', short: 'Approved', urgent: false, rank: 5 };
  }
  if (pull.state === 'queued') {
    return { move: 'theirs', reason: 'In the merge queue', urgent: false, rank: 9 };
  }
  if (activity.reviewers.some((reviewer) => reviewer.state === 'pending')) {
    return { move: 'theirs', reason: 'Waiting on review', urgent: false, rank: 11 };
  }
  return { move: 'theirs', reason: 'No reviewer requested', urgent: false, rank: 12 };
}

/** The best (lowest-ranked) stand among several, such as a stack's PRs. */
export function bestStand(stands: readonly Stand[]): Stand | undefined {
  return stands.reduce<Stand | undefined>((best, stand) => (!best || stand.rank < best.rank ? stand : best), undefined);
}

/**
 * Each inbox PR's activity, keyed by `serializeRef`, from the inbox lists and their stacks, and
 * which of them GitHub asks the viewer to review.
 */
export function inboxFacts(recent: RecentTours): {
  activity: ReadonlyMap<string, PullActivity>;
  requested: ReadonlySet<string>;
} {
  const activity = new Map<string, PullActivity>();
  for (const tour of [...(recent.reviewRequested ?? []), ...(recent.reviewed ?? []), ...(recent.authored ?? [])]) {
    if (tour.activity) {
      activity.set(serializeRef(tour.ref), tour.activity);
    }
    for (const member of tour.stack?.members ?? []) {
      if (member.activity) {
        activity.set(
          serializeRef({ kind: 'github-pr', owner: tour.stack!.owner, repo: tour.stack!.repo, number: member.number }),
          member.activity,
        );
      }
    }
  }
  return { activity, requested: new Set((recent.reviewRequested ?? []).map((tour) => serializeRef(tour.ref))) };
}

/** People's faces on a row: reviewers who said something first, then those still asked. */
export function faceOrder(reviewers: readonly Reviewer[]): Reviewer[] {
  const order: Reviewer['state'][] = ['changes', 'approved', 'commented', 'pending'];
  return [...reviewers].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
}

/** A hue for a PR or stack's icon tile, from its key, so each keeps its colour. */
export function hueOf(seed: string): number {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash % 360;
}

/** Thousands as `1.6k`. */
export function compactCount(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(count);
}

/** Time since an ISO instant, as `5m`, `3h`, `4d` or `2mo`. */
export function ageOf(iso: string, now: number): string {
  const minutes = Math.max(1, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 60 ? `${days}d` : `${Math.round(days / 30)}mo`;
}
