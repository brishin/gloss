import type {
  Category,
  FileSummary,
  GroupView,
  PullState,
  RecentTour,
  RecentTours,
  SourceRef,
  Stack,
} from '@gloss/protocol';
import { serializeRef } from '@gloss/protocol';
import { bestStand, inboxFacts, type Move, type Stand, standOf } from './dashboard.ts';

/** Sidebar tree node ids: the PR's stack, the toured PR and its groups. */
export const STACK_NODE = 'stack';
export const PR_NODE = 'pr';
export const groupNode = (key: string) => `group:${key}`;
export const recentStackNode = (key: string) => `recent-stack:${key}`;
/** Shows the viewer's drafts in the rail; folded until opened. */
export const DRAFTS_NODE = 'closed:drafts';
/** Shows a stack's merged and closed PRs; folded (hidden) until opened. */
export const closedNode = (stackNode: string) => `closed:${stackNode}`;

export const CATEGORY_LABEL: Record<Category, string> = {
  ui: 'UI',
  api: 'API',
  core: 'Core',
  data: 'Data',
  cli: 'CLI',
  security: 'Security',
  tests: 'Tests',
  docs: 'Docs',
  examples: 'Examples',
  deps: 'Dependencies',
  build: 'Build',
  scripts: 'Scripts',
  config: 'Config',
  i18n: 'i18n',
  assets: 'Assets',
  other: 'Other',
};

/**
 * The files the sidebar filter keeps per group, or `undefined` with no filter. A group whose
 * label matches keeps all its files; otherwise it keeps the files whose path matches, and
 * drops out when none do.
 */
export function filterGroups(
  groups: GroupView[],
  files: ReadonlyMap<string, FileSummary>,
  query: string,
): Map<string, string[]> | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return undefined;
  }
  const kept = new Map<string, string[]>();
  for (const group of groups) {
    const fileIds = group.label.toLowerCase().includes(needle)
      ? group.fileIds
      : group.fileIds.filter((id) => files.get(id)?.path.toLowerCase().includes(needle));
    if (fileIds.length) {
      kept.set(group.key, fileIds);
    }
  }
  return kept;
}

export function countViewed(fileIds: readonly string[], viewed: ReadonlySet<string>): number {
  return fileIds.filter((id) => viewed.has(id)).length;
}

/** The sidebar's own state: the nodes the reader folded or opened, and the filter. */
export interface SidebarState {
  folded: ReadonlySet<string>;
  opened: ReadonlySet<string>;
  query: string;
}

export const initialSidebar: SidebarState = { folded: new Set(), opened: new Set(), query: '' };

/** PR and stacks start open; groups and closed PRs start folded; a filter opens everything it keeps. */
export function isNodeOpen(sidebar: SidebarState, id: string): boolean {
  return (
    sidebar.query.trim() !== '' ||
    (id.startsWith('group:') || id.startsWith('closed:')
      ? sidebar.opened.has(id) && !sidebar.folded.has(id)
      : !sidebar.folded.has(id))
  );
}

export function setNodesOpen(sidebar: SidebarState, ids: readonly string[], open: boolean): SidebarState {
  const opened = new Set(sidebar.opened);
  const folded = new Set(sidebar.folded);
  for (const id of ids) {
    if (open) {
      opened.add(id);
      folded.delete(id);
    } else {
      opened.delete(id);
      folded.add(id);
    }
  }
  return { ...sidebar, opened, folded };
}

/** Folds or unfolds one node; `deep` does the same to every node under it. */
export function toggleNode(
  sidebar: SidebarState,
  groups: readonly GroupView[],
  id: string,
  deep: boolean,
): SidebarState {
  const open = !isNodeOpen(sidebar, id);
  const groupNodes = groups.map((group) => groupNode(group.key));
  const below = id === STACK_NODE ? [PR_NODE, ...groupNodes] : id === PR_NODE ? groupNodes : [];
  return setNodesOpen(sidebar, deep ? [id, ...below] : [id], open);
}

/** The ref of each PR in a stack. */
export function stackRefs(stack: Stack): SourceRef[] {
  return stack.members.map((member) => ({
    kind: 'github-pr',
    owner: stack.owner,
    repo: stack.repo,
    number: member.number,
  }));
}

