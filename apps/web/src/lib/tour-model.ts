import type {
  DiffPayload,
  FileSummary,
  GroupView,
  ReviewRequest,
  ReviewVerdict,
  SourceRef,
  TourEvent,
  TourState,
} from '@gloss/protocol';
import { describeRef, groupsInOrder, initialTourState, reduceTourEvent, reviewProblem } from '@gloss/protocol';
import {
  type CommentAnchor,
  emptyReview,
  type ReviewDraft,
  type SavedReview,
  toReviewComments,
} from './review-draft.ts';
import {
  categoryNode,
  groupNode,
  initialSidebar,
  isNodeOpen,
  type Nesting,
  PR_NODE,
  setNodesOpen,
  type SidebarState,
  STACK_NODE,
  toggleNode,
} from './sidebar-tree.ts';
import { defaultExpanded, isGeneratedFile, OVERVIEW, orderedFileIds } from './tour-view.ts';

/**
 * The tour page as an Elm program: one `Model`, changed only by `update`. Everything the
 * page does to the outside (the backend, the URL, scrolling, storage, the title) is a
 * `Cmd`, run by `tour-program.ts`.
 */

export type Connection = 'connecting' | 'streaming' | 'closed' | 'error';

export interface ConnectionError {
  title: string;
  message: string;
}

/** Where the reader is, as in the URL: `g` group key, `f` file id. */
export interface Position {
  g?: string;
  f?: string;
}

export interface Model {
  ref: SourceRef;
  connection: Connection;
  connectionError?: ConnectionError;
  jobId?: string;
  tour: TourState;
  diff?: DiffPayload;
  /** The diff last asked for, so each one is fetched once. */
  diffRequested?: string;
  position: Position;
  /** A file from a reloaded or shared URL (or back/forward), until its section exists and has been scrolled to. */
  restoring?: string;
  /** The file at the reading line (scroll-spy), or the one just jumped to. */
  activeFileId?: string;
  /** Files the reader expanded or collapsed themselves. */
  expanded: Readonly<Record<string, boolean>>;
  /** Files marked viewed, kept per diff in this browser. */
  viewed: ReadonlySet<string>;
  navOpen: boolean;
  helpOpen: boolean;
  sidebar: SidebarState;
  /** The GitHub review being written (PRs only). */
  review: ReviewDraft;
  /** The first key of a two-key shortcut (`r a`), until the second arrives. */
  chord?: 'r';
}

export type Step = 1 | -1;

export type Msg =
  | { type: 'TourStarted'; jobId: string }
  | { type: 'EventReceived'; event: TourEvent }
  | { type: 'StreamClosed' }
  | { type: 'StreamFailed'; error: ConnectionError }
  | { type: 'DiffLoaded'; diff: DiffPayload }
  | { type: 'ViewedLoaded'; diffId: string; fileIds: readonly string[] }
  | { type: 'RerunClicked' }
  | { type: 'StopClicked' }
  | { type: 'UrlChanged'; position: Position }
  | { type: 'GroupSelected'; key: string }
  | { type: 'GroupStepped'; by: Step }
  /** `groupKey` opens that group first (a file row under another group in the sidebar). */
  | { type: 'FileJumped'; fileId: string; groupKey?: string }
  | { type: 'FileStepped'; by: Step }
  | { type: 'NoteStepped'; by: Step }
  | { type: 'ActiveFileChanged'; fileId: string | undefined }
  | { type: 'ExpandedToggled'; fileId: string }
  | { type: 'ViewedToggled'; fileId: string }
  /** `v`: marks the current file viewed and moves on, or unmarks it. */
  | { type: 'ActiveFileViewed' }
  | { type: 'NavToggled' }
  | { type: 'NavClosed' }
  | { type: 'HelpSet'; open: boolean }
  | { type: 'HelpToggled' }
  | { type: 'SidebarToggled'; node: string; deep: boolean }
  /** A click on a PR or group row: opens it, or folds it when it is already the selection. */
  | { type: 'SidebarActivated'; node: string; key: string }
  | { type: 'NestingChanged'; nesting: Nesting }
  | { type: 'QueryChanged'; query: string }
  /**
   * A key outside any text field, read against the model when it is handled: the second key
   * of a chord can arrive before the first has reached the model the keyboard sees.
   */
  | { type: 'KeyPressed'; key: string }
  | { type: 'ChordStarted'; chord: 'r' }
  | { type: 'ChordCancelled' }
  | { type: 'ReviewLoaded'; diffId: string; saved: SavedReview }
  /** Opens the review panel on a verdict (`r a`, `r n`, `r c`, or the Review button). */
  | { type: 'ReviewOpened'; verdict?: ReviewVerdict }
  | { type: 'ReviewClosed' }
  | { type: 'ReviewVerdictChanged'; verdict: ReviewVerdict }
  | { type: 'ReviewBodyChanged'; body: string }
  /** Sends the review; `verdict` sends it as that without the panel (`r y`). */
  | { type: 'ReviewSubmitted'; verdict?: ReviewVerdict }
  | { type: 'ReviewSent'; verdict: ReviewVerdict; url: string }
  | { type: 'ReviewFailed'; error: string }
  | { type: 'ReviewNoticeDismissed' }
  | { type: 'CommentStarted'; anchor: CommentAnchor }
  | { type: 'CommentEdited'; id: string }
  | { type: 'CommentBodyChanged'; body: string }
  | { type: 'CommentCancelled' }
  | { type: 'CommentSaved' }
  | { type: 'CommentRemoved'; id: string };

