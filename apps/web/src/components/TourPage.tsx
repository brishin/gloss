import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { ButtonGroup } from '@astryxdesign/core/ButtonGroup';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Text } from '@astryxdesign/core/Text';
import { useAtomMount, useAtomSet, useAtomValue } from '@effect/atom-react';
import type { SourceRef } from '@gloss/protocol';
import { groupsInOrder } from '@gloss/protocol';
import { Link, useRouter } from '@tanstack/react-router';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  KeyboardIcon,
  MessageCircleQuestionIcon,
  MessagesSquareIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  RotateCwIcon,
  SquareIcon,
  WorkflowIcon,
} from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { SENT_LABEL } from '../lib/review-draft.ts';
import { noteFrames, noteGroup, noteQuote, type SideNote, sideNotes } from '../lib/side-notes.ts';
import { openThreads } from '../lib/threads-model.ts';
import {
  canAsk,
  canReview,
  currentGroup,
  currentPull,
  fileOrder,
  isRunning,
  selectedKey,
  tourStops,
} from '../lib/tour-model.ts';
import { tourProgram } from '../lib/tour-program.ts';
import { hasWalkStop, OVERVIEW, pathsShown, WALKTHROUGH, walkHomes } from '../lib/tour-view.ts';
import { AskPanel } from './AskPanel.tsx';
import { AutoToursSwitch } from './AutoToursSwitch.tsx';
import { type FileControls, GroupPanel } from './GroupPanel.tsx';
import { GroupSidebar } from './GroupSidebar.tsx';
import { GithubIcon } from './icons.tsx';
import { KeyPaths } from './KeyPaths.tsx';
import { Logo } from './Logo.tsx';
import type { NoteActions } from './NoteLane.tsx';
import { Overview, PullHead } from './Overview.tsx';
import type { Reviewer } from './ReviewComments.tsx';
import { ReviewPanel } from './ReviewPanel.tsx';
import { ShortcutHelp } from './ShortcutHelp.tsx';
import { CommentsPanel, type ThreadControls } from './Threads.tsx';
import { Walkthrough } from './Walkthrough.tsx';

const NO_NOTES: readonly SideNote[] = [];

/**
 * Tour mode: the overview, then every review group in tour order, on one page. The sidebar,
 * the sub-bar and the keyboard jump between them; scrolling moves the current position.
 * Everything renders from the tour program's model (`tour-model.ts`), which fills in as
 * stages stream in. Keyboard first: see `SHORTCUTS`.
 */
