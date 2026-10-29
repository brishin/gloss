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
  MapIcon,
  RotateCwIcon,
  SquareIcon,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { currentGroup, isRunning } from '../lib/tour-model.ts';
import { tourProgram } from '../lib/tour-program.ts';
import { OVERVIEW } from '../lib/tour-view.ts';
import { type FileControls, GroupPanel } from './GroupPanel.tsx';
import { GroupSidebar } from './GroupSidebar.tsx';
import { Overview } from './Overview.tsx';
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
  const controls: FileControls = useMemo(
    () => ({
      expanded,
      viewed,
      onToggleExpanded: (fileId) => dispatch({ type: 'ExpandedToggled', fileId }),
      onToggleViewed: (fileId) => dispatch({ type: 'ViewedToggled', fileId }),
      onJumpToFile: jumpToFile,
    }),
    [expanded, viewed, dispatch, jumpToFile],
  );
  const reviewed = current ? current.fileIds.filter((id) => viewed.has(id)).length : 0;

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          gloss
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
        <StageRail stages={state.stages} />
        {/* macOS-style toolbar: icon-only controls in grouped capsules, names in tooltips. */}
        <div className="toolbar">
          <ButtonGroup label="Groups" size="sm">
            <IconButton
              variant="secondary"
              label="Previous group"
              tooltip={prev ? `Previous: ${prev.label} (k)` : 'Previous group (k)'}
              icon={<Icon icon={ChevronLeftIcon} />}
              isDisabled={!current}
              onClick={() => select(prev ? prev.key : OVERVIEW)}
            />
            <IconButton
              variant="secondary"
              label="Overview"
              tooltip="Overview (o)"
              icon={<Icon icon={MapIcon} />}
              onClick={() => select(OVERVIEW)}
            />
            <IconButton
              variant="secondary"
              label="Next group"
              tooltip={next ? `Next: ${next.label} (j)` : 'Next group (j)'}
              icon={<Icon icon={ChevronRightIcon} />}
              isDisabled={!next}
              onClick={() => next && select(next.key)}
            />
          </ButtonGroup>
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
            <span className="subbar-crumbs">
              {current ? (
                <>
                  <strong>{current.label}</strong> · group {index + 1} of {groups.length} · {current.fileIds.length}{' '}
                  files{reviewed ? `, ${reviewed} viewed` : ''}
                  {state.meta ? ` · ${state.meta.baseRef} ← ${state.meta.headRef}` : ''}
                </>
              ) : (
                <>
                  <strong>Overview</strong>
                  {state.meta ? ` · ${state.meta.title} · ${state.meta.baseRef} ← ${state.meta.headRef}` : ''}
                </>
              )}
            </span>
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
                  {next && (
                    <Button
                      size="sm"
                      variant="primary"
                      label={next.label}
                      endContent={<Icon icon={ArrowRightIcon} />}
                      onClick={() => select(next.key)}
                    />
                  )}
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
      <ShortcutHelp isOpen={helpOpen} onOpenChange={(open) => dispatch({ type: 'HelpSet', open })} />
    </div>
  );
}