/** A row below the toured PR: another recent tour, or a stack holding one or more of them. */
export type RecentEntry =
  | { kind: 'tour'; tour: RecentTour }
  /** `updatedAt` is the tour the stack came from, for when no inbox data dates its PRs. */
  | { kind: 'stack'; key: string; stack: Stack; updatedAt: string };

/**
 * Recent tours as sidebar rows, newest first. A tour in a stack of two or more becomes that
 * stack's row, placed where its newest member was; later members fold into it. `skip` holds
 * the refs already shown (the toured PR and its stack); recorded stacks can be stale, so one
 * that overlaps a row already shown is dropped and its tour shown alone.
 */
export function recentEntries(recent: readonly RecentTour[], skip: ReadonlySet<string>): RecentEntry[] {
  const entries: RecentEntry[] = [];
  const shown = new Set(skip);
  for (const tour of recent) {
    const key = serializeRef(tour.ref);
    if (shown.has(key)) {
      continue;
    }
    const { stack } = tour;
    const members = stack && stack.members.length > 1 ? stackRefs(stack).map(serializeRef) : [];
    // A stale stack that overlaps rows already shown would show a PR twice: keep the tour alone.
    if (!stack || members.length === 0 || members.some((member) => shown.has(member))) {
      shown.add(key);
      entries.push({ kind: 'tour', tour });
      continue;
    }
    for (const member of members) {
      shown.add(member);
    }
    entries.push({ kind: 'stack', key, stack, updatedAt: tour.updatedAt });
  }
  return entries;
}

/**
 * Splits recent rows into the viewer's and others'. A stack is the viewer's when any of its PRs
 * is; a local diff, or a PR whose author is unknown, counts as theirs. Without a viewer nothing
 * is split.
 */
export function splitByViewer(
  entries: readonly RecentEntry[],
  viewer: string | undefined,
): { mine: RecentEntry[]; others: RecentEntry[] } {
  const isMine = (entry: RecentEntry) =>
    !viewer ||
    (entry.kind === 'stack'
      ? entry.stack.members.some((member) => member.author === viewer)
      : entry.tour.ref.kind === 'local' || !entry.tour.author || entry.tour.author === viewer);
  return { mine: entries.filter(isMine), others: entries.filter((entry) => !isMine(entry)) };
}

export const isClosed = (state: PullState | undefined) => state === 'merged' || state === 'closed';

/** The rows below the toured PR's stack, by section. Each PR shows once, in the first section that has it. */
export interface RailSections {
  /** Inbox rows where the viewer acts next: reviews asked of them, and their PRs that are failing, discussed or approved. */
  yourMove: RecentEntry[];
  /** Inbox rows waiting on someone else. */
  waiting: RecentEntry[];
  /** The viewer's draft PRs (a stack only when all its open PRs are drafts). */
  drafts: RecentEntry[];
  /** Other recent tours that are still open (and local diffs); all of them when GitHub could not list the inbox. */
  recent: RecentEntry[];
}

/** Where a row stands: a stack by its most pressing open PR. */
export function entryStand(entry: RecentEntry, recent: RecentTours, facts = inboxFacts(recent)): Stand {
  const stand = (key: string, author: string | undefined, state: PullState | undefined) =>
    standOf({ author, state, activity: facts.activity.get(key), requested: facts.requested.has(key) }, recent.viewer);
  if (entry.kind === 'tour') {
    return stand(serializeRef(entry.tour.ref), entry.tour.author, entry.tour.state);
  }
  const open = entry.stack.members.filter((member) => !isClosed(member.state));
  const refs = stackRefs(entry.stack).map(serializeRef);
  const stands = entry.stack.members.flatMap((member, index) =>
    isClosed(member.state) ? [] : [stand(refs[index]!, member.author, member.state)],
  );
  if (open.length > 0 && stands.every((each) => each.move === 'draft')) {
    return stands[0]!;
  }
  return bestStand(stands.filter((each) => each.move !== 'draft')) ?? bestStand(stands)!;
}

const latestOf = (entry: RecentEntry, facts: ReturnType<typeof inboxFacts>) => {
  const keys = entryKeys(entry);
  const times = keys.map((key) => facts.activity.get(key)?.updatedAt ?? '');
  return times.reduce((a, b) => (a > b ? a : b), entry.kind === 'tour' ? entry.tour.updatedAt : entry.updatedAt);
};

