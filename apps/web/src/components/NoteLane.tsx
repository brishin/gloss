import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import type { CallFrame, FileSummary } from '@gloss/protocol';
import { MessageCircleQuestionIcon, MessageSquarePlusIcon } from 'lucide-react';
import { type CSSProperties, memo, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { lineRow } from '../lib/diff-dom.ts';
import { noteFrames, noteLines, type SideNote } from '../lib/side-notes.ts';
import { splitPath } from '../lib/tour-view.ts';
import { FlagIcon } from './icons.tsx';
import { inlineCode } from './Walkthrough.tsx';

/** A note held at the column's edge is one line: its height and the space between notes, in px. */
const PIN = 30;
const GAP = 6;
/** A note's top sits this far above its first line, so its title is level with the line. */
const LIFT = 5;
/** Where a note's leader meets it, below its top. */
const HEAD = 15;

/** Where a note's lines are, from the column's top; `found` is false while the diff does not show them. */
interface Spot {
  top: number;
  height: number;
  found: boolean;
}

interface Pins {
  top: readonly string[];
  bottom: readonly string[];
}

const NO_PINS: Pins = { top: [], bottom: [] };
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, at) => id === b[at]);

export interface NoteActions {
  /** Makes a note current and brings its lines mid-screen. */
  select: (id: string) => void;
  /** Starts a review comment on the note's lines; undefined when the change takes none. */
  comment?: (note: SideNote) => void;
  /** Opens Ask on the note's lines; undefined until the tour can be asked about. */
  ask?: (note: SideNote) => void;
}

/**
 * A group's decisions and walk stops as notes in a column beside its diffs, each next to the
 * lines it is about. A note rides with its lines; one whose lines are off screen waits at the
 * column's top or bottom edge as its title, so the column always lists what is above and below.
 * The page's key code paths panel (`KeyPaths.tsx`) shares the column: notes wait below it.
 *
 * In a page too narrow for a column the notes are a list above the diffs.
 */