export type Cmd =
  | { type: 'StartTour'; ref: SourceRef; force: boolean }
  | { type: 'AbortTour'; jobId: string }
  | { type: 'FetchDiff'; diffId: string }
  | { type: 'LoadViewed'; diffId: string }
  | { type: 'SaveViewed'; diffId: string; fileIds: readonly string[] }
  /** A group change pushes a history entry (back/forward step through groups); a file change replaces it. */
  | { type: 'Navigate'; position: Position; replace: boolean }
  | { type: 'ScrollToTop' }
  /** After the next render, so an expanded file's header lands under the sticky bars. */
  | { type: 'ScrollToFile'; fileId: string }
  /** Scrolls to the file and holds it there while the page above it still grows. */
  | { type: 'RestoreFile'; fileId: string }
  /** Reads the file at the reading line once the page has rendered. */
  | { type: 'MeasureActiveFile' }
  | { type: 'StepNote'; by: Step }
  | { type: 'SetTitle'; title: string }
  | { type: 'LoadReview'; diffId: string }
  | { type: 'SaveReview'; diffId: string; saved: SavedReview }
  | { type: 'SubmitReview'; request: ReviewRequest };

export type Next = readonly [Model, readonly Cmd[]];

export function initialModel(ref: SourceRef, position: Position): Model {
  return {
    ref,
    connection: 'connecting',
    tour: initialTourState(),
    position,
    restoring: position.f,
    expanded: {},
    viewed: new Set(),
    navOpen: false,
    helpOpen: false,
    sidebar: initialSidebar,
    review: emptyReview,
  };
}

export function init(ref: SourceRef, position: Position): Next {
  const model = initialModel(ref, position);
  return settle(undefined, model, [{ type: 'StartTour', ref, force: false }]);
}

export const groupsOf = (model: Model): GroupView[] => groupsInOrder(model.tour);

/** The open group; a group can disappear while streaming (provisional groups give way to the model's), leaving the overview. */
export function currentGroup(model: Model, groups = groupsOf(model)): GroupView | undefined {
  return groups.find((group) => group.key === (model.position.g ?? OVERVIEW));
}

export const selectedKey = (model: Model, groups = groupsOf(model)): string =>
  currentGroup(model, groups)?.key ?? OVERVIEW;

/** Reviews go to GitHub, so only a PR with its diff loaded can be reviewed. */
export const canReview = (model: Model): boolean => model.ref.kind === 'github-pr' && model.tour.meta !== undefined;

export const isRunning = (model: Model): boolean =>
  model.tour.status === 'running' || model.connection === 'connecting';

export function pageTitle(model: Model): string {
  return [currentGroup(model)?.label, model.tour.meta?.title ?? describeRef(model.ref), 'gloss']
    .filter(Boolean)
    .join(' · ');
}