export function TourPage({ sourceRef }: { sourceRef: SourceRef }) {
  const router = useRouter();
  const [program] = useState(() => tourProgram(sourceRef, router));
  useAtomMount(program.runner);
  const model = useAtomValue(program.model);
  const dispatch = useAtomSet(program.dispatch);
  const { tour: state, diff, viewed, expanded, navOpen, helpOpen, connection, connectionError } = model;
  const groups = useMemo(() => groupsInOrder(state), [state]);
  const homes = useMemo(() => walkHomes(groups), [groups]);
  const walkStop = hasWalkStop(state, groups);
  // The key code paths have one panel for the whole page, beside the groups.
  const frames = state.walkthrough?.frames;
  const pathsOn = useMemo(() => pathsShown(state), [state.walkthrough, state.files]);
  const pathsScope = useRef<HTMLDivElement>(null);
  const pathsPanel = useRef<HTMLDivElement>(null);
  const [pathsReserve, setPathsReserve] = useState(0);
  const paths = useMemo(
    () => (pathsOn ? { panel: pathsPanel, reserve: pathsReserve } : undefined),
    [pathsOn, pathsReserve],
  );
  // The walkthrough stop shows only what nothing else reads: not the code paths while the panel has them.
  const leftover = useMemo(
    () => (state.walkthrough && pathsOn ? { ...state.walkthrough, frames: [], steps: [] } : state.walkthrough),
    [state.walkthrough, pathsOn],
  );
  const files = useMemo(() => new Map(state.files.map((file) => [file.id, file])), [state.files]);
  const fileIds = useMemo(() => new Map(state.files.map((file) => [file.path, file.id])), [state.files]);
  const current = currentGroup(model, groups);
  // Every note of the tour, numbered down the page: the panel's calls carry their numbers.
  const allNotes = useMemo(() => sideNotes(state, groups, homes), [state.decisions, state.walkthrough, groups, homes]);
  const groupNotes = useMemo(() => Map.groupBy(allNotes, (note) => note.groupKey), [allNotes]);
  const inFrame = useMemo(
    () => noteFrames(frames ?? [], allNotes, (fileId) => files.get(fileId)?.path),
    [frames, allNotes, files],
  );
  const index = current ? groups.indexOf(current) : -1;
  // The neighbouring stops: the overview, the walkthrough when there is one, then the groups.
  const selected = selectedKey(model, groups);
  const stops = tourStops(model, groups);
  const at = stops.findIndex((stop) => stop.key === selected);
  const prev = stops[at - 1];
  const next = stops[at + 1];
  const running = isRunning(model);
  const select = (key: string) => dispatch({ type: 'GroupSelected', key });
  const jumpToFile = useCallback(
    (fileId: string, line?: number) => dispatch({ type: 'FileJumped', fileId, line }),
    [dispatch],
  );
  const reviewable = canReview(model);
  const askable = canAsk(model);
  const { review } = model;
  const reviewer = useMemo<Reviewer | undefined>(
    () =>
      reviewable
        ? {
            start: (anchor, place) => dispatch({ type: 'CommentStarted', anchor, place }),
            edit: (id, place) => dispatch({ type: 'CommentEdited', id, place }),
            change: (body) => dispatch({ type: 'CommentBodyChanged', body }),
            cancel: () => dispatch({ type: 'CommentCancelled' }),
            save: () => dispatch({ type: 'CommentSaved' }),
            remove: (id) => dispatch({ type: 'CommentRemoved', id }),
            toggleQuote: () => dispatch({ type: 'CommentQuoteToggled' }),
            ask: askable ? () => dispatch({ type: 'CommentAsked' }) : undefined,
          }
        : undefined,
    [reviewable, askable, dispatch],
  );
  const { threads } = model;
  const threadControls = useMemo<ThreadControls | undefined>(
    () =>
      threads.list
        ? {
            threads,
            act: !model.exported,
            toggleFold: (threadId) => dispatch({ type: 'ThreadFoldToggled', threadId }),
            startReply: (threadId) => dispatch({ type: 'ReplyStarted', threadId }),
            changeReply: (body) => dispatch({ type: 'ReplyChanged', body }),
            cancelReply: () => dispatch({ type: 'ReplyCancelled' }),
            submitReply: () => dispatch({ type: 'ReplySubmitted' }),
            resolve: (threadId) => dispatch({ type: 'ThreadResolveClicked', threadId }),
          }
        : undefined,
    [threads, model.exported, dispatch],
  );
  const controls: FileControls = useMemo(
    () => ({
      expanded,
      viewed,
      onToggleExpanded: (fileId) => dispatch({ type: 'ExpandedToggled', fileId }),
      unfolded: model.unfolded,
      onUnfoldHunks: (fileId) => dispatch({ type: 'HunksUnfolded', fileId }),
      onToggleViewed: (fileId) => dispatch({ type: 'ViewedToggled', fileId }),
      review,
      reviewer,
      threads: threadControls,
    }),
    [expanded, viewed, model.unfolded, dispatch, review, reviewer, threadControls],
  );
  // The current note's actions start where a gutter click or the Ask button would, on its lines.
  const noteActions = useMemo<NoteActions>(
    () => ({
      select: (id) => dispatch({ type: 'NoteSelected', id }),
      comment: reviewable
        ? (note: SideNote) => {
            const { fileId, side, from, to } = note;
            if (fileId !== undefined && to !== undefined) {
              dispatch({
                type: 'CommentStarted',
                anchor: { fileId, side: side ?? 'additions', line: to, startLine: from === to ? undefined : from },
                quote: noteQuote(note),
              });
            }
          }
        : undefined,
      ask: askable
        ? ({ fileId, side, from, to }: SideNote) =>
            dispatch({ type: 'AskOpened', context: { fileId, side: from === undefined ? undefined : side, from, to } })
        : undefined,
    }),
    [reviewable, askable, dispatch],
  );
  const activeNote = model.activeNote;
  const activeGroup = activeNote === undefined ? undefined : noteGroup(activeNote);
  // "Note 7 of 12", while one is current.
  const noted = useMemo(() => {
    const at = allNotes.find((note) => note.id === activeNote);
    return at && { n: at.n, of: allNotes.length };
  }, [allNotes, activeNote]);
  const reviewed = current ? current.fileIds.filter((id) => viewed.has(id)).length : 0;

  return (
    <div className="app" data-ask-open={model.ask.open}>
      <header className="topbar">
        {model.exported ? (
          <span className="brand">
            <Logo />
          </span>
        ) : (
          <Link to="/" className="brand">
            <Logo />
          </Link>
        )}
        {state.cached && (
          <span className="topbar-cached">
            <Text color="secondary" size="sm">
              cached
            </Text>
          </span>
        )}
        <div className="toolbar">
          {!model.exported && <AutoToursSwitch />}
          {reviewable && (
            <ReviewPanel review={review} chord={model.chord === 'r'} dispatch={dispatch}>
              <Button
                size="sm"
                variant="primary"
                label={review.comments.length ? `Review (${review.comments.length})` : 'Review'}
              />
            </ReviewPanel>
          )}
          {state.meta?.url && (
            <IconButton
              size="sm"
              variant="ghost"
              label="Open on GitHub"
              tooltip="Open on GitHub"
              icon={<Icon icon={GithubIcon} />}
              href={state.meta.url}
              target="_blank"
              rel="noreferrer"
            />
          )}
          {!model.exported && (
            <>
              {running ? (
                <IconButton
                  size="sm"
                  variant="ghost"
                  label="Stop tour"
                  tooltip="Stop"
                  icon={<Icon icon={SquareIcon} />}
                  onClick={() => dispatch({ type: 'StopClicked' })}
                />
              ) : (
                <IconButton
                  size="sm"
                  variant="ghost"
                  label="Re-run tour"
                  tooltip="Re-run"
                  icon={<Icon icon={RotateCwIcon} />}
                  onClick={() => dispatch({ type: 'RerunClicked' })}
                />
              )}
              {threads.list && threads.list.length > 0 && (
                <IconButton
                  size="sm"
                  variant={threads.open ? 'secondary' : 'ghost'}
                  label={`Comments, ${openThreads(threads)} open`}
                  tooltip="Comments (c)"
                  icon={<Icon icon={MessagesSquareIcon} />}
                  onClick={() => dispatch({ type: 'CommentsToggled' })}
                />
              )}
              <IconButton
                size="sm"
                variant={model.ask.open ? 'secondary' : 'ghost'}
                label="Ask"
                tooltip="Ask (q)"
                icon={<Icon icon={MessageCircleQuestionIcon} />}
                isDisabled={!askable && !model.ask.open}
                onClick={() => dispatch({ type: 'AskToggled' })}
              />
            </>
          )}
          <IconButton
            size="sm"
            variant="ghost"
            label="Pipeline"
            tooltip="Pipeline (d)"
            icon={<Icon icon={WorkflowIcon} />}
            onClick={() => dispatch({ type: 'PipelineOpened' })}
          />
          <span className="shortcuts-button">
            <IconButton
              size="sm"
              variant="ghost"
              label="Keyboard shortcuts"
              tooltip="Shortcuts (?)"
              icon={<Icon icon={KeyboardIcon} />}
              onClick={() => dispatch({ type: 'HelpSet', open: true })}
            />
          </span>
        </div>
      </header>

      <div className="tour" data-nav-open={navOpen} data-rail-hidden={model.railHidden || undefined}>
        {navOpen && <div className="nav-scrim" aria-hidden="true" onClick={() => dispatch({ type: 'NavClosed' })} />}
        <GroupSidebar
          sourceRef={sourceRef}
          stack={model.stack}
          title={state.meta?.title}
          author={state.meta?.author}
          groups={groups}
          files={files}
          selection={selected}
          walkthrough={walkStop}
          activeFileId={model.activeFileId}
          viewed={viewed}
          loading={running}
          sidebar={model.sidebar}
          dispatch={dispatch}
        />
        <main className="main">
          <PullHead
            state={state}
            pull={currentPull(model)}
            groups={groups}
            reviewers={model.exported ? undefined : model.reviewers}
            dispatch={dispatch}
          />
          <div className="subbar">
            <span className="rail-toggle">
              <IconButton
                variant="ghost"
                size="sm"
                label={model.railHidden ? 'Show groups' : 'Hide groups'}
                tooltip={model.railHidden ? 'Show groups' : 'Hide groups'}
                icon={<Icon icon={model.railHidden ? PanelLeftOpenIcon : PanelLeftCloseIcon} />}
                onClick={() =>
                  // On a touch screen a hidden rail comes back over the page, so the notes keep their column.
                  dispatch({
                    type: model.railHidden && matchMedia('(pointer: coarse)').matches ? 'NavToggled' : 'RailToggled',
                  })
                }
              />
            </span>
            <span className="nav-toggle">
              <Button
                size="sm"
                variant="secondary"
                label={navOpen ? 'Close groups' : 'Groups'}
                onClick={() => dispatch({ type: 'NavToggled' })}
              />
            </span>
            {/* Where you are in the tour, and the way to the neighbouring stops. */}
            <ButtonGroup label="Groups" size="sm">
              <IconButton
                variant="ghost"
                label="Previous group"
                tooltip={prev ? `Previous: ${prev.label} (k)` : 'Previous group (k)'}
                icon={<Icon icon={ChevronLeftIcon} />}
                isDisabled={!prev}
                onClick={() => prev && select(prev.key)}
              />
              <IconButton
                variant="ghost"
                label="Next group"
                tooltip={next ? `Next: ${next.label} (j)` : 'Next group (j)'}
                icon={<Icon icon={ChevronRightIcon} />}
                isDisabled={!next}
                onClick={() => next && select(next.key)}
              />
            </ButtonGroup>
            <nav className="subbar-crumbs" aria-label="Tour position">
              {selected !== OVERVIEW ? (
                <>
                  <button type="button" className="crumb" title="Overview (o)" onClick={() => select(OVERVIEW)}>
                    Overview
                  </button>
                  <span className="crumb-sep" aria-hidden="true">
                    /
                  </span>
                  <strong aria-current="step">{stops[at]?.label}</strong>
                </>
              ) : (
                <strong aria-current="step">Overview</strong>
              )}
            </nav>
            {current && (
              <span className="subbar-position">
                Group {index + 1} of {groups.length}
                {noted ? ` · Note ${noted.n} of ${noted.of}` : ''}
                {reviewed ? ` · ${reviewed} of ${current.fileIds.length} files viewed` : ''}
              </span>
            )}
          </div>

          <div className="content">
            {connection === 'error' && connectionError && (
              <Banner status="error" title={connectionError.title} description={connectionError.message} />
            )}
            {state.error && (
              <Banner
                status="error"
                title={`Tour failed (${state.error.stage ?? 'pipeline'})`}
                description={state.error.message}
              />
            )}
            {review.sent && (
              <Banner
                status="success"
                title={SENT_LABEL[review.sent.verdict]}
                isDismissable
                onDismiss={() => dispatch({ type: 'ReviewNoticeDismissed' })}
                endContent={
                  <a href={review.sent.url} target="_blank" rel="noreferrer">
                    View on GitHub
                  </a>
                }
              />
            )}
            {state.status === 'aborted' && (
              <Banner status="warning" title="Tour stopped" description="Re-run to start it again." />
            )}

            <section className="stop" id={`group-${OVERVIEW}`} data-group-key={OVERVIEW}>
              {state.meta || !running ? (
                <Overview
                  state={state}
                  groups={groups}
                  running={running}
                  onJumpToFile={jumpToFile}
                  onSelectGroup={select}
                  homes={homes}
                  walkStop={walkStop}
                />
              ) : (
                <Skeleton height={160} />
              )}
            </section>
            {state.walkthrough && walkStop && (
              <section className="stop" id={`group-${WALKTHROUGH}`} data-group-key={WALKTHROUGH}>
                <Walkthrough
                  walkthrough={leftover ?? state.walkthrough}
                  moved={homes}
                  decisions={state.decisions ?? []}
                  diff={diff}
                  onJumpToFile={jumpToFile}
                  comments={review.comments}
                  composing={review.composing?.place ? review.composing : undefined}
                  reviewer={reviewer}
                />
              </section>
            )}
            <div className="paths-scope">
              <div className="paths-body" ref={pathsScope} data-paths={pathsOn || undefined}>
                {pathsOn && frames && (
                  <KeyPaths
                    frames={frames}
                    fileIds={fileIds}
                    scope={pathsScope}
                    panel={pathsPanel}
                    notes={allNotes}
                    inFrame={inFrame}
                    activeNote={activeNote}
                    onSelectNote={noteActions.select}
                    onJumpToFile={jumpToFile}
                    onReserve={setPathsReserve}
                  />
                )}
                {groups.map((group) => (
                  <section className="stop" key={group.key} id={`group-${group.key}`} data-group-key={group.key}>
                    <GroupPanel
                      group={group}
                      state={state}
                      diff={diff}
                      controls={controls}
                      onJumpToFile={jumpToFile}
                      notes={groupNotes.get(group.key) ?? NO_NOTES}
                      paths={paths}
                      activeNote={activeGroup === group.key ? activeNote : undefined}
                      noteActions={noteActions}
                    />
                  </section>
                ))}
              </div>
            </div>
          </div>
        </main>
      </div>
      {threads.open && (
        <CommentsPanel
          threads={threads}
          files={state.files}
          fileOrder={fileOrder(groups)}
          onJump={jumpToFile}
          onToggleResolved={() => dispatch({ type: 'ResolvedShownToggled' })}
          onClose={() => dispatch({ type: 'CommentsClosed' })}
        />
      )}
      {model.ask.open && <AskPanel ask={model.ask} files={state.files} enabled={askable} dispatch={dispatch} />}
      <ShortcutHelp isOpen={helpOpen} onOpenChange={(open) => dispatch({ type: 'HelpSet', open })} />
    </div>
  );
}