export const NoteLane = memo(function NoteLane({
  notes,
  files,
  filesBox,
  active,
  actions,
  onJumpToFile,
  frames,
  panel,
  reserve = 0,
}: {
  notes: readonly SideNote[];
  files: ReadonlyMap<string, FileSummary>;
  /** The group's diffs, which the column sits beside. */
  filesBox: RefObject<HTMLDivElement | null>;
  /** The current note, when it is one of these. */
  active: string | undefined;
  actions: NoteActions;
  onJumpToFile: (fileId: string, line?: number) => void;
  /** The calls of the key code paths: a note says which one its lines are in. */
  frames?: readonly CallFrame[];
  /** The key code paths panel, which stays over the top of the column. */
  panel?: RefObject<HTMLElement | null>;
  /** The room the panel takes at the column's top while it stays with the screen, in px. */
  reserve?: number;
}) {
  const lane = useRef<HTMLElement>(null);
  const topBox = useRef<HTMLDivElement>(null);
  const wash = useRef<HTMLDivElement>(null);
  const heldLeader = useRef<SVGPathElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const anchors = useRef(new Map<string, HTMLElement>());
  const leaders = useRef(new Map<string, SVGPathElement>());
  const spots = useRef(new Map<string, Spot>());
  const retries = useRef(0);
  const [side, setSide] = useState(false);
  const [pins, setPins] = useState<Pins>(NO_PINS);

  const inFrame = useMemo(
    () => noteFrames(frames ?? [], notes, (fileId) => files.get(fileId)?.path),
    [frames, notes, files],
  );

  /** Reads where every note's lines are. Costly (it searches the diffs), so only when the page changes shape. */
  const measure = () => {
    const column = lane.current;
    if (!column) {
      return;
    }
    const origin = column.getBoundingClientRect().top;
    let waiting = false;
    const lineSpot = (fileId: string, from: number | undefined, to: number | undefined, deleted: boolean): Spot => {
      const row = from === undefined ? undefined : lineRow(fileId, from, deleted);
      if (row) {
        const top = row.getBoundingClientRect().top;
        const last = to !== undefined && to !== from ? (lineRow(fileId, to, deleted) ?? row) : row;
        return { top: top - origin, height: Math.max(last.getBoundingClientRect().bottom - top, 0), found: true };
      }
      // Not drawn (folded, collapsed, or still rendering): the note waits at its file's header.
      const section = document.getElementById(`file-${fileId}`);
      waiting ||= from !== undefined && section?.dataset.expanded === 'true';
      return { top: (section?.getBoundingClientRect().top ?? origin) - origin + 8, height: 16, found: false };
    };
    spots.current = new Map(
      notes.map((note) => [
        note.id,
        note.fileId === undefined
          ? { top: 0, height: 0, found: false }
          : lineSpot(note.fileId, note.from, note.to, note.side === 'deletions'),
      ]),
    );
    for (const note of notes) {
      const spot = spots.current.get(note.id)!;
      const anchor = anchors.current.get(note.id);
      if (anchor) {
        anchor.style.top = `${spot.top}px`;
        anchor.style.height = `${spot.height}px`;
      }
    }
    // A file just opened draws its rows over a few frames.
    if (waiting && retries.current < 90) {
      retries.current += 1;
      requestAnimationFrame(() => layout.current(true));
    }
  };

  /** Puts the notes where the scroll position wants them. Cheap: once a frame while scrolling. */
  const place = () => {
    const column = lane.current;
    const box = filesBox.current;
    const head = topBox.current;
    if (!column || !box || !head) {
      return;
    }
    const laneRect = column.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    const beside = laneRect.left >= boxRect.right - 1;
    if (beside !== side) {
      setSide(beside);
      return;
    }
    if (laneRect.bottom < 0 || laneRect.top > window.innerHeight) {
      return;
    }
    const current = active === undefined ? undefined : spots.current.get(active);
    if (wash.current) {
      const shown = current?.found === true;
      wash.current.hidden = !shown;
      if (shown) {
        wash.current.style.top = `${current.top}px`;
        wash.current.style.height = `${current.height}px`;
        wash.current.style.left = `${boxRect.left - laneRect.left}px`;
        wash.current.style.width = `${boxRect.width}px`;
      }
    }
    if (!beside) {
      // The list is in normal flow: nothing a column layout left on the cards may move them.
      for (const element of cards.current.values()) {
        element.style.transform = '';
      }
      column.style.minHeight = '';
      if (pins !== NO_PINS) {
        setPins(NO_PINS);
      }
      return;
    }

    // Notes whose lines went above the column's stuck top wait there, in order, as titles.
    // The current note waits there too, still open, while its lines are on screen.
    const headRect = head.getBoundingClientRect();
    const stuck = headRect.top > laneRect.top + 0.5;
    const top: string[] = [];
    let floor = headRect.top;
    if (stuck) {
      for (const note of notes) {
        const spot = spots.current.get(note.id);
        if (!spot || laneRect.top + spot.top - LIFT >= floor) {
          break;
        }
        top.push(note.id);
        floor += (pins.top.includes(note.id) ? (cards.current.get(note.id)?.offsetHeight ?? PIN) : PIN) + GAP;
      }
    }

    // The rest ride beside their lines, each below the one before it.
    const riding = notes.filter((note) => !top.includes(note.id));
    const tops = new Map<string, number>();
    // Before the column's top is stuck, the panel can lie over it: the notes start below the panel.
    const over = panel?.current?.getBoundingClientRect();
    const under = over && over.height > 0 && over.bottom > laneRect.top && over.top < laneRect.bottom;
    let next = stuck
      ? -Infinity
      : Math.max(head.offsetHeight + (head.offsetHeight ? GAP : 0), under ? over.bottom - laneRect.top + GAP : 0);
    for (const note of riding) {
      const spot = spots.current.get(note.id);
      const at = Math.max((spot?.top ?? 0) - (note.fileId === undefined ? 0 : LIFT), next);
      tops.set(note.id, at);
      const height = pins.bottom.includes(note.id) ? PIN : (cards.current.get(note.id)?.offsetHeight ?? PIN);
      next = at + height + GAP;
    }

    // Notes that start below the screen wait at its bottom edge as titles.
    const bottom: string[] = [];
    const limit = Math.min(window.innerHeight, laneRect.bottom) - 8;
    for (const note of riding.toReversed()) {
      if (note.id === active || laneRect.top + tops.get(note.id)! + PIN <= limit - bottom.length * (PIN + GAP)) {
        break;
      }
      bottom.unshift(note.id);
    }
    if (!same(top, pins.top) || !same(bottom, pins.bottom)) {
      setPins({ top, bottom });
      return;
    }

    // The current note keeps its leader while it waits at the top: drawn each frame, since its card
    // stays with the screen and its lines move with the page.
    const held = active !== undefined && top.includes(active) ? cards.current.get(active) : undefined;
    heldLeader.current?.setAttribute(
      'd',
      held && current?.found
        ? `M0 ${current.top + Math.min(current.height, 20) / 2}H14V${held.getBoundingClientRect().top - laneRect.top + HEAD}H28`
        : '',
    );

    let end = 0;
    for (const note of riding) {
      const card = cards.current.get(note.id);
      const leader = leaders.current.get(note.id);
      if (bottom.includes(note.id) || !card) {
        leader?.setAttribute('d', '');
        continue;
      }
      const at = tops.get(note.id)!;
      card.style.transform = `translateY(${at}px)`;
      end = Math.max(end, at + card.offsetHeight);
      const spot = spots.current.get(note.id);
      if (leader && spot && note.fileId !== undefined) {
        const from = spot.top + Math.min(spot.height, 20) / 2;
        leader.setAttribute('d', `M0 ${from}H14V${at + HEAD}H28`);
      }
    }
    column.style.minHeight = `${Math.ceil(end + bottom.length * (PIN + GAP) + 8)}px`;
  };

  const layout = useRef((_full: boolean) => {});
  layout.current = (full) => {
    if (full) {
      measure();
    }
    place();
  };

  useLayoutEffect(() => {
    retries.current = 0;
    layout.current(true);
  });

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      retries.current = 0;
      layout.current(true);
    });
    for (const element of [filesBox.current, lane.current, topBox.current]) {
      if (element) {
        observer.observe(element);
      }
    }
    let frame = 0;
    const onScroll = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        layout.current(false);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [filesBox]);

  const keep =
    <K, E extends Element>(map: RefObject<Map<K, E>>, key: K) =>
    (element: E | null) => {
      if (element) {
        map.current.set(key, element);
      } else {
        map.current.delete(key);
      }
    };
  const frameName = (note: SideNote) => {
    const frame = frames?.[inFrame.get(note.id) ?? -1];
    return frame && `${frame.receiver ? `${frame.receiver}.` : ''}${frame.name}`;
  };
  const card = (note: SideNote, held: boolean) => (
    <NoteCard
      key={note.id}
      box={keep(cards, note.id)}
      note={note}
      current={note.id === active}
      held={held}
      path={note.fileId === undefined ? undefined : files.get(note.fileId)?.path}
      within={frameName(note)}
      files={files}
      actions={actions}
      onJumpToFile={onJumpToFile}
    />
  );
  const byId = new Map(notes.map((note) => [note.id, note]));
  const pinned = new Set([...pins.top, ...pins.bottom]);

  return (
    <aside
      className="note-lane"
      ref={lane}
      data-side={side || undefined}
      aria-label="Notes on this group"
      style={reserve ? ({ '--paths-reserve': `${reserve}px` } as CSSProperties) : undefined}
    >
      <div className="lane-top" ref={topBox}>
        {pins.top.map((id) => byId.get(id) && card(byId.get(id)!, true))}
      </div>
      <div className="lane-ride">
        {notes.map((note) => (
          <div
            key={note.id}
            className="note-anchor"
            data-note-anchor={note.id}
            data-loose={note.fileId === undefined ? '' : undefined}
            data-current={note.id === active || undefined}
            ref={keep(anchors, note.id)}
          >
            {note.fileId !== undefined && (
              <span className="note-chip">
                {note.level && <FlagIcon level={note.level} />}
                {note.n}
              </span>
            )}
          </div>
        ))}
        <svg className="lane-leaders" aria-hidden>
          {notes.map((note) =>
            pinned.has(note.id) ? null : (
              <path key={note.id} ref={keep(leaders, note.id)} data-current={note.id === active || undefined} />
            ),
          )}
          <path ref={heldLeader} data-current />
        </svg>
        <div className="note-wash" ref={wash} hidden />
        {notes.map((note) => (pinned.has(note.id) ? null : card(note, false)))}
      </div>
      <div className="lane-bottom">{pins.bottom.map((id) => byId.get(id) && card(byId.get(id)!, true))}</div>
    </aside>
  );
});

