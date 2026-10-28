import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { ButtonGroup } from '@astryxdesign/core/ButtonGroup';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Text } from '@astryxdesign/core/Text';
import type { SourceRef } from '@gloss/protocol';
import { describeRef, groupsInOrder } from '@gloss/protocol';
import { Link } from '@tanstack/react-router';
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OVERVIEW, orderedFileIds, STICKY_OFFSET, useViewed } from '../lib/tour-view.ts';
import { useTour } from '../lib/use-tour.ts';
import { type FileControls, GroupPanel, isFileExpanded } from './GroupPanel.tsx';
import { GroupSidebar } from './GroupSidebar.tsx';
import { Overview } from './Overview.tsx';
import { ShortcutHelp } from './ShortcutHelp.tsx';
import { StageRail } from './StageRail.tsx';

/** Keys typed into these elements are text, not shortcuts. */
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** The line a file or note must cross to count as "current": just below the sticky bars. */
const READING_LINE = STICKY_OFFSET + 16;

function scrollToTop() {
  window.scrollTo({ top: 0 });
}

/**
 * Tour mode: an overview, then one review group at a time. Everything renders from the
 * streamed `TourState`, so it fills in as stages land. Keyboard first: see `SHORTCUTS`.
 */
export function TourPage({ sourceRef }: { sourceRef: SourceRef }) {
  const { state, diff, connection, connectionError, rerun, abort } = useTour(sourceRef);
  const groups = useMemo(() => groupsInOrder(state), [state]);
  const files = useMemo(() => new Map(state.files.map((file) => [file.id, file])), [state.files]);
  const [selection, setSelection] = useState(OVERVIEW);
  // A group can disappear while streaming (heuristic groups give way to the model's): fall back to the overview.
  const current = groups.find((group) => group.key === selection);
  const selected = current ? current.key : OVERVIEW;
  const index = current ? groups.indexOf(current) : -1;
  // From the overview (index -1), "next" is the first group.
  const prev = index > 0 ? groups[index - 1] : undefined;
  const next = groups[index + 1];
  const order = useMemo(() => orderedFileIds(current), [current]);
  const running = state.status === 'running' || connection === 'connecting';
  const mainRef = useRef<HTMLElement>(null);
  const [activeFileId, setActiveFileId] = useState<string>();
  const [helpOpen, setHelpOpen] = useState(false);
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({});
  const { viewed, toggle: toggleViewedRaw } = useViewed(state.diffId);

  const select = useCallback((key: string) => {
    setSelection(key);
    setActiveFileId(undefined);
    scrollToTop();
  }, []);

  const jumpToFile = useCallback((fileId: string) => {
    setExpandedOverrides((overrides) => ({ ...overrides, [fileId]: overrides[fileId] ?? true }));
    // After the expansion renders, so the header lands under the sticky bars.
    requestAnimationFrame(() => document.getElementById(`file-${fileId}`)?.scrollIntoView({ block: 'start' }));
    setActiveFileId(fileId);
  }, []);

  const toggleExpanded = useCallback(
    (fileId: string) => {
      const file = files.get(fileId);
      if (!file) {
        return;
      }
      const expanded = isFileExpanded({ expandedOverrides, viewed }, current, file);
      setExpandedOverrides((overrides) => ({ ...overrides, [fileId]: !expanded }));
    },
    [files, expandedOverrides, viewed, current],
  );

  const toggleViewed = useCallback(
    (fileId: string) => {
      toggleViewedRaw(fileId);
      // Back to the default for the new viewed state: viewed files collapse, unviewed reopen.
      setExpandedOverrides((overrides) => {
        const next = { ...overrides };
        delete next[fileId];
        return next;
      });
    },
    [toggleViewedRaw],
  );

  // Scroll-spy: the current file is the last one whose top has crossed the reading line.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const sections = mainRef.current?.querySelectorAll<HTMLElement>('[data-file-id]') ?? [];
      let active: string | undefined;
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= READING_LINE) {
          active = section.dataset.fileId;
        }
      }
      setActiveFileId(active ?? sections[0]?.dataset.fileId);
    };
    const onScroll = () => {
      frame ||= requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [selected, order.length, diff]);

  // Keyboard shortcuts (listed in ShortcutHelp).
  useEffect(() => {
    const stops = [OVERVIEW, ...groups.map((group) => group.key)];
    const step = (by: number) => {
      const next = stops[stops.indexOf(selected) + by];
      if (next) {
        select(next);
      }
    };
    const stepFile = (by: number) => {
      const at = activeFileId ? order.indexOf(activeFileId) : -1;
      const next = order[at === -1 ? (by > 0 ? 0 : -1) : at + by];
      if (next) {
        jumpToFile(next);
      }
    };
    const stepNote = (by: number) => {
      const notes = [...(mainRef.current?.querySelectorAll<HTMLElement>('.note') ?? [])];
      const tops = notes.map((note) => note.getBoundingClientRect().top);
      const target =
        by > 0 ? tops.find((top) => top > READING_LINE + 1) : tops.findLast((top) => top < READING_LINE - 1);
      if (target !== undefined) {
        window.scrollBy({ top: target - READING_LINE });
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (event.target instanceof Element && event.target.closest(EDITABLE)) ||
        (helpOpen && event.key !== '?')
      ) {
        return;
      }
      const actions: Record<string, () => void> = {
        j: () => step(1),
        k: () => step(-1),
        o: () => select(OVERVIEW),
        n: () => stepFile(1),
        p: () => stepFile(-1),
        ']': () => stepNote(1),
        '[': () => stepNote(-1),
        x: () => activeFileId && toggleExpanded(activeFileId),
        v: () => {
          if (activeFileId) {
            const wasViewed = viewed.has(activeFileId);
            toggleViewed(activeFileId);
            if (!wasViewed) {
              stepFile(1);
            }
          }
        },
        '?': () => setHelpOpen((open) => !open),
      };
      const action = actions[event.key];
      if (action) {
        event.preventDefault();
        action();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [groups, selected, select, order, activeFileId, jumpToFile, toggleExpanded, toggleViewed, viewed, helpOpen]);

  const controls: FileControls = {
    expandedOverrides,
    viewed,
    onToggleExpanded: toggleExpanded,
    onToggleViewed: toggleViewed,
    onJumpToFile: jumpToFile,
  };
  const reviewed = current ? current.fileIds.filter((id) => viewed.has(id)).length : 0;

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          gloss
        </Link>
        <div className="topbar-meta">
          <Text color="secondary" size="sm">
            {describeRef(sourceRef)}
          </Text>
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
          <Text color="secondary" size="sm">
            cached
          </Text>
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
              onClick={abort}
            />
          ) : (
            <IconButton
              size="sm"
              variant="ghost"
              label="Re-run tour"
              tooltip="Re-run"
              icon={<Icon icon={RotateCwIcon} />}
              onClick={rerun}
            />
          )}
          <IconButton
            size="sm"
            variant="ghost"
            label="Keyboard shortcuts"
            tooltip="Shortcuts (?)"
            icon={<Icon icon={KeyboardIcon} />}
            onClick={() => setHelpOpen(true)}
          />
        </div>
      </header>

      <div className="tour">
        <GroupSidebar
          groups={groups}
          files={files}
          selection={selected}
          activeFileId={activeFileId}
          viewed={viewed}
          loading={running}
          onSelect={select}
          onSelectFile={jumpToFile}
        />
        <main className="main" ref={mainRef}>
          <div className="subbar">
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
              <Overview state={state} groups={groups} running={running} onSelect={select} />
            ) : (
              <Skeleton height={160} />
            )}
          </div>
        </main>
      </div>
      <ShortcutHelp isOpen={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}
