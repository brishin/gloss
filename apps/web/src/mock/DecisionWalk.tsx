import { Heading } from '@astryxdesign/core/Heading';
import { Icon } from '@astryxdesign/core/Icon';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import type { DecisionPriority, DiffPayload, FileChange } from '@gloss/protocol';
import { processFile } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import { ChevronRightIcon, CornerDownRightIcon } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FlagIcon } from '../components/icons.tsx';
import { EXCERPT_OPTIONS, INDENT, inlineCode, MARK, ROW } from '../components/Walkthrough.tsx';
import { callLocations, callParents, excerptFile } from '../lib/excerpt.ts';
import { decisionFlag } from '../lib/tour-view.ts';
import {
  baseName,
  codePlaces,
  type DecisionSite,
  type DecisionWalk,
  filesById,
  madeAt,
  MOCK,
  READ_MOCK,
  siteExcerpt,
  siteRef,
} from './decision-walk.ts';
import { DecisionReadStop } from './DecisionRead.tsx';

type Props = { walk: DecisionWalk; diff: DiffPayload | undefined; onJumpToFile: (fileId: string) => void };

const ROLE_LABEL: Record<DecisionSite['role'], string> = {
  made: 'Made here',
  reaches: 'Reaches here',
  tested: 'Tested here',
};

/** The decisions stop, in the layout `?mock=` picks: a chapters, b map, c pinned call tree, d reach grid, f-h round 2. */
export function DecisionsStop(props: Props) {
  return (
    <div className="page">
      <header className="page-head">
        <Heading level={1}>Decisions</Heading>
      </header>
      {MOCK === 'a' && <Chapters {...props} />}
      {MOCK === 'b' && <MapView {...props} />}
      {MOCK === 'c' && <PinnedTree {...props} />}
      {MOCK === 'd' && <ReachGrid {...props} />}
      {READ_MOCK && <DecisionReadStop diff={props.diff} onJumpToFile={props.onJumpToFile} />}
    </div>
  );
}

function Flag({ priority }: { priority: DecisionPriority }) {
  return <FlagIcon level={decisionFlag({ text: '', priority })} />;
}

function Mark({ role }: { role: DecisionSite['role'] }) {
  return <span className="dw-mark" data-role={role} title={ROLE_LABEL[role]} aria-label={ROLE_LABEL[role]} />;
}

function DecisionTitle({ index, priority, title }: { index: number; priority: DecisionPriority; title: string }) {
  return (
    <Heading level={2}>
      <span className="walk-step-n">{index + 1}</span>
      <span className="dw-flag">
        <Flag priority={priority} />
      </span>
      {title}
    </Heading>
  );
}

/** One site: its role and what happens there, then the lines. The file name jumps to it in its group. */
function SiteView({
  site,
  diff,
  files,
  onOpen,
  bare,
  scroll,
  closed,
}: {
  site: DecisionSite;
  diff: DiffPayload | undefined;
  files: ReadonlyMap<string, FileChange>;
  onOpen: (fileId: string) => void;
  /** No role mark in the head: the thread draws it. */
  bare?: boolean;
  /** Long lines scroll instead of wrapping (narrow columns). */
  scroll?: boolean;
  /** Only the head until opened. */
  closed?: boolean;
}) {
  const [shut, setShut] = useState(closed ?? false);
  const excerpt = useMemo(() => siteExcerpt(diff, site), [diff, site]);
  const file = useMemo(() => (excerpt ? excerptFile(files, excerpt) : undefined), [files, excerpt]);
  const parsed = useMemo(() => (file ? processFile(diffText(file)) : undefined), [file]);
  return (
    <figure className="walk-excerpt dw-site" data-role={site.role} data-shut={shut || undefined}>
      <figcaption className="walk-excerpt-head" onClick={closed === undefined ? undefined : () => setShut(!shut)}>
        {!bare && <Mark role={site.role} />}
        <span className="dw-site-label">{site.label}</span>
        <button
          type="button"
          className="walk-excerpt-path dw-site-path"
          title={`${site.path}\nOpen in its group`}
          onClick={() => excerpt && onOpen(excerpt.fileId)}
        >
          {siteRef(site)}
        </button>
      </figcaption>
      {shut ? null : parsed ? (
        <FileDiff fileDiff={parsed} disableWorkerPool options={scroll ? SCROLL_OPTIONS : EXCERPT_OPTIONS} />
      ) : (
        <Skeleton height={Math.min(220, 22 * (site.to - site.from + 1))} />
      )}
    </figure>
  );
}

