import type { Category, FileSummary, GroupView } from '@gloss/protocol';

/** Sidebar tree node ids: the PR's stack, the toured PR, its categories (category nesting only) and its groups. */
export const STACK_NODE = 'stack';
export const PR_NODE = 'pr';
export const groupNode = (key: string) => `group:${key}`;
export const categoryNode = (category: Category) => `category:${category}`;

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

/** PR and categories start open, groups start folded; a filter opens everything it keeps. */
export function isNodeOpen(sidebar: SidebarState, id: string): boolean {
  return (
    sidebar.query.trim() !== '' ||
    (id.startsWith('group:') ? sidebar.opened.has(id) && !sidebar.folded.has(id) : !sidebar.folded.has(id))
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
