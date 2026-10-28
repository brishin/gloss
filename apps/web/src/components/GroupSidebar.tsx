import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Spinner } from '@astryxdesign/core/Spinner';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import type { FileSummary, GroupView, RecentTour, SourceRef } from '@gloss/protocol';
import { describeRef, serializeRef } from '@gloss/protocol';
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from 'react';
import { useGlossClient } from '../lib/client.tsx';
import {
  byCategory,
  CATEGORY_LABEL,
  categoryNode,
  countViewed,
  filterGroups,
  groupNode,
  type Nesting,
  PR_NODE,
} from '../lib/sidebar-tree.ts';
import { useNavigateToRef } from '../lib/source-routes.tsx';
import { notedFileIds, OVERVIEW, orderedFileIds, risksByFile, splitPath } from '../lib/tour-view.ts';
import { CategoryIcon, CheckIcon, ChevronIcon, RefIcon } from './icons.tsx';

/**
 * The review queue as a foldable tree: the toured PR, its groups (in tour order or nested
 * under their category), each group's files; then other recent tours. Clicking a row opens
 * it, clicking the open row (or its chevron) folds it, and shift-clicking a chevron folds
 * everything under it. Arrow keys walk the tree.
 */
export function GroupSidebar({
  sourceRef,
  title,
  groups,
  files,
  selection,
  activeFileId,
  viewed,
  loading,
  onSelect,
  onSelectFile,
}: {
  sourceRef: SourceRef;
  title: string | undefined;
  groups: GroupView[];
  files: ReadonlyMap<string, FileSummary>;
  selection: string;
  activeFileId: string | undefined;
  viewed: ReadonlySet<string>;
  loading: boolean;
  onSelect: (key: string) => void;
  onSelectFile: (fileId: string) => void;
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [nesting, setNesting] = useState<Nesting>('tour');
  const [query, setQuery] = useState('');
  const recent = useRecentTours(sourceRef);
  const navigateToRef = useNavigateToRef();

  const kept = filterGroups(groups, files, query);
  // PR and categories start open, groups start folded; a filter opens everything it keeps.
  const isOpen = (id: string) =>
    kept !== undefined || (id.startsWith('group:') ? opened.has(id) && !folded.has(id) : !folded.has(id));

  const setOpen = useCallback((ids: string[], open: boolean) => {
    setOpened((previous) => {
      const next = new Set(previous);
      ids.forEach((id) => (open ? next.add(id) : next.delete(id)));
      return next;
    });
    setFolded((previous) => {
      const next = new Set(previous);
      ids.forEach((id) => (open ? next.delete(id) : next.add(id)));
      return next;
    });
  }, []);

  // Selecting a group (click, j/k, a link in the panel) unfolds the path to it.
  const selectedCategory = groups.find((group) => group.key === selection)?.category;
  useEffect(() => {
    setOpen(selectedCategory ? [PR_NODE, categoryNode(selectedCategory), groupNode(selection)] : [PR_NODE], true);
  }, [selection, selectedCategory, setOpen]);

  const toggle = (id: string, deep: boolean) => {
    const open = !isOpen(id);
    const below =
      id === PR_NODE
        ? [...groups.map((group) => groupNode(group.key)), ...groups.map((group) => categoryNode(group.category))]
        : id.startsWith('category:')
          ? groups.filter((group) => categoryNode(group.category) === id).map((group) => groupNode(group.key))
          : [];
    setOpen(deep ? [id, ...below] : [id], open);
  };

  /** Opens a row, or folds it when it is already the selection. */
  const activate = (id: string, key: string) => {
    if (selection === key && isOpen(id)) {
      setOpen([id], false);
    } else {
      onSelect(key);
      setOpen([id], true);
    }
  };

  const onTreeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-node]')];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const row = rows[at];
    if (!row) {
      return;
    }
    const id = row.dataset.node!;
    const expanded = row.getAttribute('aria-expanded');
    const focus = (target: HTMLElement | undefined) => target?.focus();
    const actions: Record<string, () => void> = {
      ArrowDown: () => focus(rows[at + 1]),
      ArrowUp: () => focus(rows[at - 1]),
      ArrowRight: () =>
        expanded === 'false'
          ? toggle(id, false)
          : focus(rows[at + 1]?.dataset.parent === id ? rows[at + 1] : undefined),
      ArrowLeft: () =>
        expanded === 'true' ? toggle(id, false) : focus(rows.find((r) => r.dataset.node === row.dataset.parent)),
      Enter: () => row.click(),
      ' ': () => row.click(),
    };
    const action = actions[event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  };

  const allFileIds = groups.flatMap((group) => group.fileIds);
  const critical = groups.filter((group) => group.critical).length;
  const prOpen = isOpen(PR_NODE);

  const renderGroup = (group: GroupView, index: number, parent: string) => {
    const fileIds = kept ? kept.get(group.key) : group.fileIds;
    if (!fileIds) {
      return null;
    }
    const id = groupNode(group.key);
    const open = isOpen(id);
    const selected = group.key === selection;
    const seen = countViewed(group.fileIds, viewed);
    return (
      <div key={group.key} className="tree-node">
        <TreeRow
          id={id}
          parent={parent}
          current={selected}
          expanded={open}
          label={group.label}
          phase={group.phase}
          onToggle={(deep) => toggle(id, deep)}
          onClick={() => activate(id, group.key)}
        >
          <span className="nav-index">{index + 1}</span>
          {nesting === 'tour' && (
            <span className="tree-lead tree-lead-category" title={CATEGORY_LABEL[group.category]}>
              <CategoryIcon category={group.category} />
            </span>
          )}
          <span className="nav-label">{group.label}</span>
          {group.critical && (
            // A dot, not a pill: a pill truncates the group name at narrow widths.
            <Tooltip content="Critical: touches auth, stored data, secrets or personal data">
              <span className="marker marker-critical" role="img" aria-label="Critical" />
            </Tooltip>
          )}
          <span className="nav-count">
            {seen === group.fileIds.length ? (
              <span aria-label="All viewed">
                <CheckIcon />
              </span>
            ) : seen ? (
              `${seen}/${group.fileIds.length}`
            ) : (
              group.fileIds.length
            )}
          </span>
        </TreeRow>
        {open && (
          <FileList
            group={group}
            fileIds={fileIds}
            parent={id}
            files={files}
            activeFileId={selected ? activeFileId : undefined}
            viewed={viewed}
            onSelectFile={(fileId) => {
              if (!selected) {
                onSelect(group.key);
              }
              onSelectFile(fileId);
            }}
          />
        )}
      </div>
    );
  };

  const groupRows =
    nesting === 'tour'
      ? groups.map((group, index) => renderGroup(group, index, PR_NODE))
      : byCategory(groups).map(({ category, groups: members }) => {
          if (kept && !members.some(({ group }) => kept.has(group.key))) {
            return null;
          }
          const id = categoryNode(category);
          const open = isOpen(id);
          const fileCount = members.reduce((sum, { group }) => sum + group.fileIds.length, 0);
          return (
            <div key={category} className="tree-node">
              <TreeRow
                id={id}
                parent={PR_NODE}
                current={false}
                expanded={open}
                label={CATEGORY_LABEL[category]}
                onToggle={(deep) => toggle(id, deep)}
                onClick={() => toggle(id, false)}
              >
                <span className="tree-lead tree-lead-category">
                  <CategoryIcon category={category} />
                </span>
                <span className="nav-label">{CATEGORY_LABEL[category]}</span>
                {!open && members.some(({ group }) => group.critical) && (
                  <span className="marker marker-critical" role="img" aria-label="Contains a critical group" />
                )}
                <span className="nav-count">
                  {fileCount} {fileCount === 1 ? 'file' : 'files'}
                </span>
              </TreeRow>
              {open && (
                <div className="tree-kids" role="group">
                  {members.map(({ group, index }) => renderGroup(group, index, id))}
                </div>
              )}
            </div>
          );
        });

  return (
    <nav className="sidebar" aria-label="Review queue">
      <div className="side-tools">
        <TextInput
          label="Filter groups and files"
          isLabelHidden
          placeholder="Filter groups and files"
          value={query}
          onChange={setQuery}
        />
        <SegmentedControl
          label="Group order"
          size="sm"
          value={nesting}
          onChange={(value) => setNesting(value as Nesting)}
        >
          <SegmentedControlItem value="tour" label="Tour" />
          <SegmentedControlItem value="category" label="Category" />
        </SegmentedControl>
      </div>
      <div className="tree" role="tree" aria-label="PRs, groups and files" onKeyDown={onTreeKey}>
        <div className="tree-section">Review queue</div>
        <div className="tree-node">
          <TreeRow
            id={PR_NODE}
            parent=""
            current={false}
            expanded={prOpen}
            label={title ?? describeRef(sourceRef)}
            sticky
            onToggle={(deep) => toggle(PR_NODE, deep)}
            onClick={() => activate(PR_NODE, OVERVIEW)}
          >
            <span className="tree-lead">
              <RefIcon kind={sourceRef.kind} />
            </span>
            <RefLabel sourceRef={sourceRef} title={title} />
            {!prOpen && critical > 0 && (
              <span className="tree-critical" aria-label={`${critical} critical groups`}>
                <span className="marker marker-critical" />
                {critical}
              </span>
            )}
            {loading ? (
              <Spinner size="sm" shade="subtle" aria-label="Tour running" />
            ) : (
              <Progress seen={countViewed(allFileIds, viewed)} total={allFileIds.length} />
            )}
          </TreeRow>
          {prOpen && (
            <div className="tree-kids" role="group">
              <TreeRow
                id="overview"
                parent={PR_NODE}
                current={selection === OVERVIEW}
                label="Overview"
                onClick={() => onSelect(OVERVIEW)}
              >
                <span className="nav-index" />
                <span className="nav-label">Overview</span>
                <span className="nav-count">{files.size || ''}</span>
              </TreeRow>
              {groups.length === 0 && loading
                ? [0, 1, 2].map((index) => <Skeleton key={index} index={index} height={28} />)
                : groupRows}
            </div>
          )}
        </div>
        {recent.map((item) => (
          <TreeRow
            key={serializeRef(item.ref)}
            id={`recent:${serializeRef(item.ref)}`}
            parent=""
            current={false}
            label={`${item.title} · ${describeRef(item.ref)}`}
            onClick={() => void navigateToRef(item.ref)}
          >
            <span className="tree-lead">
              <RefIcon kind={item.ref.kind} />
            </span>
            <RefLabel sourceRef={item.ref} title={item.title} />
          </TreeRow>
        ))}
      </div>
    </nav>
  );
}

