import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { ButtonGroup } from '@astryxdesign/core/ButtonGroup';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Text } from '@astryxdesign/core/Text';
import { useAtomMount, useAtomSet, useAtomValue } from '@effect/atom-react';
import type { SourceRef } from '@gloss/protocol';
import { describeRef, groupsInOrder } from '@gloss/protocol';
import { Link, useRouter } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  KeyboardIcon,
  RotateCwIcon,
  SquareIcon,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { SENT_LABEL } from '../lib/review-draft.ts';
import { canReview, currentGroup, isRunning } from '../lib/tour-model.ts';
import { tourProgram } from '../lib/tour-program.ts';
import { OVERVIEW } from '../lib/tour-view.ts';
import { type FileControls, GroupPanel } from './GroupPanel.tsx';
import { GroupSidebar } from './GroupSidebar.tsx';
import { Logo } from './Logo.tsx';
import { Overview } from './Overview.tsx';
import type { Reviewer } from './ReviewComments.tsx';
import { ReviewDialog } from './ReviewDialog.tsx';
import { ShortcutHelp } from './ShortcutHelp.tsx';
import { StageRail } from './StageRail.tsx';

/**
 * Tour mode: an overview, then one review group at a time. Everything renders from the
 * tour program's model (`tour-model.ts`), which fills in as stages stream in. Keyboard
 * first: see `SHORTCUTS`.
 */
