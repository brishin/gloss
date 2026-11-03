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
  RotateCwIcon,
  SquareIcon,
  WorkflowIcon,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { SENT_LABEL } from '../lib/review-draft.ts';
import { canAsk, canReview, currentGroup, currentPull, isRunning, selectedKey, tourStops } from '../lib/tour-model.ts';
import { tourProgram } from '../lib/tour-program.ts';
import { OVERVIEW, WALKTHROUGH } from '../lib/tour-view.ts';
import { AskPanel } from './AskPanel.tsx';
import { type FileControls, GroupPanel } from './GroupPanel.tsx';
import { GroupSidebar } from './GroupSidebar.tsx';
import { Logo } from './Logo.tsx';
import { Overview, PullHead } from './Overview.tsx';
import type { Reviewer } from './ReviewComments.tsx';
import { ReviewPanel } from './ReviewPanel.tsx';
import { ShortcutHelp } from './ShortcutHelp.tsx';
import { Walkthrough } from './Walkthrough.tsx';

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
  const files = useMemo(() => new Map(state.files.map((file) => [file.id, file])), [state.files]);
  const current = currentGroup(model, groups);
  const index = current ? groups.indexOf(current) : -1;
  // The neighbouring stops: the overview, the walkthrough when there is one, then the groups.
  const selected = selectedKey(model, groups);
  const stops = tourStops(model, groups);
  const at = stops.findIndex((stop) => stop.key === selected);
  const prev = stops[at - 1];
  const next = stops[at + 1];
  const running = isRunning(model);
  const select = (key: string) => dispatch({ type: 'GroupSelected', key });
  const jumpToFile = useCallback((fileId: string) => dispatch({ type: 'FileJumped', fileId }), [dispatch]);
  const reviewable = canReview(model);
  const askable = canAsk(model);
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
            ask: askable ? () => dispatch({ type: 'CommentAsked' }) : undefined,
          }
        : undefined,
    [reviewable, askable, dispatch],
  );
  const controls: FileControls = useMemo(
    () => ({
      expanded,
      viewed,
      onToggleExpanded: (fileId) => dispatch({ type: 'ExpandedToggled', fileId }),
      onToggleViewed: (fileId) => dispatch({ type: 'ViewedToggled', fileId }),
      review,
      reviewer,
    }),
    [expanded, viewed, dispatch, review, reviewer],
  );
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
          {reviewable && (
            <ReviewPanel review={review} chord={model.chord === 'r'} dispatch={dispatch}>
              <Button
                size="sm"
                variant="primary"
                label={review.comments.length ? `Review (${review.comments.length})` : 'Review'}
              />
            </ReviewPanel>
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

      <div className="tour" data-nav-open={navOpen}>
        {navOpen && <div className="nav-scrim" aria-hidden="true" onClick={() => dispatch({ type: 'NavClosed' })} />}
        <GroupSidebar
          sourceRef={sourceRef}
          stack={model.stack}
          title={state.meta?.title}
          author={state.meta?.author}
          groups={groups}
          files={files}
          selection={selected}
          walkthrough={!!state.walkthrough}
          activeFileId={model.activeFileId}
          viewed={viewed}
          loading={running}
          sidebar={model.sidebar}
          dispatch={dispatch}
        />
        <main className="main">
          <PullHead state={state} pull={currentPull(model)} groups={groups} />
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
                />
              ) : (
                <Skeleton height={160} />
              )}
            </section>
            {state.walkthrough && (
              <section className="stop" id={`group-${WALKTHROUGH}`} data-group-key={WALKTHROUGH}>
                <Walkthrough
                  walkthrough={state.walkthrough}
                  decisions={state.decisions ?? []}
                  diff={diff}
                  onJumpToFile={jumpToFile}
                />
              </section>
            )}
            {groups.map((group) => (
              <section className="stop" key={group.key} id={`group-${group.key}`} data-group-key={group.key}>
                <GroupPanel group={group} state={state} diff={diff} controls={controls} />
              </section>
            ))}
          </div>
        </main>
      </div>
      {model.ask.open && <AskPanel ask={model.ask} files={state.files} enabled={askable} dispatch={dispatch} />}
      <ShortcutHelp isOpen={helpOpen} onOpenChange={(open) => dispatch({ type: 'HelpSet', open })} />
    </div>
  );
}