/**
 * Splits the inbox into rows on the viewer's move and rows waiting on others; the viewer's
 * drafts fold apart; other open recent tours come last. Each section is newest first, by the
 * last update to a row's PR (a stack's newest member). Closed and
 * merged tours drop out; a stack drops out once none of its PRs is open. Without GitHub's lists
 * every open recent tour is in `recent`, the viewer's first.
 */
export function railSections(recent: RecentTours, skip: ReadonlySet<string>): RailSections {
  const shown = new Set(skip);
  const take = (tours: readonly RecentTour[]) => {
    const entries = recentEntries(tours, shown).filter((entry) =>
      entry.kind === 'tour'
        ? !isClosed(entry.tour.state)
        : entry.stack.members.some((member) => !isClosed(member.state)),
    );
    for (const entry of entries) {
      for (const ref of entry.kind === 'tour' ? [entry.tour.ref] : stackRefs(entry.stack)) {
        shown.add(serializeRef(ref));
      }
    }
    return entries;
  };
  const facts = inboxFacts(recent);
  const newest = (entries: RecentEntry[]) =>
    entries
      .map((entry) => ({ entry, latest: latestOf(entry, facts) }))
      .sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0))
      .map((row) => row.entry);
  if (!recent.reviewRequested || !recent.authored) {
    const { mine, others } = splitByViewer(take(recent.tours), recent.viewer);
    return { yourMove: [], waiting: [], drafts: [], recent: [...newest(mine), ...newest(others)] };
  }
  const inbox = take([...recent.reviewRequested, ...(recent.reviewed ?? []), ...recent.authored]).map((entry) => ({
    entry,
    stand: entryStand(entry, recent, facts),
    latest: latestOf(entry, facts),
  }));
  inbox.sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0));
  const where = (...moves: Move[]) => inbox.filter((row) => moves.includes(row.stand.move)).map((row) => row.entry);
  return {
    yourMove: where('mine'),
    waiting: where('theirs', 'unknown'),
    drafts: where('draft'),
    recent: newest(take(recent.tours)),
  };
}

const allEntries = (sections: RailSections) => [
  ...sections.yourMove,
  ...sections.waiting,
  ...sections.drafts,
  ...sections.recent,
];

const entryKeys = (entry: RecentEntry) =>
  (entry.kind === 'tour' ? [entry.tour.ref] : stackRefs(entry.stack)).map(serializeRef);

/** The row that holds the PR (by `serializeRef`): its own row, or the stack it is in. */
export function findEntry(sections: RailSections, key: string): RecentEntry | undefined {
  return allEntries(sections).find((entry) => entryKeys(entry).includes(key));
}

/**
 * The rail around the toured PR. `home` is the row that already holds it (or, once the live
 * stack is known, a row of its stack's other PRs), which stays where it is. Once its live stack is known, that stack's other PRs are skipped elsewhere so none shows
 * twice; a recorded stack that overlaps them falls back to its own tour, as in `recentEntries`.
 */
export function railAround(
  recent: RecentTours,
  key: string,
  live: Stack | undefined,
): { sections: RailSections; home: RecentEntry | undefined } {
  const all = railSections(recent, new Set());
  if (!live) {
    return { sections: all, home: findEntry(all, key) };
  }
  // The live stack takes the place of the first stack row that holds the PR or only PRs of it,
  // so stepping through the stack (onto PRs the rail has not shown yet too) never moves it.
  const liveKeys = new Set(stackRefs(live).map(serializeRef));
  const entries = allEntries(all);
  const within = (entry: RecentEntry) => entryKeys(entry).every((ref) => liveKeys.has(ref));
  const found =
    entries.find((entry) => entry.kind === 'stack' && (entryKeys(entry).includes(key) || within(entry))) ??
    findEntry(all, key) ??
    entries.find(within);
  const kept = new Set(found ? entryKeys(found) : []);
  const sections = railSections(
    recent,
    new Set(
      stackRefs(live)
        .map(serializeRef)
        .filter((ref) => !kept.has(ref)),
    ),
  );
  return { sections, home: found && findEntry(sections, entryKeys(found)[0]!) };
}