export function isFileExpanded(
  model: Pick<Model, 'expanded' | 'viewed'>,
  group: GroupView | undefined,
  file: FileSummary,
): boolean {
  return model.expanded[file.id] ?? defaultExpanded(file, isGeneratedFile(group, file), model.viewed.has(file.id));
}

/** Keys typed into these elements are text, not shortcuts. */
export const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** Keys that may be shortcuts, so the browser's own use of them is held back. */
export const SHORTCUT_KEYS: ReadonlySet<string> = new Set('jkonp][xv?rayc');

/** The shortcut for a key (listed in ShortcutHelp), or undefined to leave the key alone. */
export function keyToMsg(model: Model, key: string): Msg | undefined {
  if ((model.helpOpen && key !== '?') || model.review.open) {
    return undefined;
  }
  if (model.chord === 'r') {
    // Graphite's review chords.
    switch (key) {
      case 'a':
        return { type: 'ReviewOpened', verdict: 'APPROVE' };
      case 'y':
        return { type: 'ReviewSubmitted', verdict: 'APPROVE' };
      case 'n':
        return { type: 'ReviewOpened', verdict: 'REQUEST_CHANGES' };
      case 'c':
        return { type: 'ReviewOpened', verdict: 'COMMENT' };
      default:
        return { type: 'ChordCancelled' };
    }
  }
  const active = model.activeFileId;
  switch (key) {
    case 'r':
      return canReview(model) && !model.review.sending ? { type: 'ChordStarted', chord: 'r' } : undefined;
    case 'j':
      return { type: 'GroupStepped', by: 1 };
    case 'k':
      return { type: 'GroupStepped', by: -1 };
    case 'o':
      return { type: 'GroupSelected', key: OVERVIEW };
    case 'n':
      return { type: 'FileStepped', by: 1 };
    case 'p':
      return { type: 'FileStepped', by: -1 };
    case ']':
      return { type: 'NoteStepped', by: 1 };
    case '[':
      return { type: 'NoteStepped', by: -1 };
    case 'x':
      return active ? { type: 'ExpandedToggled', fileId: active } : undefined;
    case 'v':
      return active ? { type: 'ActiveFileViewed' } : undefined;
    case '?':
      return { type: 'HelpToggled' };
    case 'Escape':
      return model.navOpen ? { type: 'NavClosed' } : undefined;
    default:
      return undefined;
  }
}

export function update(model: Model, msg: Msg): Next {
  const [next, cmds] = step(model, msg);
  return next === model && cmds.length === 0 ? [model, cmds] : settle(model, next, cmds);
}

