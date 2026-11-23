import type { CallFrame } from '@gloss/protocol';
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { lineRow } from '../lib/diff-dom.ts';
import { callLocations } from '../lib/excerpt.ts';
import type { SideNote } from '../lib/side-notes.ts';
import { keyPaths } from '../lib/tour-view.ts';
import { FlagIcon } from './icons.tsx';

/** The space between the panel and the notes that wait below it, in px. */
const GAP = 6;

const label = (frame: CallFrame) => `${frame.receiver ? `${frame.receiver}.` : ''}${frame.name}`;

/**
 * The key code paths of the change, for the whole page: each entry point and the calls under it
 * is one path. The panel sits at the top of the groups' notes column and stays with the screen
 * through every group, so a call can be followed into any group without losing the paths. The
 * path whose code is on screen is open and its call is marked; the others are one line until
 * opened. A call carries the numbers of the notes on its lines, from any group.
 *
 * The panel shows only the way to the call on screen, so the notes below it keep their room: the
 * entry point, the calls above the call, and the call. "All calls" opens every path.
 *
 * In a page too narrow for the column the paths are one line under the sub-bar that opens them.
 */
export function KeyPaths({
  frames,
  fileIds,
  scope,
  panel,
  notes,
  inFrame,
  activeNote,
  onSelectNote,
  onJumpToFile,
  onReserve,
}: {
  frames: readonly CallFrame[];
  /** A changed file's id, by its path. */
  fileIds: ReadonlyMap<string, string>;
  /** The groups, which the panel stays beside. */
  scope: RefObject<HTMLElement | null>;
  /** The panel's box, for the notes columns to keep clear of. */
  panel: RefObject<HTMLDivElement | null>;
  /** The tour's notes, and the call each one is in. */
  notes: readonly SideNote[];
  inFrame: ReadonlyMap<string, number>;
  activeNote: string | undefined;
  onSelectNote: (id: string) => void;
  onJumpToFile: (fileId: string, line?: number) => void;
  /** The room the panel takes at the column's top, in px; 0 while the page has no column. */
  onReserve: (px: number) => void;
}) {
  const paths = useMemo(() => keyPaths(frames), [frames]);
  const track = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDetailsElement>(null);
  /** Where each call's code is, from the top of the document. */
  const tops = useRef<(number | undefined)[]>([]);
  const [scrolled, setOn] = useState(-1);
  // The current note says where the reader is: its call is the marked one, not a nearer call.
  const on = (activeNote === undefined ? undefined : inFrame.get(activeNote)) ?? scrolled;
  const [held, setHeld] = useState<ReadonlySet<number>>(new Set());
  const [all, setAll] = useState(false);
  const trail = !all;

  const place = useRef(() => {});
  const measure = useRef(() => {});
  place.current = () => {
    const middle = window.scrollY + window.innerHeight / 2;
    let next = -1;
    tops.current.forEach((top, index) => {
      if (top !== undefined && top <= middle && top >= (tops.current[next] ?? -Infinity)) {
        next = index;
      }
    });
    setOn(next);
  };
  /** Costly (it searches the diffs), so only when the page changes shape. */
  measure.current = () => {
    tops.current = frames.map((frame) => {
      const fileId = frame.path === undefined ? undefined : fileIds.get(frame.path);
      if (fileId === undefined) {
        return undefined;
      }
      // A call whose line the diff does not show is read at its file.
      const at =
        (frame.line === undefined ? undefined : lineRow(fileId, frame.line)) ??
        document.getElementById(`file-${fileId}`);
      return at ? at.getBoundingClientRect().top + window.scrollY : undefined;
    });
    // The panel starts level with the first group's column.
    const box = scope.current;
    const column = box?.querySelector('.note-lane[data-side]');
    if (box && column && track.current) {
      track.current.style.top = `${column.getBoundingClientRect().top - box.getBoundingClientRect().top}px`;
    }
    place.current();
  };

  useLayoutEffect(() => measure.current());

  useEffect(() => {
    const shape = new ResizeObserver(() => measure.current());
    if (scope.current) {
      shape.observe(scope.current);
    }
    const size = new ResizeObserver(() =>
      onReserve(panel.current?.offsetHeight ? panel.current.offsetHeight + GAP : 0),
    );
    if (panel.current) {
      size.observe(panel.current);
    }
    let frame = 0;
    const onScroll = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        place.current();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      shape.disconnect();
      size.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      onReserve(0);
    };
  }, [scope, panel, onReserve]);

  // The path on screen; the first one before any of the paths' code is reached.
  const current = Math.max(
    paths.findIndex((path) => path.includes(on)),
    0,
  );
  const toggle = (index: number) =>
    setHeld((before) => {
      const next = new Set(before);
      if (!next.delete(index)) {
        next.add(index);
      }
      return next;
    });
  // The narrow page's list closes on a choice, so it is not over the code the choice goes to.
  const close = () => {
    if (bar.current) {
      bar.current.open = false;
    }
  };
  const jump = (fileId: string, line: number | undefined) => {
    close();
    onJumpToFile(fileId, line);
  };
  const selectNote = (id: string) => {
    close();
    onSelectNote(id);
  };
  const root = frames[paths[current]?.[0] ?? -1];
  const frame = frames[on];
  // The way to the call on screen: the calls it is under, and itself. Before any call, the entry point.
  const way = useMemo(() => {
    const path = paths[current] ?? [];
    const kept = new Set<number>(path.slice(0, 1));
    if (path.includes(on)) {
      kept.add(on);
      let depth = frames[on]!.depth;
      for (let index = on - 1; index >= path[0]!; index--) {
        if (frames[index]!.depth < depth) {
          kept.add(index);
          depth = frames[index]!.depth;
        }
      }
    }
    return kept;
  }, [paths, current, on, frames]);
  const list = (cut: boolean) => (
    <div className="key-paths-list">
      {paths.map((path, index) =>
        cut && index !== current ? null : (
          <Path
            key={index}
            frames={frames}
            path={path}
            only={cut ? way : undefined}
            open={cut || all || index === current || held.has(index)}
            on={on}
            fileIds={fileIds}
            notes={notes}
            inFrame={inFrame}
            activeNote={activeNote}
            onToggle={() => toggle(index)}
            onSelectNote={selectNote}
            onJump={jump}
          />
        ),
      )}
    </div>
  );
  const kinds = new Set(frames.map((entry) => entry.status));
  return (
    <>
      <details className="key-paths-bar" ref={bar}>
        <summary>
          <span>Key code paths</span>
          {frame && root && <code>{frame === root ? label(frame) : `${label(root)} › ${label(frame)}`}</code>}
        </summary>
        {list(false)}
      </details>
      <div className="key-paths-track" ref={track}>
        <div className="key-paths" ref={panel}>
          <div className="key-paths-head">
            <span>Key code paths</span>
            {frames.length > 1 && (
              <button type="button" className="key-paths-all" aria-expanded={all} onClick={() => setAll(!all)}>
                {all ? 'Less' : `All ${frames.length} calls`}
              </button>
            )}
            {!trail && kinds.has('changed') && (
              <span className="key-paths-key">
                <span className="walk-mark changed" />
                changed
              </span>
            )}
            {!trail && kinds.has('new') && (
              <span className="key-paths-key">
                <span className="walk-mark new" />
                new
              </span>
            )}
          </div>
          {list(trail)}
        </div>
      </div>
    </>
  );
}