const SCROLL_OPTIONS = { ...EXCERPT_OPTIONS, overflow: 'scroll' as const };

function diffText(file: FileChange): string {
  const lines = [`diff --git a/${file.path} b/${file.path}`, `--- a/${file.path}`, `+++ b/${file.path}`];
  for (const hunk of file.hunks) {
    lines.push(hunk.header, hunk.patch);
  }
  return `${lines.join('\n')}\n`;
}

/** How this decision ties to others: the other one's title (a link) and why. */
function Links({ walk, index, onSelect }: { walk: DecisionWalk; index: number; onSelect: (index: number) => void }) {
  const links = walk.decisions[index]!.links;
  if (links.length === 0) {
    return null;
  }
  return (
    <ul className="dw-links">
      {links.map((link, at) => (
        <li key={at}>
          <Icon icon={CornerDownRightIcon} size="xsm" />
          <button type="button" className="dw-link" onClick={() => onSelect(link.to)}>
            {link.to + 1} {walk.decisions[link.to]!.title}
          </button>
          <span>{link.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** A decision's reasoning, the road not taken, its code, and its ties. */
function DecisionBody({
  walk,
  index,
  diff,
  files,
  onJumpToFile,
  onSelect,
  thread,
  scroll,
}: Props & {
  index: number;
  files: ReadonlyMap<string, FileChange>;
  onSelect: (index: number) => void;
  thread?: boolean;
  scroll?: boolean;
}) {
  const decision = walk.decisions[index]!;
  const sites = thread ? (
    <ol className="dw-thread">
      {decision.sites.map((site, at) => (
        <li key={at} className="dw-hop" data-role={site.role} title={ROLE_LABEL[site.role]}>
          <SiteView site={site} diff={diff} files={files} onOpen={onJumpToFile} bare closed={site.role !== 'made'} />
        </li>
      ))}
    </ol>
  ) : (
    decision.sites.map((site, at) => (
      <SiteView key={at} site={site} diff={diff} files={files} onOpen={onJumpToFile} scroll={scroll} />
    ))
  );
  return (
    <>
      <p className="walk-step-text">{inlineCode(decision.text)}</p>
      {decision.alt && (
        <p className="dw-alt">
          <span>Alternative</span> {decision.alt}
        </p>
      )}
      {sites}
      <Links walk={walk} index={index} onSelect={onSelect} />
    </>
  );
}

const scrollToDecision = (index: number) =>
  document.getElementById(`decision-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

/** A: one chapter per decision, in reading order, each with every place its code lives. */
function Chapters(props: Props) {
  const files = useMemo(() => filesById(props.diff), [props.diff]);
  return (
    <ol className="walk-steps">
      {props.walk.decisions.map((decision, index) => (
        <li key={index} id={`decision-${index}`} className="walk-step stop-anchor">
          <DecisionTitle index={index} priority={decision.priority} title={decision.title} />
          <DecisionBody {...props} index={index} files={files} onSelect={scrollToDecision} />
        </li>
      ))}
    </ol>
  );
}

/** B: decisions on the left, the code they reach on the right, lines between; pick one to read it. */
function MapView(props: Props) {
  const [selected, setSelected] = useState(0);
  const files = useMemo(() => filesById(props.diff), [props.diff]);
  const decision = props.walk.decisions[selected]!;
  return (
    <>
      <DecisionMap walk={props.walk} selected={selected} onSelect={setSelected} />
      <section className="walk-step dw-detail">
        <DecisionTitle index={selected} priority={decision.priority} title={decision.title} />
        <DecisionBody {...props} index={selected} files={files} onSelect={setSelected} />
      </section>
    </>
  );
}

type Edge = { d: string; on: boolean; role: DecisionSite['role'] };

function DecisionMap({
  walk,
  selected,
  onSelect,
}: {
  walk: DecisionWalk;
  selected: number;
  onSelect: (index: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const places = useMemo(() => codePlaces(walk), [walk]);
  const [edges, setEdges] = useState<{ size: [number, number]; lines: Edge[]; arcs: Edge[] }>();
  const linked = new Set(walk.decisions[selected]!.links.map((link) => link.to));
  walk.decisions.forEach((decision, index) => {
    if (decision.links.some((link) => link.to === selected)) {
      linked.add(index);
    }
  });

  useLayoutEffect(() => {
    const root = box.current;
    if (!root) {
      return;
    }
    const draw = () => {
      const frame = root.getBoundingClientRect();
      const at = (element: Element | null) => {
        const rect = element!.getBoundingClientRect();
        return {
          left: rect.left - frame.left,
          right: rect.right - frame.left,
          mid: rect.top - frame.top + rect.height / 2,
        };
      };
      const decisions = walk.decisions.map((_, index) => at(root.querySelector(`[data-dw-dec="${index}"]`)));
      const lines: Edge[] = [];
      places.forEach((place, index) => {
        const node = at(root.querySelector(`[data-dw-node="${index}"]`));
        for (const use of place.uses) {
          const from = decisions[use.decision]!;
          const x1 = from.right + 6;
          const x2 = node.left - 6;
          const bend = (x2 - x1) / 2;
          lines.push({
            d: `M${x1} ${from.mid}C${x1 + bend} ${from.mid} ${x2 - bend} ${node.mid} ${x2} ${node.mid}`,
            on: use.decision === selected,
            role: use.role,
          });
        }
      });
      const arcs: Edge[] = [];
      const seen = new Set<string>();
      walk.decisions.forEach((decision, index) => {
        for (const link of decision.links) {
          const key = [index, link.to].sort().join('-');
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          const a = decisions[index]!;
          const b = decisions[link.to]!;
          const x = a.left - 4;
          const reach = 10 + Math.abs(b.mid - a.mid) / 6;
          arcs.push({
            d: `M${x} ${a.mid}C${x - reach} ${a.mid} ${x - reach} ${b.mid} ${x} ${b.mid}`,
            on: index === selected || link.to === selected,
            role: 'reaches',
          });
        }
      });
      setEdges({ size: [frame.width, frame.height], lines, arcs });
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(root);
    return () => observer.disconnect();
  }, [walk, places, selected]);

  let lastLayer = '';
  return (
    <div className="dw-map" ref={box}>
      {edges && (
        <svg className="dw-map-edges" width={edges.size[0]} height={edges.size[1]} aria-hidden>
          {[...edges.lines, ...edges.arcs]
            .sort((a, b) => Number(a.on) - Number(b.on))
            .map((edge, index) => (
              <path key={index} d={edge.d} data-on={edge.on || undefined} data-role={edge.role} />
            ))}
        </svg>
      )}
      <ol className="dw-map-decisions">
        {walk.decisions.map((decision, index) => (
          <li key={index}>
            <button
              type="button"
              className="dw-map-decision"
              data-dw-dec={index}
              data-on={index === selected || undefined}
              data-linked={linked.has(index) || undefined}
              onClick={() => onSelect(index)}
            >
              <span className="walk-step-n">{index + 1}</span>
              <span className="dw-flag">
                <Flag priority={decision.priority} />
              </span>
              <span>{decision.title}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="dw-map-code">
        {places.map((place, index) => {
          const head = place.layer !== lastLayer;
          lastLayer = place.layer;
          const on = place.uses.some((use) => use.decision === selected);
          const role = place.uses.find((use) => use.decision === selected)?.role ?? place.uses[0]!.role;
          return (
            <Fragment key={place.key}>
              {head && <div className="dw-map-layer">{place.layer}</div>}
              <div className="dw-map-node" data-dw-node={index} data-on={on || undefined} title={place.path}>
                <Mark role={role} />
                <span className="dw-map-node-label">{place.label}</span>
                <code>{siteRef(place)}</code>
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/** C: the whole call tree pinned beside the decisions; the one in view lights its frames. */
function PinnedTree(props: Props) {
  const [active, setActive] = useState(0);
  const files = useMemo(() => filesById(props.diff), [props.diff]);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const root = list.current;
    if (!root) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) {
          setActive(Number((top.target as HTMLElement).dataset.index));
        }
      },
      { rootMargin: '-140px 0px -55% 0px' },
    );
    for (const child of root.children) {
      observer.observe(child);
    }
    return () => observer.disconnect();
  }, []);
  return (
    <div className="dw-rail">
      <aside className="dw-rail-tree">
        <DecisionTree walk={props.walk} active={active} onSelect={scrollToDecision} />
      </aside>
      <ol className="walk-steps" ref={list}>
        {props.walk.decisions.map((decision, index) => (
          <li key={index} id={`decision-${index}`} data-index={index} className="walk-step stop-anchor">
            <DecisionTitle index={index} priority={decision.priority} title={decision.title} />
            <DecisionBody {...props} index={index} files={files} onSelect={scrollToDecision} scroll />
          </li>
        ))}
      </ol>
    </div>
  );
}

function DecisionTree({
  walk,
  active,
  onSelect,
}: {
  walk: DecisionWalk;
  active: number;
  onSelect: (index: number) => void;
}) {
  const frames = walk.frames;
  const parents = useMemo(() => callParents(frames), [frames]);
  const locations = useMemo(() => callLocations(frames), [frames]);
  const made = useMemo(() => madeAt(walk), [walk]);
  const lit = new Set(walk.decisions[active]?.frames ?? []);
  const touches = (frame: number) =>
    walk.decisions.flatMap((decision, index) => (decision.frames.includes(frame) ? [index] : []));
  const mid = (row: number) => row * ROW + ROW / 2;
  const offPath = walk.decisions.flatMap((decision, index) => (decision.frames.length === 0 ? [index] : []));
  return (
    <div className="dw-tree">
      <div className="walk-tree">
        <svg className="walk-lines" width="100%" height={frames.length * ROW} aria-hidden>
          {frames.map((frame, row) => {
            const parent = parents[row]!;
            if (parent < 0) {
              return null;
            }
            const x = frames[parent]!.depth * INDENT + MARK / 2;
            const y = mid(row);
            return (
              <path
                key={row}
                data-dim={!lit.has(row) || undefined}
                d={`M${x} ${mid(parent) + MARK / 2 + 2}V${y - 6}Q${x} ${y} ${x + 6} ${y}H${frame.depth * INDENT - 3}`}
              />
            );
          })}
        </svg>
        {frames.map((frame, row) => {
          const location = locations[row]!;
          return (
            <div
              key={row}
              className="walk-row"
              data-dim={!lit.has(row) || undefined}
              style={{ paddingLeft: frame.depth * INDENT }}
              title={frame.path}
            >
              <span className={`walk-mark ${frame.status}`} />
              <code className="walk-call">
                {frame.receiver && `${frame.receiver}.`}
                <b>{frame.name}</b>({frame.args ?? ''})
              </code>
              <span className="dw-tree-pins">
                {touches(row).map((index) => (
                  <button
                    key={index}
                    type="button"
                    className="dw-pin"
                    data-made={made.get(row)?.includes(index) || undefined}
                    data-on={index === active || undefined}
                    title={walk.decisions[index]!.title}
                    onClick={() => onSelect(index)}
                  >
                    {index + 1}
                  </button>
                ))}
              </span>
              <code className="walk-at dw-tree-at">{location}</code>
            </div>
          );
        })}
      </div>
      {offPath.length > 0 && (
        <p className="dw-tree-off">
          Off the call path:{' '}
          {offPath.map((index) => (
            <button
              key={index}
              type="button"
              className="dw-pin"
              data-on={index === active || undefined}
              title={walk.decisions[index]!.title}
              onClick={() => onSelect(index)}
            >
              {index + 1}
            </button>
          ))}{' '}
          {offPath.map((index) => baseName(walk.decisions[index]!.sites[0]!.path)).join(', ')}
        </p>
      )}
    </div>
  );
}

/** D: decisions down, layers across; each cell says what the decision does there. Pick a row to read it. */
function ReachGrid(props: Props) {
  const [open, setOpen] = useState(0);
  const files = useMemo(() => filesById(props.diff), [props.diff]);
  const { walk } = props;
  const decision = walk.decisions[open]!;
  return (
    <>
      <table className="dw-grid">
        <thead>
          <tr>
            <th />
            {walk.layers.map((layer) => (
              <th key={layer} scope="col">
                {layer}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {walk.decisions.map((row, index) => (
            <tr
              key={index}
              className="dw-grid-row"
              data-open={open === index || undefined}
              onClick={() => setOpen(index)}
            >
              <th scope="row">
                <span className="dw-grid-title">
                  <span className="walk-step-n">{index + 1}</span>
                  <span className="dw-flag">
                    <Flag priority={row.priority} />
                  </span>
                  <span>{row.title}</span>
                </span>
              </th>
              {walk.layers.map((layer) => {
                const sites = row.sites.filter((site) => site.layer === layer);
                return (
                  <td key={layer}>
                    {sites.map((site, at) => (
                      <span key={at} className="dw-grid-site" title={`${ROLE_LABEL[site.role]}: ${siteRef(site)}`}>
                        <Mark role={site.role} />
                        {site.label}
                      </span>
                    ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <section className="walk-step dw-detail">
        <DecisionTitle index={open} priority={decision.priority} title={decision.title} />
        <DecisionBody {...props} index={open} files={files} onSelect={setOpen} />
      </section>
    </>
  );
}

/** E: the overview's decisions list; a row opens in place as a thread through the code. */
export function DecisionTraceList(props: Props) {
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set([0]));
  const files = useMemo(() => filesById(props.diff), [props.diff]);
  const toggle = (index: number, value?: boolean) =>
    setOpen((current) => {
      const next = new Set(current);
      if (value ?? !next.has(index)) {
        next.add(index);
      } else {
        next.delete(index);
      }
      return next;
    });
  return (
    <ol className="dw-trace">
      {props.walk.decisions.map((decision, index) => {
        const made = decision.sites.find((site) => site.role === 'made') ?? decision.sites[0];
        const isOpen = open.has(index);
        return (
          <li key={index} id={`decision-${index}`} data-open={isOpen || undefined}>
            <button type="button" className="dw-trace-row" aria-expanded={isOpen} onClick={() => toggle(index)}>
              <span className="dw-flag">
                <Flag priority={decision.priority} />
              </span>
              <span className="dw-trace-title">{decision.title}</span>
              {made && <span className="decision-ref">{siteRef(made).replace(/–\d+$/, '')}</span>}
              <span className="dw-chevron">
                <Icon icon={ChevronRightIcon} size="xsm" />
              </span>
            </button>
            {isOpen && (
              <div className="dw-trace-body walk-step">
                <DecisionBody
                  {...props}
                  index={index}
                  files={files}
                  thread
                  onSelect={(to) => {
                    toggle(to, true);
                    requestAnimationFrame(() => scrollToDecision(to));
                  }}
                />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