/** One tree row. Rows are focusable treeitems (roving focus via arrow keys), not buttons, so the chevron can be one. */
function TreeRow({
  id,
  parent,
  current,
  expanded,
  label,
  phase,
  sticky,
  onToggle,
  onClick,
  children,
}: {
  id: string;
  parent: string;
  current: boolean;
  expanded?: boolean;
  label: string;
  phase?: GroupView['phase'];
  sticky?: boolean;
  onToggle?: (deep: boolean) => void;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="treeitem"
      className={`nav-item tree-row${sticky ? ' tree-row-sticky' : ''}`}
      data-node={id}
      data-parent={parent}
      data-phase={phase}
      aria-expanded={expanded}
      aria-current={current ? 'step' : undefined}
      aria-selected={current}
      tabIndex={current || id === PR_NODE ? 0 : -1}
      title={label}
      onClick={onClick}
    >
      {onToggle ? (
        <button
          type="button"
          className="tree-chevron"
          tabIndex={-1}
          aria-label={`${expanded ? 'Fold' : 'Unfold'} ${label}`}
          onClick={(event: MouseEvent) => {
            event.stopPropagation();
            onToggle(event.shiftKey);
          }}
        >
          <ChevronIcon />
        </button>
      ) : (
        <span className="tree-chevron" />
      )}
      {children}
    </div>
  );
}