function step(model: Model, msg: Msg): Next {
  switch (msg.type) {
    case 'TourStarted':
      return [{ ...model, jobId: msg.jobId, connection: 'streaming' }, []];
    case 'EventReceived':
      return [{ ...model, tour: reduceTourEvent(model.tour, msg.event) }, []];
    case 'StreamClosed':
      return [{ ...model, connection: 'closed' }, []];
    case 'StreamFailed':
      return [{ ...model, connection: 'error', connectionError: msg.error }, []];
    case 'DiffLoaded':
      return msg.diff.id === model.tour.diffId ? [{ ...model, diff: msg.diff }, []] : [model, []];
    case 'ViewedLoaded':
      return msg.diffId === model.tour.diffId ? [{ ...model, viewed: new Set(msg.fileIds) }, []] : [model, []];
    case 'RerunClicked':
      return [
        { ...model, connection: 'connecting', connectionError: undefined },
        [{ type: 'StartTour', ref: model.ref, force: true }],
      ];
    case 'StopClicked':
      return [model, model.jobId ? [{ type: 'AbortTour', jobId: model.jobId }] : []];
    case 'UrlChanged': {
      const { g, f } = msg.position;
      if (g === model.position.g && f === model.position.f) {
        return [model, []];
      }
      return [{ ...model, position: { g, f }, restoring: f !== model.position.f ? f : model.restoring }, []];
    }
    case 'GroupSelected':
      return select(model, msg.key);
    case 'GroupStepped': {
      const groups = groupsOf(model);
      const stops = [OVERVIEW, ...groups.map((group) => group.key)];
      const target = stops[stops.indexOf(selectedKey(model, groups)) + msg.by];
      return target ? select(model, target) : [model, []];
    }
    case 'FileJumped': {
      if (msg.groupKey === undefined || msg.groupKey === selectedKey(model)) {
        return jump(model, msg.fileId);
      }
      const [selected, cmds] = select(model, msg.groupKey);
      const [jumped, more] = jump(selected, msg.fileId);
      return [jumped, [...cmds, ...more]];
    }
    case 'FileStepped':
      return stepFile(model, msg.by);
    case 'NoteStepped':
      return [model, [{ type: 'StepNote', by: msg.by }]];
    case 'ActiveFileChanged':
      return msg.fileId === model.activeFileId ? [model, []] : [{ ...model, activeFileId: msg.fileId }, []];
    case 'ExpandedToggled': {
      const file = model.tour.files.find((candidate) => candidate.id === msg.fileId);
      if (!file) {
        return [model, []];
      }
      const expanded = isFileExpanded(model, currentGroup(model), file);
      return [{ ...model, expanded: { ...model.expanded, [msg.fileId]: !expanded } }, []];
    }
    case 'ViewedToggled':
      return toggleViewed(model, msg.fileId);
    case 'ActiveFileViewed': {
      const fileId = model.activeFileId;
      if (!fileId) {
        return [model, []];
      }
      const wasViewed = model.viewed.has(fileId);
      const [toggled, cmds] = toggleViewed(model, fileId);
      if (wasViewed) {
        return [toggled, cmds];
      }
      const [stepped, more] = stepFile(toggled, 1);
      return [stepped, [...cmds, ...more]];
    }
    case 'NavToggled':
      return [{ ...model, navOpen: !model.navOpen }, []];
    case 'NavClosed':
      return model.navOpen ? [{ ...model, navOpen: false }, []] : [model, []];
    case 'HelpSet':
      return model.helpOpen === msg.open ? [model, []] : [{ ...model, helpOpen: msg.open }, []];
    case 'HelpToggled':
      return [{ ...model, helpOpen: !model.helpOpen }, []];
    case 'SidebarToggled':
      return [{ ...model, sidebar: toggleNode(model.sidebar, groupsOf(model), msg.node, msg.deep) }, []];
    case 'SidebarActivated': {
      if (selectedKey(model) === msg.key && isNodeOpen(model.sidebar, msg.node)) {
        return [{ ...model, sidebar: setNodesOpen(model.sidebar, [msg.node], false) }, []];
      }
      const [selected, cmds] = select(model, msg.key);
      return [{ ...selected, sidebar: setNodesOpen(selected.sidebar, [msg.node], true) }, cmds];
    }
    case 'NestingChanged':
      return [{ ...model, sidebar: { ...model.sidebar, nesting: msg.nesting } }, []];
    case 'QueryChanged':
      return [{ ...model, sidebar: { ...model.sidebar, query: msg.query } }, []];
    case 'KeyPressed': {
      const action = keyToMsg(model, msg.key);
      return action ? step(model, action) : [model, []];
    }
    case 'ChordStarted':
      return [{ ...model, chord: msg.chord }, []];
    case 'ChordCancelled':
      return model.chord ? [{ ...model, chord: undefined }, []] : [model, []];
    default:
      return stepReview(model.chord ? { ...model, chord: undefined } : model, msg);
  }
}

