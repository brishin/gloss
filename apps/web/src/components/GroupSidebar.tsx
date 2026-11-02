import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Spinner } from '@astryxdesign/core/Spinner';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { useAtomValue } from '@effect/atom-react';
import type { FileSummary, GroupView, RecentTours, SourceRef, Stack, StackMember } from '@gloss/protocol';
import { describeRef, serializeRef } from '@gloss/protocol';
import { AsyncResult } from 'effect/reactivity';
import { Fragment, type KeyboardEvent, type ReactNode } from 'react';
import { recentToursAtom } from '../lib/client.ts';
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
  closedNode,
  findEntry,
  isClosed,
  railSections,
  type RecentEntry,
  recentStackNode,
  type SidebarState,
  STACK_NODE,
  stackRefs,
  withoutRefs,
} from '../lib/sidebar-tree.ts';
import type { Msg } from '../lib/tour-model.ts';
import { notedFileIds, OVERVIEW, orderedFileIds, risksByFile, splitPath, WALKTHROUGH } from '../lib/tour-view.ts';
import { CategoryIcon, CheckIcon, RefIcon, StackIcon } from './icons.tsx';
import { Progress, TreeRow } from './TreeRow.tsx';

/**
 * The review queue as a foldable tree: the toured PR, its groups (in tour order or nested
 * under their category), each group's files; then other recent tours, those in a stack under
 * it. PR rows end with the author's avatar. Clicking a row opens
 * it, clicking the open row (or its chevron) folds it, and shift-clicking a chevron folds
 * everything under it. Arrow keys walk the tree.
 */
export function GroupSidebar({
  sourceRef,
  stack: fetchedStack,
  title,
  author,
  groups,
  files,
  selection,
  walkthrough,
  activeFileId,
  viewed,
  loading,
  sidebar,
  dispatch,
}: {
  sourceRef: SourceRef;
  stack: Stack | undefined;
  title: string | undefined;
  author: string | undefined;
  groups: GroupView[];
  files: ReadonlyMap<string, FileSummary>;
  selection: string;
  /** Whether the tour has a walkthrough section, listed under the overview. */
  walkthrough: boolean;
  activeFileId: string | undefined;
  viewed: ReadonlySet<string>;
  loading: boolean;
  sidebar: SidebarState;
  dispatch: (msg: Msg) => void;
}) {
  const { nesting, query } = sidebar;
  const recent = AsyncResult.getOrElse(useAtomValue(recentToursAtom), (): RecentTours => ({ tours: [] }));
  const { viewer } = recent;
  const currentKey = serializeRef(sourceRef);
  // Only a chain of two or more is worth its own row.
  const fetched = fetchedStack && fetchedStack.members.length > 1 ? fetchedStack : undefined;
  // The toured PR shows in place, in the first section that has it; the live stack's other PRs
  // are left out of the sections so none shows twice.
  const all = railSections(recent, new Set());
  const home = findEntry(all, currentKey);
  const sections = fetched ? withoutRefs(all, new Set(stackRefs(fetched).map(serializeRef)), home) : all;
  // The live stack once fetched; until then the one the toured PR's row already has, so the rail
  // does not move while it loads.
  const stack = fetched ?? (home?.kind === 'stack' ? home.stack : undefined);
  const currentMember =
    sourceRef.kind === 'github-pr'
      ? (stack ?? fetchedStack)?.members.find((member) => member.number === sourceRef.number)
      : undefined;
  /** Opens a PR from its rail row, noting where the row is so the next page keeps it there. */
  const openFromRail = (ref: SourceRef, row: HTMLElement) => {
    const rail = row.closest<HTMLElement>('nav.sidebar');
    dispatch({
      type: 'RailOpened',
      ref,
      offset: rail ? row.getBoundingClientRect().top - rail.getBoundingClientRect().top : 0,
      scrollTop: rail?.scrollTop ?? 0,
    });
  };

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
            onSelectFile={(fileId) => dispatch({ type: 'FileJumped', fileId })}
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
        {/* Your own PR sits in "My PRs", which shows no avatar of yours. */}
        <Avatar login={(author ?? currentMember?.author) === viewer ? undefined : (author ?? currentMember?.author)} />
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
          {walkthrough && (
            <TreeRow
              id="walkthrough"
              parent={PR_NODE}
              current={selection === WALKTHROUGH}
              label="Walkthrough"
              onClick={() => onSelect(WALKTHROUGH)}
            >
              <span className="nav-index" />
              <span className="nav-label">Walkthrough</span>
              <span className="nav-count" />
            </TreeRow>
          )}
          {groups.length === 0 && loading
            ? [0, 1, 2].map((index) => <Skeleton key={index} index={index} height={28} />)
            : groupRows}
        </div>
      )}
    </div>
  );

  /**
   * A stack's PRs, bottom first. Merged and closed PRs (other than the toured one) hide behind
   * a row that counts them, folded until opened.
   */
  const stackMembers = (stack: Stack, parent: string, hideAuthor: string | undefined, holdsCurrent: boolean) => {
    const closedId = closedNode(parent);
    const showClosed = isOpen(closedId);
    const isCurrent = (member: StackMember) => holdsCurrent && member === currentMember;
    const closed = stack.members.filter((member) => !isCurrent(member) && isClosed(member.state));
    return (
      <div className="tree-kids" role="group">
        {closed.length > 0 && (
          <TreeRow
            id={closedId}
            parent={parent}
            current={false}
            expanded={showClosed}
            label={`${closed.length} closed`}
            onToggle={(deep) => toggle(closedId, deep)}
            onClick={() => toggle(closedId, false)}
          >
            <span className="nav-label tree-closed">{closed.length} closed</span>
          </TreeRow>
        )}
        {stack.members.map((member) =>
          isCurrent(member) ? (
            <Fragment key={member.number}>{prNode}</Fragment>
          ) : showClosed || !isClosed(member.state) ? (
            <MemberRow
              key={member.number}
              stack={stack}
              member={member}
              parent={parent}
              hideAuthor={hideAuthor}
              onOpen={openFromRail}
            />
          ) : null,
        )}
      </div>
    );
  };

  /** The toured PR, in its stack when it has one. */
  const currentBlock = (hideAuthor: string | undefined) =>
    stack ? (
      <div className="tree-node">
        <StackHead
          id={STACK_NODE}
          stack={stack}
          open={stackOpen}
          tabbable
          onToggle={(deep) => toggle(STACK_NODE, deep)}
        >
          {!stackOpen && critical > 0 && (
            <span className="tree-critical" aria-label={`${critical} critical groups`}>
              <span className="marker marker-critical" />
              {critical}
            </span>
          )}
        </StackHead>
        {stackOpen && stackMembers(stack, STACK_NODE, hideAuthor, true)}
      </div>
    ) : (
      prNode
    );

  const renderRecent = (hideAuthor: string | undefined) => (entry: RecentEntry) => {
    if (entry === home) {
      return <Fragment key={currentKey}>{currentBlock(hideAuthor)}</Fragment>;
    }
    if (entry.kind === 'tour') {
      const item = entry.tour;
      return (
        <TreeRow
          key={serializeRef(item.ref)}
          id={`recent:${serializeRef(item.ref)}`}
          parent=""
          current={false}
          label={`${item.title} · ${describeRef(item.ref)}`}
          onClick={(event) => openFromRail(item.ref, event.currentTarget)}
        >
          <span className="tree-lead">
            <RefIcon kind={item.ref.kind} state={item.state} />
          </span>
          <RefLabel sourceRef={item.ref} title={item.title} />
          <Avatar login={item.author === hideAuthor ? undefined : item.author} />
        </TreeRow>
      );
    }
    const id = recentStackNode(entry.key);
    const open = isOpen(id);
    return (
      <div key={id} className="tree-node">
        <StackHead id={id} stack={entry.stack} open={open} onToggle={(deep) => toggle(id, deep)} />
        {open && stackMembers(entry.stack, id, hideAuthor, false)}
      </div>
    );
  };

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
        {!home && currentBlock(undefined)}
        <RailSection label="Review requested" entries={sections.reviewRequested} render={renderRecent(undefined)} />
        <RailSection label="My PRs" entries={sections.mine} render={renderRecent(viewer)} />
        <RailSection label="Recent" entries={sections.recent} render={renderRecent(undefined)} />
      </div>
    </nav>
  );
}