export function TourPage({ sourceRef }: { sourceRef: SourceRef }) {
  const router = useRouter();
  const [program] = useState(() => tourProgram(sourceRef, router));
  useAtomMount(program.runner);
  const model = useAtomValue(program.model);
  const dispatch = useAtomSet(program.dispatch);
  const { tour: state, diff, viewed, expanded, navOpen, helpOpen, connection, connectionError } = model;
  const groups = useMemo(() => groupsInOrder(state), [state]);
  const files = useMemo(() => new Map(state.files.map((file) => [file.id, file])), [state.files]);
  const current = currentGroup(model, groups);
  const index = current ? groups.indexOf(current) : -1;
  // From the overview (index -1), "next" is the first group.
  const prev = index > 0 ? groups[index - 1] : undefined;
  const next = groups[index + 1];
  const running = isRunning(model);
  const select = useCallback((key: string) => dispatch({ type: 'GroupSelected', key }), [dispatch]);
  const jumpToFile = useCallback((fileId: string) => dispatch({ type: 'FileJumped', fileId }), [dispatch]);
  const reviewable = canReview(model);
  const { review } = model;
  const reviewer = useMemo<Reviewer | undefined>(
    () =>
      reviewable
        ? {
            start: (anchor) => dispatch({ type: 'CommentStarted', anchor }),
            edit: (id) => dispatch({ type: 'CommentEdited', id }),
            change: (body) => dispatch({ type: 'CommentBodyChanged', body }),
            cancel: () => dispatch({ type: 'CommentCancelled' }),
            save: () => dispatch({ type: 'CommentSaved' }),
            remove: (id) => dispatch({ type: 'CommentRemoved', id }),
          }
        : undefined,
    [reviewable, dispatch],
  );
  const controls: FileControls = useMemo(
    () => ({
      expanded,
      viewed,
      onToggleExpanded: (fileId) => dispatch({ type: 'ExpandedToggled', fileId }),
      onToggleViewed: (fileId) => dispatch({ type: 'ViewedToggled', fileId }),
      onJumpToFile: jumpToFile,
      review,
      reviewer,
    }),
    [expanded, viewed, dispatch, jumpToFile, review, reviewer],
  );
  const reviewed = current ? current.fileIds.filter((id) => viewed.has(id)).length : 0;

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <Logo />
        </Link>
        <div className="topbar-meta">
          <span className="topbar-ref">
            <Text color="secondary" size="sm">
              {describeRef(sourceRef)}
            </Text>
          </span>
          <span className="topbar-title">
            {state.meta ? (
              state.meta.url ? (
                <a href={state.meta.url} target="_blank" rel="noreferrer">
                  {state.meta.title}
                </a>
              ) : (
                state.meta.title
              )
            ) : null}
          </span>
        </div>
        {state.cached && (
          <span className="topbar-cached">
            <Text color="secondary" size="sm">
              cached
            </Text>
          </span>
        )}
        {/* Pipeline progress matters while it runs or when a stage broke; a clean finish needs no rail. */}
        {(running || Object.values(state.stages).some((stage) => stage.state === 'failed')) && (
          <StageRail stages={state.stages} />
        )}
        <div className="toolbar">
          {reviewable && (
            <Button
              size="sm"
              variant="secondary"
              label={review.comments.length ? `Review (${review.comments.length})` : 'Review'}
              tooltip="Approve r a · Request changes r n · Comment r c"
              onClick={() => dispatch({ type: 'ReviewOpened' })}
            />
          )}
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
          <IconButton
            size="sm"
            variant="ghost"
            label="Keyboard shortcuts"
            tooltip="Shortcuts (?)"
            icon={<Icon icon={KeyboardIcon} />}
            onClick={() => dispatch({ type: 'HelpSet', open: true })}
          />
        </div>
      </header>

      <div className="tour" data-nav-open={navOpen}>
        {navOpen && <div className="nav-scrim" aria-hidden="true" onClick={() => dispatch({ type: 'NavClosed' })} />}
        <GroupSidebar
          sourceRef={sourceRef}
          title={state.meta?.title}
          groups={groups}
          files={files}
          selection={current?.key ?? OVERVIEW}
          activeFileId={model.activeFileId}
          viewed={viewed}
          loading={running}
          sidebar={model.sidebar}
          dispatch={dispatch}
        />
        <main className="main">
          <div className="subbar">
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
                tooltip={prev ? `Previous: ${prev.label} (k)` : current ? 'Overview (k)' : 'Previous group (k)'}
                icon={<Icon icon={ChevronLeftIcon} />}
                isDisabled={!current}
                onClick={() => select(prev ? prev.key : OVERVIEW)}
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
              {current ? (
                <>
                  <button type="button" className="crumb" title="Overview (o)" onClick={() => select(OVERVIEW)}>
                    Overview
                  </button>
                  <span className="crumb-sep" aria-hidden="true">
                    /
                  </span>
                  <strong aria-current="step">{current.label}</strong>
                </>
              ) : (
                <strong aria-current="step">Overview</strong>
              )}
            </nav>
            {current && (
              <span className="subbar-position">
                Group {index + 1} of {groups.length}
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

            {current ? (
              <>
                <GroupPanel key={current.key} group={current} state={state} diff={diff} controls={controls} />
                <div className="group-nav">
                  <Button
                    size="sm"
                    variant="secondary"
                    label={prev ? prev.label : 'Overview'}
                    icon={<Icon icon={ArrowLeftIcon} />}
                    onClick={() => select(prev ? prev.key : OVERVIEW)}
                  />
                  {/* The tour ends where it began: the last group leads back to the overview and its decisions. */}
                  <Button
                    size="sm"
                    variant="primary"
                    label={next ? next.label : 'Overview'}
                    endContent={<Icon icon={ArrowRightIcon} />}
                    onClick={() => select(next ? next.key : OVERVIEW)}
                  />
                </div>
              </>
            ) : state.meta || !running ? (
              <Overview state={state} groups={groups} running={running} onSelect={select} onJumpToFile={jumpToFile} />
            ) : (
              <Skeleton height={160} />
            )}
          </div>
        </main>
      </div>
      <ReviewDialog review={review} dispatch={dispatch} />
      <ShortcutHelp isOpen={helpOpen} onOpenChange={(open) => dispatch({ type: 'HelpSet', open })} />
    </div>
  );
}
