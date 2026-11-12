import type { DiffSide, FileChange, ReviewThread, SourceRef, ThreadComment } from '@gloss/protocol';

/**
 * The PR's comment threads already on GitHub: shown under their lines and listed in the
 * Comments panel. `updateThreads` is pure; the tour page's `update` hands it these messages
 * and runs the commands it returns.
 */

type PullRef = Extract<SourceRef, { kind: 'github-pr' }>;

export interface ThreadsModel {
  /** Undefined until GitHub has answered (and on a local diff, which has none). */
  list?: readonly ReviewThread[];
  /** The Comments panel, in the slot Ask's panel uses. */
  open: boolean;
  /** The panel lists resolved threads too. */
  showResolved: boolean;
  /** Folded threads the reader opened, and open ones they folded: resolved and outdated start folded. */
  toggled: ReadonlySet<string>;
  /** The reply being written. */
  replying?: { threadId: string; body: string; sent?: string };
  /** Threads waiting on GitHub (a reply or a resolve on its way). */
  busy: ReadonlySet<string>;
  /** The last thread action GitHub refused, shown on that thread. */
  error?: { threadId: string; message: string };
}

export const emptyThreads: ThreadsModel = { open: false, showResolved: false, toggled: new Set(), busy: new Set() };

export type ThreadsMsg =
  | { type: 'ThreadsLoaded'; threads: readonly ReviewThread[] }
  | { type: 'CommentsToggled' }
  | { type: 'CommentsClosed' }
  | { type: 'ResolvedShownToggled' }
  | { type: 'ThreadFoldToggled'; threadId: string }
  | { type: 'ReplyStarted'; threadId: string }
  | { type: 'ReplyChanged'; body: string }
  | { type: 'ReplyCancelled' }
  | { type: 'ReplySubmitted' }
  | { type: 'ReplySent'; threadId: string; comment: ThreadComment }
  | { type: 'ThreadResolveClicked'; threadId: string }
  | { type: 'ThreadResolved'; threadId: string; resolved: boolean }
  | { type: 'ThreadActionFailed'; threadId: string; error: string };

export type ThreadsCmd =
  | { type: 'FetchThreads'; ref: PullRef }
  | { type: 'ReplyToThread'; ref: PullRef; threadId: string; body: string }
  | { type: 'ResolveThread'; ref: PullRef; threadId: string; resolved: boolean };

/** Whether a thread shows folded to one row: resolved and outdated ones start folded, a click flips it. */
export const isFolded = (threads: ThreadsModel, thread: ReviewThread): boolean =>
  (thread.resolved || thread.outdated) !== threads.toggled.has(thread.id);

export const openThreads = (threads: ThreadsModel): number =>
  threads.list?.filter((thread) => !thread.resolved).length ?? 0;

const without = (set: ReadonlySet<string>, id: string) => new Set([...set].filter((item) => item !== id));
const withId = (set: ReadonlySet<string>, id: string) => new Set([...set, id]);

function mapThread(threads: ThreadsModel, id: string, f: (thread: ReviewThread) => ReviewThread): ThreadsModel {
  return { ...threads, list: threads.list?.map((thread) => (thread.id === id ? f(thread) : thread)) };
}

