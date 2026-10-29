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

/**
 * What the scroll-spy read off the page: the group and file whose tops last crossed the
 * reading line. At the bottom of the page the last stops can never reach that line, so it
 * also lists the groups and files on screen there (`visible`), and a stop just jumped to
 * stays current while it is in view.
 */
export interface Spied {
  groupKey?: string;
  fileId?: string;
  visible?: { groupKeys: readonly string[]; fileIds: readonly string[] };
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
  /** A position from a reloaded or shared URL (or back/forward), until its section exists and has been scrolled to. */
  restoring?: Position;
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
  | { type: 'FileJumped'; fileId: string }
  | { type: 'FileStepped'; by: Step }
  | { type: 'NoteStepped'; by: Step }
  /** The reader scrolled (or the page moved under them): the position follows the page. */
  | { type: 'Scrolled'; spied: Spied }
  | { type: 'ExpandedToggled'; fileId: string }
  | { type: 'ViewedToggled'; fileId: string }
  /** `v`: marks the current file viewed and moves on, or unmarks it. */
  | { type: 'ActiveFileViewed' }
  | { type: 'NavToggled' }
  | { type: 'NavClosed' }
  | { type: 'HelpSet'; open: boolean }
  | { type: 'HelpToggled' }
  | { type: 'SidebarToggled'; node: string; deep: boolean }
  /** A click on a PR or group row: jumps there and unfolds it. */
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
  /** `diffId` is the diff the review was written on: an answer for an older one is ignored. */
  | { type: 'ReviewSent'; diffId: string; verdict: ReviewVerdict; url: string }
  | { type: 'ReviewFailed'; diffId: string; error: string }
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
  /**
   * A jump to a group (click, j/k, a link) pushes a history entry, so back/forward step
   * through the stops; scrolling and n/p replace it.
   */
  | { type: 'Navigate'; position: Position; replace: boolean }
  /** Jumps are instant: the reader is going there, not watching the page slide. */
  | { type: 'ScrollToTop' }
  | { type: 'ScrollToGroup'; key: string }
  /** After the next render, so an expanded file's header lands under the sticky bars. */
  | { type: 'ScrollToFile'; fileId: string }
  /** Scrolls to the group or file and holds it there while the page above it still grows. */
  | { type: 'RestoreGroup'; key: string }
  | { type: 'RestoreFile'; fileId: string }
  /** Reads the position off the page once it has rendered. */
  | { type: 'MeasurePosition' }
  | { type: 'StepNote'; by: Step }
  | { type: 'SetTitle'; title: string }
  | { type: 'LoadReview'; diffId: string }
  | { type: 'SaveReview'; diffId: string; saved: SavedReview }
  | { type: 'SubmitReview'; diffId: string; request: ReviewRequest };

export type Next = readonly [Model, readonly Cmd[]];

export function initialModel(ref: SourceRef, position: Position): Model {
  return {
    ref,
    connection: 'connecting',
    tour: initialTourState(),
    position,
    restoring: position.g !== undefined || position.f !== undefined ? position : undefined,
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

/** Every file down the page, in reading order: the groups in tour order, each riskiest first. */
export const fileOrder = (groups: readonly GroupView[]): string[] => groups.flatMap(orderedFileIds);

export const groupOfFile = (groups: readonly GroupView[], fileId: string): GroupView | undefined =>
  groups.find((group) => group.fileIds.includes(fileId));

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
  return next === model && cmds.length === 0 ? [model, cmds] : settle(model, next, cmds, msg.type === 'UrlChanged');
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
      return [{ ...model, position: { g, f }, restoring: { g, f } }, []];
    }
    case 'GroupSelected':
      return select(model, msg.key);
    case 'GroupStepped': {
      const groups = groupsOf(model);
      const stops = [OVERVIEW, ...groups.map((group) => group.key)];
      const target = stops[stops.indexOf(selectedKey(model, groups)) + msg.by];
      return target ? select(model, target) : [model, []];
    }
    case 'FileJumped':
      return jump(model, msg.fileId, true);
    case 'FileStepped':
      return stepFile(model, msg.by);
    case 'NoteStepped':
      return [model, [{ type: 'StepNote', by: msg.by }]];
    case 'Scrolled':
      return scrolled(model, msg.spied);
    case 'ExpandedToggled': {
      const file = model.tour.files.find((candidate) => candidate.id === msg.fileId);
      if (!file) {
        return [model, []];
      }
      const expanded = isFileExpanded(model, groupOfFile(groupsOf(model), file.id), file);
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
      // A row is a way to its place on the page, even the current one; its chevron folds it.
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
        ? [
            set({
              open: true,
              verdict: msg.verdict ?? review.verdict,
              problem: undefined,
              error: undefined,
              sent: undefined,
            }),
            [],
          ]
        : [model, []];
    case 'ReviewClosed':
      return review.open ? [set({ open: false }), []] : [model, []];
    case 'ReviewVerdictChanged':
      return [set({ verdict: msg.verdict, problem: undefined, error: undefined }), []];
    case 'ReviewBodyChanged':
      return save(set({ body: msg.body, problem: undefined }));
    case 'ReviewSubmitted': {
      const verdict = msg.verdict ?? review.verdict;
      const meta = model.tour.meta;
      const diffId = model.tour.diffId;
      if (model.ref.kind !== 'github-pr' || !meta || !diffId || review.sending) {
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
        return [set({ open: true, verdict, problem, sent: undefined }), []];
      }
      const sending = { body: review.body, ids: review.comments.map((comment) => comment.id) };
      return [
        set({ verdict, sending, problem: undefined, error: undefined, sent: undefined }),
        [{ type: 'SubmitReview', diffId, request }],
      ];
    }
    case 'ReviewSent': {
      if (msg.diffId !== model.tour.diffId || !review.sending) {
        return [model, []];
      }
      // Only what went out leaves the draft: words written while it was on its way stay.
      const sent = review.sending;
      return save(
        set({
          open: false,
          sending: undefined,
          body: review.body === sent?.body ? '' : review.body,
          comments: review.comments.filter((comment) => !sent?.ids.includes(comment.id)),
          sent: { verdict: msg.verdict, url: msg.url },
        }),
      );
    }
    case 'ReviewFailed':
      if (msg.diffId !== model.tour.diffId || !review.sending) {
        return [model, []];
      }
      return [set({ sending: undefined, open: true, error: msg.error }), []];
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

/** Jumps to a group (or the overview) on the page. */
function select(model: Model, key: string): Next {
  const position = { g: key === OVERVIEW ? undefined : key, f: undefined };
  return [
    { ...model, navOpen: false, position, activeFileId: undefined },
    [
      { type: 'Navigate', position, replace: false },
      key === OVERVIEW ? { type: 'ScrollToTop' } : { type: 'ScrollToGroup', key },
    ],
  ];
}

/** Jumps to a file, opening it; `push` makes a jump into another group a history entry. */
function jump(model: Model, fileId: string, push = false): Next {
  const group = groupOfFile(groupsOf(model), fileId);
  const moved = group !== undefined && group.key !== selectedKey(model);
  const position = moved ? { g: group.key, f: undefined } : model.position;
  return [
    {
      ...model,
      navOpen: false,
      position,
      activeFileId: fileId,
      expanded: { ...model.expanded, [fileId]: model.expanded[fileId] ?? true },
    },
    [
      ...(moved && push ? [{ type: 'Navigate', position, replace: false } as const] : []),
      { type: 'ScrollToFile', fileId },
    ],
  ];
}

/** n/p walk every file down the page, across groups. */
function stepFile(model: Model, by: Step): Next {
  const groups = groupsOf(model);
  const order = fileOrder(groups);
  const at = model.activeFileId ? order.indexOf(model.activeFileId) : -1;
  const first = orderedFileIds(currentGroup(model, groups))[0] ?? order[0];
  const target = at === -1 ? (by > 0 ? first : undefined) : order[at + by];
  return target ? jump(model, target) : [model, []];
}

/**
 * The position follows the page as it scrolls. A group with no file at the reading line yet
 * (its summary is) makes its first file current, so x and v work as soon as it is reached.
 */
function scrolled(model: Model, { groupKey, fileId, visible }: Spied): Next {
  // A position being restored is where the page is headed; what passes by on the way is not.
  if (model.restoring) {
    return [model, []];
  }
  const groups = groupsOf(model);
  const selected = selectedKey(model, groups);
  let key = groupKey ?? OVERVIEW;
  if (visible) {
    key = visible.groupKeys.includes(selected) ? selected : (visible.groupKeys.at(-1) ?? key);
  }
  const group = groups.find((candidate) => candidate.key === key);
  const order = orderedFileIds(group);
  const kept = model.activeFileId;
  const active =
    kept && visible?.fileIds.includes(kept) && order.includes(kept)
      ? kept
      : fileId && order.includes(fileId)
        ? fileId
        : order[0];
  const g = group?.key;
  if (g === currentGroup(model, groups)?.key && active === model.activeFileId) {
    return [model, []];
  }
  return [
    { ...model, position: g === model.position.g ? model.position : { g, f: undefined }, activeFileId: active },
    [],
  ];
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
 * unfold the sidebar to the current group, restore a position from the URL once it can be
 * shown, mirror the position into the URL, and keep the title.
 */
function settle(prev: Model | undefined, model: Model, cmds: readonly Cmd[], fromUrl = false): Next {
  let next = model;
  let out = [...cmds];
  const groups = groupsOf(next);
  const current = currentGroup(next, groups);
  const selected = current?.key ?? OVERVIEW;
  const prevGroups = prev && (prev.tour === next.tour ? groups : groupsOf(prev));
  const prevCurrent = prev && currentGroup(prev, prevGroups);
  const prevSelected = prev && (prevCurrent?.key ?? OVERVIEW);

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

  // Reaching a group (a jump, scrolling into it, history) unfolds the sidebar to it.
  if (prevSelected !== selected || prevCurrent?.category !== current?.category) {
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
    const [restored, more] = restore(next);
    next = restored;
    out.push(...more);
  }

  const scrolling = out.some((cmd) => SCROLLS.has(cmd.type));
  const order = fileOrder(groups);
  const prevOrder = prev ? fileOrder(prevGroups ?? []) : [];
  // The page grew or shrank under the reader (groups and hunks stream in): read where they are now.
  if (!scrolling && !next.restoring && (prevOrder.length !== order.length || prev?.diff !== next.diff)) {
    out.push({ type: 'MeasurePosition' });
  }

  // The file in view goes in the URL. A group's first file is left out: restoring it would
  // scroll past the group summary.
  if (!next.restoring) {
    const groupOrder = orderedFileIds(currentGroup(next, groups));
    const active = next.activeFileId;
    const f = active && groupOrder.includes(active) && active !== groupOrder[0] ? active : undefined;
    if (f !== next.position.f) {
      next = { ...next, position: { ...next.position, f } };
    }
  }
  // One URL write per change: a jump's history entry carries where it landed; anything else replaces.
  const navigations = out.filter((cmd) => cmd.type === 'Navigate');
  out = out.filter((cmd) => cmd.type !== 'Navigate');
  if (prev && !fromUrl && !samePosition(prev.position, next.position)) {
    const replace = navigations.every((cmd) => cmd.replace);
    out.push({ type: 'Navigate', position: next.position, replace });
  }

  const title = pageTitle(next);
  if (!prev || pageTitle(prev) !== title) {
    out.push({ type: 'SetTitle', title });
  }
  return [next, out];
}

const SCROLLS: ReadonlySet<Cmd['type']> = new Set([
  'ScrollToTop',
  'ScrollToGroup',
  'ScrollToFile',
  'RestoreGroup',
  'RestoreFile',
]);

const samePosition = (a: Position, b: Position) => a.g === b.g && a.f === b.f;

/**
 * A file or group from the URL, once its section is on the page. Waits for the diff too:
 * files above it grow when their hunks arrive and would push it away. Gives up once a
 * finished tour turns out not to have it.
 */
function restore(model: Model): Next {
  const { g, f } = model.restoring ?? {};
  const groups = groupsOf(model);
  const settled = { ...model, restoring: undefined };
  const finished = model.tour.status !== 'idle' && !isRunning(model);
  if (f !== undefined) {
    const shown = fileOrder(groups).includes(f) && model.tour.files.some((file) => file.id === f);
    if (shown && model.diff) {
      const [jumped] = jump(settled, f);
      return [{ ...jumped, position: { ...jumped.position, f } }, [{ type: 'RestoreFile', fileId: f }]];
    }
    return [!shown && finished ? settled : model, []];
  }
  if (g === undefined) {
    return [{ ...settled, activeFileId: undefined }, [{ type: 'ScrollToTop' }]];
  }
  const shown = groups.some((group) => group.key === g);
  if (shown && model.diff) {
    return [{ ...settled, activeFileId: undefined }, [{ type: 'RestoreGroup', key: g }]];
  }
  return [!shown && finished ? settled : model, []];
}