/**
 * One note: its number, flag and title, then what it says. A decision that matters shows its
 * text at once; the others are their title until they are current. Held at the column's edge,
 * a note is its title alone (the current one stays open).
 */
function NoteCard({
  box,
  note,
  current,
  held,
  path,
  within,
  files,
  actions,
  onJumpToFile,
}: {
  box: (element: HTMLElement | null) => void;
  note: SideNote;
  current: boolean;
  held: boolean;
  path: string | undefined;
  /** The frame of the key code path the note's lines are in. */
  within: string | undefined;
  files: ReadonlyMap<string, FileSummary>;
  actions: NoteActions;
  onJumpToFile: (fileId: string, line?: number) => void;
}) {
  const open = current || (note.key && !held);
  const lines = noteLines(note);
  const comment = current && note.from !== undefined ? actions.comment : undefined;
  const ask = current && note.fileId !== undefined ? actions.ask : undefined;
  return (
    <article
      className="side-note"
      ref={box}
      data-level={note.level}
      data-current={current || undefined}
      data-open={open || undefined}
      data-held={held || undefined}
      data-anchored={note.fileId === undefined ? undefined : ''}
    >
      <button
        type="button"
        className="side-note-head"
        aria-current={current || undefined}
        onClick={() => actions.select(note.id)}
      >
        <span className="side-note-n">{note.n}</span>
        {note.level && <FlagIcon level={note.level} />}
        <span className="side-note-title">{inlineCode(note.title)}</span>
      </button>
      {open && (path || note.why || note.instead || note.check || note.also.length > 0) && (
        <div className="side-note-body">
          {path && (
            <div className="side-note-at">
              <code title={path}>
                {within && <b>{within}</b>}
                {within && ' · '}
                {splitPath(path).base}
                {lines && `:${lines}`}
              </code>
              {(comment || ask) && (
                <span className="side-note-actions">
                  {comment && (
                    <IconButton
                      size="sm"
                      variant="ghost"
                      label="Comment on these lines"
                      tooltip="Comment"
                      icon={<Icon icon={MessageSquarePlusIcon} />}
                      onClick={() => comment(note)}
                    />
                  )}
                  {ask && (
                    <IconButton
                      size="sm"
                      variant="ghost"
                      label="Ask about these lines"
                      tooltip="Ask"
                      icon={<Icon icon={MessageCircleQuestionIcon} />}
                      onClick={() => ask(note)}
                    />
                  )}
                </span>
              )}
            </div>
          )}
          {note.why && <p className="side-note-why">{inlineCode(note.why)}</p>}
          {(note.instead || note.check || note.also.length > 0) && (
            <dl className="side-note-facts">
              {note.instead && (
                <>
                  <dt>Instead of</dt>
                  <dd>{inlineCode(note.instead)}</dd>
                </>
              )}
              {note.check && (
                <>
                  <dt>Check</dt>
                  <dd className="side-note-check">{inlineCode(note.check)}</dd>
                </>
              )}
              {note.also.length > 0 && (
                <>
                  <dt>Also</dt>
                  <dd className="side-note-also">
                    {note.also.map((ref, index) => {
                      const file = files.get(ref.fileId);
                      return file ? (
                        <button
                          key={index}
                          type="button"
                          title={ref.label ? `${ref.label}\n${file.path}` : file.path}
                          onClick={() => onJumpToFile(ref.fileId, ref.line)}
                        >
                          {splitPath(file.path).base}
                          {ref.line !== undefined && <span>:{ref.line}</span>}
                        </button>
                      ) : null;
                    })}
                  </dd>
                </>
              )}
            </dl>
          )}
        </div>
      )}
    </article>
  );
}