/** `ref` is the PR the page tours: no PR, no actions. */
export function updateThreads(
  threads: ThreadsModel,
  msg: ThreadsMsg,
  ref: PullRef | undefined,
): readonly [ThreadsModel, readonly ThreadsCmd[]] {
  switch (msg.type) {
    case 'ThreadsLoaded':
      return [{ ...threads, list: msg.threads }, []];
    case 'CommentsToggled':
      return [{ ...threads, open: !threads.open }, []];
    case 'CommentsClosed':
      return threads.open ? [{ ...threads, open: false }, []] : [threads, []];
    case 'ResolvedShownToggled':
      return [{ ...threads, showResolved: !threads.showResolved }, []];
    case 'ThreadFoldToggled': {
      const toggled = threads.toggled.has(msg.threadId)
        ? without(threads.toggled, msg.threadId)
        : withId(threads.toggled, msg.threadId);
      return [{ ...threads, toggled }, []];
    }
    case 'ReplyStarted':
      return ref
        ? [{ ...threads, replying: { threadId: msg.threadId, body: '' }, error: undefined }, []]
        : [threads, []];
    case 'ReplyChanged':
      return threads.replying ? [{ ...threads, replying: { ...threads.replying, body: msg.body } }, []] : [threads, []];
    case 'ReplyCancelled':
      return [{ ...threads, replying: undefined }, []];
    case 'ReplySubmitted': {
      const replying = threads.replying;
      if (!ref || !replying || !replying.body.trim() || threads.busy.has(replying.threadId)) {
        return [threads, []];
      }
      return [
        {
          ...threads,
          replying: { ...replying, sent: replying.body.trim() },
          busy: withId(threads.busy, replying.threadId),
          error: undefined,
        },
        [{ type: 'ReplyToThread', ref, threadId: replying.threadId, body: replying.body.trim() }],
      ];
    }
    case 'ReplySent': {
      const next = mapThread(threads, msg.threadId, (thread) => ({
        ...thread,
        comments: [...thread.comments, msg.comment],
      }));
      return [
        {
          ...next,
          busy: without(threads.busy, msg.threadId),
          // Words written while the reply was on its way stay in the box.
          replying:
            !threads.replying || threads.replying.threadId !== msg.threadId
              ? threads.replying
              : threads.replying.body.trim() === threads.replying.sent
                ? undefined
                : { threadId: msg.threadId, body: threads.replying.body },
        },
        [],
      ];
    }
    case 'ThreadResolveClicked': {
      const thread = threads.list?.find((candidate) => candidate.id === msg.threadId);
      if (!ref || !thread || threads.busy.has(thread.id)) {
        return [threads, []];
      }
      return [
        { ...threads, busy: withId(threads.busy, thread.id), error: undefined },
        [{ type: 'ResolveThread', ref, threadId: thread.id, resolved: !thread.resolved }],
      ];
    }
    case 'ThreadResolved': {
      // Resolving folds the thread away; unresolving opens it again.
      const next = mapThread(threads, msg.threadId, (thread) => ({ ...thread, resolved: msg.resolved }));
      return [
        { ...next, busy: without(threads.busy, msg.threadId), toggled: without(threads.toggled, msg.threadId) },
        [],
      ];
    }
    case 'ThreadActionFailed':
      return [
        {
          ...threads,
          replying: threads.replying && { threadId: threads.replying.threadId, body: threads.replying.body },
          busy: without(threads.busy, msg.threadId),
          error: { threadId: msg.threadId, message: msg.error },
        },
        [],
      ];
  }
}

/** The line numbers a file's diff shows on each side, so a thread off them goes with the file, not a line. */
export function shownLines(file: FileChange): Record<DiffSide, Set<number>> {
  const shown = { additions: new Set<number>(), deletions: new Set<number>() };
  for (const hunk of file.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const row of hunk.patch.split('\n')) {
      const kind = row[0];
      if (kind === '\\') {
        continue;
      }
      if (kind === '-') {
        shown.deletions.add(oldLine++);
      } else if (kind === '+') {
        shown.additions.add(newLine++);
      } else {
        // Context rows are on both sides; GitHub anchors a comment on one to the new side.
        shown.deletions.add(oldLine++);
        shown.additions.add(newLine++);
      }
    }
  }
  return shown;
}

/** A file's threads, split into those under a line of its diff and those that go with the file. */
export function placeThreads(
  threads: readonly ReviewThread[],
  file: FileChange | undefined,
): { onLines: ReviewThread[]; onFile: ReviewThread[] } {
  if (!file) {
    return { onLines: [], onFile: [...threads] };
  }
  const shown = shownLines(file);
  const onLines: ReviewThread[] = [];
  const onFile: ReviewThread[] = [];
  for (const thread of threads) {
    (thread.line !== undefined && shown[thread.side].has(thread.line) ? onLines : onFile).push(thread);
  }
  return { onLines, onFile };
}