/** One path: its entry point, and under it the calls when it is open. */
function Path({
  frames,
  path,
  only,
  open,
  on,
  fileIds,
  notes,
  inFrame,
  activeNote,
  onToggle,
  onSelectNote,
  onJump,
}: {
  frames: readonly CallFrame[];
  path: readonly number[];
  /** The calls to show, when the panel keeps to the way to one call. */
  only?: ReadonlySet<number>;
  open: boolean;
  on: number;
  fileIds: ReadonlyMap<string, string>;
  notes: readonly SideNote[];
  inFrame: ReadonlyMap<string, number>;
  activeNote: string | undefined;
  onToggle: () => void;
  onSelectNote: (id: string) => void;
  onJump: (fileId: string, line: number | undefined) => void;
}) {
  const locations = useMemo(() => callLocations(path.map((index) => frames[index]!)), [frames, path]);
  const shown = open ? path : path.slice(0, 1);
  return (
    <div className="key-path" data-open={open || undefined}>
      {shown.map((index, at) => {
        if (only && !only.has(index)) {
          return null;
        }
        const frame = frames[index]!;
        const fileId = frame.path === undefined ? undefined : fileIds.get(frame.path);
        const location = locations[at]!;
        const file = location.startsWith(':') ? '' : location.replace(/:\d+$/, '');
        const name = (
          <>
            <span className={`walk-mark ${frame.status}`} />
            <code className="walk-call">
              {frame.receiver && `${frame.receiver}.`}
              <b>{frame.name}</b>
            </code>
          </>
        );
        return (
          <div
            key={index}
            className="key-path-row"
            data-active={index === on || undefined}
            style={{ paddingLeft: 4 + Math.min(frame.depth, 6) * 12 }}
          >
            {at === 0 && path.length > 1 && !only ? (
              <button
                type="button"
                className="key-path-fold"
                aria-expanded={open}
                aria-label={`The calls under ${label(frame)}`}
                onClick={onToggle}
              />
            ) : (
              <span className="key-path-fold" />
            )}
            {fileId !== undefined ? (
              <button
                type="button"
                className="key-path-call"
                title={frame.path}
                onClick={() => onJump(fileId, frame.line)}
              >
                {name}
              </button>
            ) : (
              <span className="key-path-call">{name}</span>
            )}
            {notes
              .filter((note) => inFrame.get(note.id) === index)
              .map((note) => (
                <button
                  key={note.id}
                  type="button"
                  className="note-chip"
                  data-current={note.id === activeNote || undefined}
                  title={note.title}
                  onClick={() => onSelectNote(note.id)}
                >
                  {note.level && <FlagIcon level={note.level} />}
                  {note.n}
                </button>
              ))}
            {open || path.length === 1 ? (
              <code className="walk-at">
                {file}
                <span>{location.slice(file.length)}</span>
              </code>
            ) : (
              <span className="key-path-count">{path.length} calls</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
