import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Spinner } from '@astryxdesign/core/Spinner';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { useAtomValue } from '@effect/atom-react';
import type { FileSummary, GroupView, SourceRef } from '@gloss/protocol';
import { describeRef, serializeRef } from '@gloss/protocol';
import { AsyncResult } from 'effect/reactivity';
import { Fragment, type KeyboardEvent } from 'react';
import { recentToursAtom, stackAtom } from '../lib/client.ts';
import {
  byCategory,
  CATEGORY_LABEL,
  categoryNode,
  countViewed,
  filterGroups,
  groupNode,
  isNodeOpen,
  type Nesting,
  PR_NODE,
  type SidebarState,
  STACK_NODE,
} from '../lib/sidebar-tree.ts';
import { useNavigateToRef } from '../lib/source-routes.tsx';
import type { Msg } from '../lib/tour-model.ts';
import { notedFileIds, OVERVIEW, orderedFileIds, risksByFile, splitPath } from '../lib/tour-view.ts';
import { CategoryIcon, CheckIcon, RefIcon, StackIcon } from './icons.tsx';
import { Progress, TreeRow } from './TreeRow.tsx';

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
  sidebar,
  dispatch,
}: {
  sourceRef: SourceRef;
  title: string | undefined;
  groups: GroupView[];
  files: ReadonlyMap<string, FileSummary>;
  selection: string;
  activeFileId: string | undefined;
  viewed: ReadonlySet<string>;
  loading: boolean;
  sidebar: SidebarState;
  dispatch: (msg: Msg) => void;
}) {
  const { nesting, query } = sidebar;
  const recent = AsyncResult.getOrElse(useAtomValue(recentToursAtom), () => []).filter(
    (tour) => serializeRef(tour.ref) !== serializeRef(sourceRef),
  );
  const fetchedStack = AsyncResult.getOrElse(useAtomValue(stackAtom(sourceRef)), () => undefined);
  // Only a chain of two or more is worth its own row.
  const stack = fetchedStack && fetchedStack.members.length > 1 ? fetchedStack : undefined;
  const currentMember =
    sourceRef.kind === 'github-pr'
      ? fetchedStack?.members.find((member) => member.number === sourceRef.number)
      : undefined;
  const stackRefs = new Set(
    (stack?.members ?? []).map((member) =>
      serializeRef({ kind: 'github-pr', owner: stack!.owner, repo: stack!.repo, number: member.number }),
    ),
  );
  const navigateToRef = useNavigateToRef();

  const kept = filterGroups(groups, files, query);
  const isOpen = (id: string) => isNodeOpen(sidebar, id);
  const toggle = (id: string, deep: boolean) => dispatch({ type: 'SidebarToggled', node: id, deep });
  const activate = (id: string, key: string) => dispatch({ type: 'SidebarActivated', node: id, key });
  const onSelect = (key: string) => dispatch({ type: 'GroupSelected', key });

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
  const stackOpen = isOpen(STACK_NODE);

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
            onSelectFile={(fileId) => dispatch({ type: 'FileJumped', fileId, groupKey: group.key })}
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

  const prNode = (
    <div className="tree-node">
      <TreeRow
        id={PR_NODE}
        parent={stack ? STACK_NODE : ''}
        tabbable={!stack}
        current={false}
        expanded={prOpen}
        label={title ?? describeRef(sourceRef)}
        sticky
        onToggle={(deep) => toggle(PR_NODE, deep)}
        onClick={() => activate(PR_NODE, OVERVIEW)}
      >
        <span className="tree-lead">
          <RefIcon kind={sourceRef.kind} state={currentMember?.state} />
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
  );

  return (
    <nav className="sidebar" aria-label="Review queue">
      <div className="side-tools">
        <TextInput
          label="Filter groups and files"
          isLabelHidden
          placeholder="Filter groups and files"
          value={query}
          onChange={(value) => dispatch({ type: 'QueryChanged', query: value })}
        />
        <SegmentedControl
          label="Group order"
          size="sm"
          value={nesting}
          onChange={(value) => dispatch({ type: 'NestingChanged', nesting: value as Nesting })}
        >
          <SegmentedControlItem value="tour" label="Tour" />
          <SegmentedControlItem value="category" label="Category" />
        </SegmentedControl>
      </div>
      <div className="tree" role="tree" aria-label="PRs, groups and files" onKeyDown={onTreeKey}>
        {stack ? (
          <div className="tree-node">
            <TreeRow
              id={STACK_NODE}
              parent=""
              tabbable
              current={false}
              expanded={stackOpen}
              label={`Stack of ${stack.members.length} PRs onto ${stack.base}`}
              onToggle={(deep) => toggle(STACK_NODE, deep)}
              onClick={() => toggle(STACK_NODE, false)}
            >
              <span className="tree-lead">
                <StackIcon />
              </span>
              <span className="nav-label">
                Stack onto <code className="tree-branch">{stack.base}</code>
              </span>
              {!stackOpen && critical > 0 && (
                <span className="tree-critical" aria-label={`${critical} critical groups`}>
                  <span className="marker marker-critical" />
                  {critical}
                </span>
              )}
              <span className="nav-count">{stack.members.length} PRs</span>
            </TreeRow>
            {stackOpen && (
              <div className="tree-kids" role="group">
                {stack.members.map((member) =>
                  member === currentMember ? (
                    <Fragment key={member.number}>{prNode}</Fragment>
                  ) : (
                    <TreeRow
                      key={member.number}
                      id={`member:${member.number}`}
                      parent={STACK_NODE}
                      current={false}
                      label={`#${member.number} ${member.title} (${member.state})`}
                      onClick={() =>
                        void navigateToRef({
                          kind: 'github-pr',
                          owner: stack.owner,
                          repo: stack.repo,
                          number: member.number,
                        })
                      }
                    >
                      <span className="tree-lead">
                        <RefIcon kind="github-pr" state={member.state} />
                      </span>
                      <span className="nav-label" data-done={member.state === 'merged' || member.state === 'closed'}>
                        <span className="tree-number">#{member.number}</span>
                        {member.title}
                      </span>
                    </TreeRow>
                  ),
                )}
              </div>
            )}
          </div>
        ) : (
          prNode
        )}
        {recent
          .filter((item) => !stackRefs.has(serializeRef(item.ref)))
          .map((item) => (
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

function RefLabel({ sourceRef, title }: { sourceRef: SourceRef; title: string | undefined }) {
  return (
    <span className="nav-label">
      {sourceRef.kind === 'github-pr' && <span className="tree-number">#{sourceRef.number}</span>}
      {title ?? describeRef(sourceRef)}
    </span>
  );
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