/** The review: a panel for the verdict and summary, and line comments that wait in it until it is sent. */
function stepReview(model: Model, msg: Msg): Next {
  const review = model.review;
  const set = (patch: Partial<ReviewDraft>): Model => ({ ...model, review: { ...review, ...patch } });
  switch (msg.type) {
    case 'ReviewLoaded':
      return msg.diffId === model.tour.diffId
        ? [set({ body: msg.saved.body, comments: msg.saved.comments }), []]
        : [model, []];
    case 'ReviewOpened':
      return canReview(model)
        ? [set({ open: true, verdict: msg.verdict ?? review.verdict, error: undefined }), []]
        : [model, []];
    case 'ReviewClosed':
      return review.open ? [set({ open: false }), []] : [model, []];
    case 'ReviewVerdictChanged':
      return [set({ verdict: msg.verdict, error: undefined }), []];
    case 'ReviewBodyChanged':
      return save(set({ body: msg.body }));
    case 'ReviewSubmitted': {
      const verdict = msg.verdict ?? review.verdict;
      const meta = model.tour.meta;
      if (model.ref.kind !== 'github-pr' || !meta || review.sending) {
        return [model, []];
      }
      const request: ReviewRequest = {
        owner: model.ref.owner,
        repo: model.ref.repo,
        number: model.ref.number,
        verdict,
        body: review.body,
        comments: toReviewComments(review.comments),
        commitId: meta.headSha,
      };
      const problem = reviewProblem(request);
      if (problem) {
        return [set({ open: true, verdict, error: problem }), []];
      }
      return [set({ verdict, sending: true, error: undefined }), [{ type: 'SubmitReview', request }]];
    }
    case 'ReviewSent':
      // The words went out with it; a half-written line comment stays.
      return save({
        ...model,
        review: { ...emptyReview, composing: review.composing, sent: { verdict: msg.verdict, url: msg.url } },
      });
    case 'ReviewFailed':
      return [set({ sending: false, open: true, error: msg.error }), []];
    case 'ReviewNoticeDismissed':
      return [set({ sent: undefined }), []];
    case 'CommentStarted':
      return canReview(model) ? [set({ composing: { ...msg.anchor, body: '' } }), []] : [model, []];
    case 'CommentEdited': {
      const draft = review.comments.find((comment) => comment.id === msg.id);
      return draft ? [set({ composing: { ...draft, editing: draft.id } }), []] : [model, []];
    }
    case 'CommentBodyChanged':
      return review.composing ? [set({ composing: { ...review.composing, body: msg.body } }), []] : [model, []];
    case 'CommentCancelled':
      return review.composing ? [set({ composing: undefined }), []] : [model, []];
    case 'CommentSaved': {
      const composing = review.composing;
      const path = composing && model.tour.files.find((file) => file.id === composing.fileId)?.path;
      if (!composing || !path || !composing.body.trim()) {
        return [model, []];
      }
      const { editing, ...anchor } = composing;
      const draft = { ...anchor, id: editing ?? `${anchor.fileId}:${anchor.side}:${anchor.line}:${Date.now()}`, path };
      const comments = editing
        ? review.comments.map((comment) => (comment.id === editing ? draft : comment))
        : [...review.comments, draft];
      return save(set({ comments, composing: undefined }));
    }
    case 'CommentRemoved':
      return save(set({ comments: review.comments.filter((comment) => comment.id !== msg.id) }));
    default:
      return [model, []];
  }
}

/** Keeps the review's words in this browser, per diff, so a reload does not lose them. */
function save(model: Model): Next {
  const diffId = model.tour.diffId;
  const { body, comments } = model.review;
  return [model, diffId ? [{ type: 'SaveReview', diffId, saved: { body, comments } }] : []];
}

function select(model: Model, key: string): Next {
  const position = { g: key === OVERVIEW ? undefined : key, f: undefined };
  return [{ ...model, navOpen: false, position }, [{ type: 'Navigate', position, replace: false }]];
}

function jump(model: Model, fileId: string): Next {
  return [
    {
      ...model,
      navOpen: false,
      activeFileId: fileId,
      expanded: { ...model.expanded, [fileId]: model.expanded[fileId] ?? true },
    },
    [{ type: 'ScrollToFile', fileId }],
  ];
}

function stepFile(model: Model, by: Step): Next {
  const order = orderedFileIds(currentGroup(model));
  const at = model.activeFileId ? order.indexOf(model.activeFileId) : -1;
  const target = order[at === -1 ? (by > 0 ? 0 : -1) : at + by];
  return target ? jump(model, target) : [model, []];
}

