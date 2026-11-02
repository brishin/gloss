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

/** Sidebar tree node ids: the PR's stack, the toured PR, its categories (category nesting only) and its groups. */
export const STACK_NODE = 'stack';
export const PR_NODE = 'pr';
export const groupNode = (key: string) => `group:${key}`;
export const categoryNode = (category: Category) => `category:${category}`;
export const recentStackNode = (key: string) => `recent-stack:${key}`;
/** Shows a stack's merged and closed PRs; folded (hidden) until opened. */
export const closedNode = (stackNode: string) => `closed:${stackNode}`;

export type Nesting = 'tour' | 'category';

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

export interface CategoryBucket {
  category: Category;
  /** Each group with its tour index, so numbering matches the tour order in both nestings. */
  groups: { group: GroupView; index: number }[];
}

/** Groups nested under their category, categories in the order their first group appears in the tour. */
export function byCategory(groups: GroupView[]): CategoryBucket[] {
  const buckets = new Map<Category, CategoryBucket>();
  groups.forEach((group, index) => {
    let bucket = buckets.get(group.category);
    if (!bucket) {
      bucket = { category: group.category, groups: [] };
      buckets.set(group.category, bucket);
    }
    bucket.groups.push({ group, index });
  });
  return [...buckets.values()];
}

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

/** The sidebar's own state: the nodes the reader folded or opened, the nesting, and the filter. */
export interface SidebarState {
  folded: ReadonlySet<string>;
  opened: ReadonlySet<string>;
  nesting: Nesting;
  query: string;
}

export const initialSidebar: SidebarState = { folded: new Set(), opened: new Set(), nesting: 'tour', query: '' };

/** PR, stacks and categories start open; groups and closed PRs start folded; a filter opens everything it keeps. */
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
  const allBelowPr = [
    ...groups.map((group) => groupNode(group.key)),
    ...groups.map((group) => categoryNode(group.category)),
  ];
  const below =
    id === STACK_NODE
      ? [PR_NODE, ...allBelowPr]
      : id === PR_NODE
        ? allBelowPr
        : id.startsWith('category:')
          ? groups.filter((group) => categoryNode(group.category) === id).map((group) => groupNode(group.key))
          : [];
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
export type RecentEntry = { kind: 'tour'; tour: RecentTour } | { kind: 'stack'; key: string; stack: Stack };

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
    entries.push({ kind: 'stack', key, stack });
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
  reviewRequested: RecentEntry[];
  mine: RecentEntry[];
  /** Other recent tours that are still open (and local diffs), when GitHub could list the two above. */
  recent: RecentEntry[];
}

/**
 * Splits the rail into PRs waiting on the viewer's review, the viewer's open PRs, then other
 * open recent tours. Closed and merged tours drop out; a stack drops out once none of its PRs
 * is open. Without GitHub's lists, recent tours split into the viewer's and the rest.
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
  if (!recent.reviewRequested || !recent.authored) {
    const { mine, others } = splitByViewer(take(recent.tours), recent.viewer);
    return { reviewRequested: [], mine, recent: others };
  }
  return { reviewRequested: take(recent.reviewRequested), mine: take(recent.authored), recent: take(recent.tours) };
}

const entryKeys = (entry: RecentEntry) =>
  (entry.kind === 'tour' ? [entry.tour.ref] : stackRefs(entry.stack)).map(serializeRef);

/** The row that holds the PR (by `serializeRef`): its own row, or the stack it is in. */
export function findEntry(sections: RailSections, key: string): RecentEntry | undefined {
  return [...sections.reviewRequested, ...sections.mine, ...sections.recent].find((entry) =>
    entryKeys(entry).includes(key),
  );
}

/**
 * The rail around the toured PR. `home` is the row that already holds it, which stays where it
 * is. Once its live stack is known, that stack's other PRs are skipped elsewhere so none shows
 * twice; a recorded stack that overlaps them falls back to its own tour, as in `recentEntries`.
 */
export function railAround(
  recent: RecentTours,
  key: string,
  live: Stack | undefined,
): { sections: RailSections; home: RecentEntry | undefined } {
  const all = railSections(recent, new Set());
  const found = findEntry(all, key);
  if (!live) {
    return { sections: all, home: found };
  }
  const kept = new Set(found ? entryKeys(found) : []);
  const sections = railSections(
    recent,
    new Set(
      stackRefs(live)
        .map(serializeRef)
        .filter((ref) => !kept.has(ref)),
    ),
  );
  return { sections, home: findEntry(sections, key) };
}