function RefLabel({ sourceRef, title }: { sourceRef: SourceRef; title: string | undefined }) {
  return (
    <span className="nav-label">
      {sourceRef.kind === 'github-pr' && <span className="tree-number">#{sourceRef.number}</span>}
      {title ?? describeRef(sourceRef)}
    </span>
  );
}

/** Files viewed so far: a ring while in progress, a check when done. */
function Progress({ seen, total }: { seen: number; total: number }) {
  if (total > 0 && seen === total) {
    return (
      <span className="nav-count" aria-label="All files viewed">
        <CheckIcon />
      </span>
    );
  }
  return (
    <span
      className="tree-ring"
      style={{ '--progress': total ? seen / total : 0 } as CSSProperties}
      role="img"
      aria-label={`${seen} of ${total} files viewed`}
    />
  );
}

/** Recent tours other than this one, newest first. */
function useRecentTours(sourceRef: SourceRef): RecentTour[] {
  const client = useGlossClient();
  const [recent, setRecent] = useState<RecentTour[]>([]);
  const current = serializeRef(sourceRef);
  useEffect(() => {
    client
      .recent()
      .then((tours) => setRecent(tours.filter((tour) => serializeRef(tour.ref) !== current)))
      .catch(() => setRecent([]));
  }, [client, current]);
  return recent;
}

/** An open group's files, risk-flagged first (the panel's order), with scroll-spy highlighting. */
function FileList({
  group,
  fileIds,
  parent,
  files,
  activeFileId,
  viewed,
  onSelectFile,
}: {
  group: GroupView;
  fileIds: readonly string[];
  parent: string;
  files: ReadonlyMap<string, FileSummary>;
  activeFileId: string | undefined;
  viewed: ReadonlySet<string>;
  onSelectFile: (fileId: string) => void;
}) {
  const noted = notedFileIds(group);
  const risky = risksByFile(group);
  const shown = new Set(fileIds);
  return (
    <div className="file-list" role="group">
      {orderedFileIds(group)
        .filter((fileId) => shown.has(fileId))
        .map((fileId) => {
          const file = files.get(fileId);
          if (!file) {
            return null;
          }
          return (
            <div
              role="treeitem"
              key={fileId}
              className="file-link"
              data-node={`file:${fileId}`}
              data-parent={parent}
              tabIndex={-1}
              title={file.path}
              aria-current={fileId === activeFileId ? 'location' : undefined}
              aria-selected={fileId === activeFileId}
              data-viewed={viewed.has(fileId)}
              onClick={() => onSelectFile(fileId)}
            >
              {risky.has(fileId) ? (
                <span className="marker marker-risk" aria-label="Risk flagged" />
              ) : noted.has(fileId) ? (
                <span className="marker marker-note" aria-label="Has notes" />
              ) : (
                <span className="marker" />
              )}
              <span className="file-link-name">{splitPath(file.path).base}</span>
              <span className="stat" aria-label={`${file.additions} additions, ${file.deletions} deletions`}>
                {file.additions > 0 && <span className="adds">+{file.additions}</span>}{' '}
                {file.deletions > 0 && <span className="dels">−{file.deletions}</span>}
              </span>
            </div>
          );
        })}
    </div>
  );
}