/** A stack's row: the branch it goes onto and how many PRs it has. Clicking it folds it. */
function StackHead({
  id,
  stack,
  open,
  tabbable,
  onToggle,
  children,
}: {
  id: string;
  stack: Stack;
  open: boolean;
  tabbable?: boolean;
  onToggle: (deep: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <TreeRow
      id={id}
      parent=""
      tabbable={tabbable}
      current={false}
      expanded={open}
      label={`Stack of ${stack.members.length} PRs onto ${stack.base}`}
      onToggle={onToggle}
      onClick={() => onToggle(false)}
    >
      <span className="tree-lead">
        <StackIcon />
      </span>
      <span className="nav-label">
        Stack onto <code className="tree-branch">{stack.base}</code>
      </span>
      {children}
      <span className="nav-count">{stack.members.length} PRs</span>
    </TreeRow>
  );
}

/** A PR in a stack other than the toured one: opens it. */
function MemberRow({
  stack,
  member,
  parent,
  hideAuthor,
  onOpen,
}: {
  stack: Stack;
  member: StackMember;
  parent: string;
  onOpen: (ref: SourceRef, row: HTMLElement) => void;
  /** Leaves this login's avatar off: in "My PRs" it would be on every row. */
  hideAuthor?: string | undefined;
}) {
  return (
    <TreeRow
      id={`member:${parent}:${member.number}`}
      parent={parent}
      current={false}
      label={`#${member.number} ${member.title} (${member.state})`}
      onClick={(event) =>
        onOpen({ kind: 'github-pr', owner: stack.owner, repo: stack.repo, number: member.number }, event.currentTarget)
      }
    >
      <span className="tree-lead">
        <RefIcon kind="github-pr" state={member.state} />
      </span>
      <span className="nav-label" data-done={member.state === 'merged' || member.state === 'closed'}>
        <span className="tree-number">#{member.number}</span>
        {member.title}
      </span>
      <Avatar login={member.author === hideAuthor ? undefined : member.author} />
    </TreeRow>
  );
}

/** A labelled run of rows below the toured PR; nothing when it is empty. */
function RailSection({
  label,
  entries,
  render,
}: {
  label: string;
  entries: readonly RecentEntry[];
  render: (entry: RecentEntry) => ReactNode;
}) {
  if (entries.length === 0) {
    return null;
  }
  return (
    <>
      <div className="tree-section" role="presentation">
        {label}
      </div>
      {entries.map(render)}
    </>
  );
}

/** The PR author's GitHub avatar; nothing without one, or when GitHub has no image for the login. */
function Avatar({ login }: { login: string | undefined }) {
  if (!login) {
    return null;
  }
  return (
    <img
      className="tree-avatar"
      src={`https://github.com/${encodeURIComponent(login)}.png?size=32`}
      alt={login}
      title={login}
      width={16}
      height={16}
      loading="lazy"
      onError={(event) => {
        event.currentTarget.hidden = true;
      }}
    />
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