function toggleViewed(model: Model, fileId: string): Next {
  const viewed = new Set(model.viewed);
  if (!viewed.delete(fileId)) {
    viewed.add(fileId);
  }
  // Back to the default for the new viewed state: viewed files collapse, unviewed reopen.
  const { [fileId]: _, ...expanded } = model.expanded;
  const diffId = model.tour.diffId;
  return [{ ...model, viewed, expanded }, diffId ? [{ type: 'SaveViewed', diffId, fileIds: [...viewed] }] : []];
}

/**
 * What follows from any change, whatever caused it: fetch a new diff, load its viewed files,
 * reset scrolling when the selection changes, unfold the sidebar to it, restore a file from
 * the URL once it can be shown, mirror the current file into the URL, and keep the title.
 */
function settle(prev: Model | undefined, model: Model, cmds: readonly Cmd[]): Next {
  let next = model;
  const out = [...cmds];
  const groups = groupsOf(next);
  const current = currentGroup(next, groups);
  const selected = current?.key ?? OVERVIEW;
  const prevGroups = prev && (prev.tour === next.tour ? groups : groupsOf(prev));
  const prevCurrent = prev && currentGroup(prev, prevGroups);
  const prevSelected = prev && (prevCurrent?.key ?? OVERVIEW);
  const order = orderedFileIds(current);

  const diffId = next.tour.diffId;
  if (diffId && next.diff?.id !== diffId && next.diffRequested !== diffId) {
    next = { ...next, diffRequested: diffId };
    out.push({ type: 'FetchDiff', diffId });
  }
  if (diffId && prev?.tour.diffId !== diffId) {
    out.push({ type: 'LoadViewed', diffId }, { type: 'LoadReview', diffId });
    // A draft belongs to the lines of the diff it was written on (and stays saved under it).
    if (prev?.tour.diffId) {
      next = { ...next, review: { ...emptyReview, sent: next.review.sent } };
    }
  }

  const selectionChanged = prevSelected !== selected;
  // A new group starts at the top, unless this change also jumped to one of its files.
  if (selectionChanged && !out.some((cmd) => cmd.type === 'ScrollToFile')) {
    next = { ...next, activeFileId: undefined };
    out.push({ type: 'ScrollToTop' });
  }
  // Selecting a group (click, j/k, a link in the panel, history) unfolds the path to it.
  if (selectionChanged || prevCurrent?.category !== current?.category) {
    next = {
      ...next,
      sidebar: setNodesOpen(
        next.sidebar,
        current ? [STACK_NODE, PR_NODE, categoryNode(current.category), groupNode(current.key)] : [STACK_NODE, PR_NODE],
        true,
      ),
    };
  }

  if (next.restoring) {
    const fileId = next.restoring;
    const shown = order.includes(fileId) && next.tour.files.some((file) => file.id === fileId);
    // Wait for the diff too: files above it grow when their hunks arrive and would push it away.
    if (shown && next.diff) {
      const [jumped] = jump({ ...next, restoring: undefined }, fileId);
      next = jumped;
      out.push({ type: 'RestoreFile', fileId });
    } else if (!shown && next.tour.status !== 'idle' && !isRunning(next)) {
      next = { ...next, restoring: undefined };
    }
  }

  const jumping = out.some((cmd) => cmd.type === 'ScrollToFile' || cmd.type === 'RestoreFile');
  const prevOrder = prev ? orderedFileIds(prevCurrent) : [];
  if (!jumping && (selectionChanged || prevOrder.length !== order.length || prev?.diff !== next.diff)) {
    out.push({ type: 'MeasureActiveFile' });
  }

  // The file in view replaces the URL entry. The group's first file is left out: restoring it
  // would scroll past the group summary. A file not in this group is a leftover from the last one.
  const active = next.activeFileId;
  if (!next.restoring && current && !(active && !order.includes(active))) {
    const f = active === order[0] ? undefined : active;
    if (f !== next.position.f) {
      next = { ...next, position: { ...next.position, f } };
      out.push({ type: 'Navigate', position: { f }, replace: true });
    }
  }

  const title = pageTitle(next);
  if (!prev || pageTitle(prev) !== title) {
    out.push({ type: 'SetTitle', title });
  }
  return [next, out];
}
