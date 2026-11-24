import type { Reviewer, ReviewerCandidate, ReviewersResult, StackMember } from '@gloss/protocol';

/** Who is asked: a user's login, or a team's `org/slug`. */
export interface Who {
  login: string;
  team?: boolean;
}

/** The picker that asks GitHub for reviews from the PR head (PRs only). */
export interface ReviewersModel {
  open: boolean;
  /** The search box: collaborators matching it are listed under the suggestions. */
  query: string;
  /** The answer for `query` once it arrives; an answer for an older query is dropped. */
  found?: { query: string; candidates: readonly ReviewerCandidate[] };
  /** GitHub refused the last change; cleared by the next one. */
  error?: string;
  /** A change is on its way to GitHub. */
  sending: boolean;
  /**
   * Changes picked while one is on its way, sent one by one in order: two at once could reach
   * GitHub out of order, and an older answer would overwrite the newer picks on screen.
   */
  queued: readonly Change[];
}

/** One ask or withdrawal for GitHub. */
export interface Change {
  add?: readonly Who[];
  remove?: readonly Who[];
}

export const emptyReviewers: ReviewersModel = { open: false, query: '', sending: false, queued: [] };

export type ReviewersMsg =
  | { type: 'ReviewersOpened' }
  | { type: 'ReviewersClosed' }
  | { type: 'ReviewerQueryChanged'; query: string }
  | { type: 'ReviewersFound'; query: string; candidates: readonly ReviewerCandidate[] }
  | { type: 'ReviewerAdded'; who: Who }
  | { type: 'ReviewerRemoved'; who: Who }
  | { type: 'ReviewersChanged'; result: ReviewersResult }
  | { type: 'ReviewersFailed'; error: string };

export interface PullRef {
  owner: string;
  repo: string;
  number: number;
}

export type ReviewersCmd =
  | { type: 'SearchReviewers'; ref: PullRef; query: string }
  | { type: 'ChangeReviewers'; ref: PullRef; add?: readonly Who[]; remove?: readonly Who[] };

/**
 * The picker's state, and the PR as it should show now: an ask shows as pending at once, and a
 * withdrawn one goes, before GitHub answers. Changes go to GitHub one at a time; once the last
 * answer is in, it replaces both lists, and a refusal leaves the error and asks for the stack
 * again (`refetch`) to put the lists back.
 */
export function updateReviewers(
  state: ReviewersModel,
  msg: ReviewersMsg,
  ref: PullRef | undefined,
  pull: StackMember | undefined,
): { state: ReviewersModel; pull?: StackMember; cmds: ReviewersCmd[]; refetch?: boolean } {
  switch (msg.type) {
    case 'ReviewersOpened':
      return { state: { ...state, open: true, error: undefined }, cmds: [] };
    case 'ReviewersClosed':
      return { state: { ...emptyReviewers, sending: state.sending, queued: state.queued }, cmds: [] };
    case 'ReviewerQueryChanged': {
      const query = msg.query;
      const search = query.trim() && ref ? [{ type: 'SearchReviewers' as const, ref, query: query.trim() }] : [];
      return { state: { ...state, query, found: query.trim() ? state.found : undefined }, cmds: search };
    }
    case 'ReviewersFound':
      return msg.query === state.query.trim()
        ? { state: { ...state, found: { query: msg.query, candidates: msg.candidates } }, cmds: [] }
        : { state, cmds: [] };
    case 'ReviewerAdded': {
      if (!ref || !pull || pull.reviewers?.some((reviewer) => reviewer.login === msg.who.login)) {
        return { state, cmds: [] };
      }
      const asked: Reviewer = { login: msg.who.login, state: 'pending', ...(msg.who.team ? { team: true } : {}) };
      return {
        ...send({ ...state, query: '', found: undefined, error: undefined }, ref, { add: [msg.who] }),
        pull: {
          ...pull,
          reviewers: [...(pull.reviewers ?? []), asked],
          suggestedReviewers: pull.suggestedReviewers?.filter((one) => one.login !== msg.who.login),
        },
      };
    }
    case 'ReviewerRemoved':
      if (!ref || !pull) {
        return { state, cmds: [] };
      }
      return {
        ...send({ ...state, error: undefined }, ref, { remove: [msg.who] }),
        pull: { ...pull, reviewers: pull.reviewers?.filter((reviewer) => reviewer.login !== msg.who.login) },
      };
    case 'ReviewersChanged':
    case 'ReviewersFailed': {
      const failed = msg.type === 'ReviewersFailed' ? { error: msg.error } : {};
      const [next, ...rest] = state.queued;
      if (next && ref) {
        // Newer picks are on screen already; this answer predates them.
        return {
          state: { ...state, ...failed, queued: rest },
          cmds: [{ type: 'ChangeReviewers', ref, ...next }],
        };
      }
      const done = { ...state, ...failed, sending: false, queued: [] };
      return msg.type === 'ReviewersFailed'
        ? { state: done, cmds: [], refetch: true }
        : {
            state: done,
            pull: pull && {
              ...pull,
              reviewers: msg.result.reviewers,
              suggestedReviewers: msg.result.suggestedReviewers,
            },
            cmds: [],
          };
    }
  }
}

/** Sends a change now, or after the one on its way. */
function send(state: ReviewersModel, ref: PullRef, change: Change): { state: ReviewersModel; cmds: ReviewersCmd[] } {
  return state.sending
    ? { state: { ...state, queued: [...state.queued, change] }, cmds: [] }
    : { state: { ...state, sending: true }, cmds: [{ type: 'ChangeReviewers', ref, ...change }] };
}

/**
 * The picker's rows: GitHub's suggestions (the backend has left out the viewer), then search
 * matches, each once and never someone already reviewing or the author.
 */
export function pickerRows(
  pull: StackMember,
  state: ReviewersModel,
): { suggested: StackMember['suggestedReviewers'] & {}; found: readonly ReviewerCandidate[] } {
  const taken = new Set([pull.author, ...(pull.reviewers ?? []).map((reviewer) => reviewer.login)]);
  const needle = state.query.trim().toLowerCase();
  const suggested = (pull.suggestedReviewers ?? []).filter(
    (one) => !taken.has(one.login) && (!needle || one.login.toLowerCase().includes(needle)),
  );
  const shown = new Set(suggested.map((one) => one.login));
  // Matches for an earlier query would let Enter ask someone the reader no longer means.
  const current = state.found?.query === state.query.trim() ? state.found.candidates : [];
  const found = needle ? current.filter((one) => !taken.has(one.login) && !shown.has(one.login)) : [];
  return { suggested, found };
}
