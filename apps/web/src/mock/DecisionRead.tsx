import { Heading } from '@astryxdesign/core/Heading';
import { Icon } from '@astryxdesign/core/Icon';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import type { DecisionPriority, DiffPayload, FileChange } from '@gloss/protocol';
import { type DiffLineAnnotation, processFile, type SelectedLineRange } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import { CornerDownRightIcon } from 'lucide-react';
import { Fragment, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FlagIcon } from '../components/icons.tsx';
import { EXCERPT_OPTIONS, INDENT, inlineCode, MARK, ROW } from '../components/Walkthrough.tsx';
import { excerptFile } from '../lib/excerpt.ts';
import { decisionFlag } from '../lib/tour-view.ts';
import {
  baseName,
  type DecisionRead,
  filesById,
  MOCK,
  type ReadDecision,
  type ReadNode,
  type ReadSnippet,
  siteExcerpt,
  siteRef,
  snippetHosts,
  useDecisionRead,
} from './decision-walk.ts';

type Props = { diff: DiffPayload | undefined; onJumpToFile: (fileId: string) => void };
type Ctx = Props & { files: ReadonlyMap<string, FileChange>; read: DecisionRead };

/**
 * Round 2 (`?mock=f|g|h`): each decision is explained first (why, the road not taken, what to
 * check), then read in a few short snippets with the line that matters marked and a note on it.
 * A tree shows only when the decision has one: calls when it sits on a path, concepts when it
 * is a hierarchy (what counts, who reads it).
 */
export function DecisionReadStop(props: Props) {
  const read = useDecisionRead();
  const files = useMemo(() => filesById(props.diff), [props.diff]);
  if (!read) {
    return <Skeleton height={400} />;
  }
  const ctx: Ctx = { ...props, files, read };
  return (
    <ol className="walk-steps dr-decisions">
      {read.decisions.map((decision, index) => (
        <li key={index} className="walk-step dr-decision" id={`decision-${index}`}>
          <Title index={index} priority={decision.priority} title={decision.title} />
          <Explain decision={decision} />
          {MOCK === 'f' && <ExplainThenShow ctx={ctx} decision={decision} index={index} />}
          {MOCK === 'g' && <SideBySide ctx={ctx} decision={decision} index={index} />}
          {MOCK === 'h' && <TreeInline ctx={ctx} decision={decision} index={index} />}
          <Refs ctx={ctx} decision={decision} />
          <Links ctx={ctx} decision={decision} />
        </li>
      ))}
    </ol>
  );
}

function Title({ index, priority, title }: { index: number; priority: DecisionPriority; title: string }) {
  return (
    <Heading level={2}>
      <span className="walk-step-n">{index + 1}</span>
      <span className="dw-flag">
        <FlagIcon level={decisionFlag({ text: '', priority })} />
      </span>
      {title}
    </Heading>
  );
}

/** The decision in words: why, what it chose against, and what a reviewer should hold it to. */
function Explain({ decision }: { decision: ReadDecision }) {
  return (
    <div className="dr-explain">
      <p className="walk-step-text dr-why">{inlineCode(decision.why)}</p>
      {decision.alt && (
        <p className="dr-line">
          <span>Instead of</span>
          <span>{inlineCode(decision.alt)}</span>
        </p>
      )}
      {decision.check && (
        <p className="dr-line">
          <span>Check</span>
          <span>{inlineCode(decision.check)}</span>
        </p>
      )}
    </div>
  );
}

/** F: the tree (if any), then every snippet in order, numbered so tree rows point at them. */
function ExplainThenShow({ ctx, decision, index }: { ctx: Ctx; decision: ReadDecision; index: number }) {
  const numbered = decision.snippets.length > 1;
  const jump = (snippet: number) =>
    document.getElementById(`snippet-${index}-${snippet}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return (
    <>
      {decision.tree && (
        <ReadTree
          nodes={decision.tree.nodes}
          badge={numbered ? (node) => <Badge n={node.snippet!} onClick={() => jump(node.snippet!)} /> : undefined}
        />
      )}
      <div className="dr-snippets">
        {decision.snippets.map((snippet, at) => (
          <SnippetView
            key={at}
            ctx={ctx}
            snippet={snippet}
            id={`snippet-${index}-${at}`}
            n={numbered ? at : undefined}
          />
        ))}
      </div>
    </>
  );
}

/** G: the tree (or the snippets' captions) on the left; the picked row's code on the right. */
function SideBySide({ ctx, decision }: { ctx: Ctx; decision: ReadDecision; index: number }) {
  const first = decision.tree?.nodes.find((node) => node.snippet !== undefined)?.snippet ?? 0;
  const [picked, setPicked] = useState(first);
  const snippet = decision.snippets[picked];
  // One snippet and nothing to pick from: the code takes the row.
  if (!decision.tree && decision.snippets.length < 2) {
    return snippet ? <SnippetView ctx={ctx} snippet={snippet} /> : null;
  }
  return (
    <div className="dr-split">
      <div className="dr-split-nav">
        {decision.tree ? (
          <ReadTree nodes={decision.tree.nodes} picked={picked} onPick={setPicked} />
        ) : (
          <ol className="dr-captions">
            {decision.snippets.map((s, at) => (
              <li key={at}>
                <button type="button" data-on={at === picked || undefined} onClick={() => setPicked(at)}>
                  {inlineCode(s.caption)}
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="dr-split-code">{snippet && <SnippetView ctx={ctx} snippet={snippet} />}</div>
    </div>
  );
}

/** H: snippets open inside the tree, under the row they explain; the rest follow it. */
function TreeInline({ ctx, decision }: { ctx: Ctx; decision: ReadDecision; index: number }) {
  const nodes = decision.tree?.nodes;
  const hosts = useMemo(() => (nodes ? snippetHosts(nodes) : new Map<number, number>()), [nodes]);
  const hosted = new Set(hosts.values());
  const rest = decision.snippets.map((snippet, at) => ({ snippet, at })).filter(({ at }) => !hosted.has(at));
  return (
    <>
      {nodes && (
        <ReadTree
          nodes={nodes}
          after={(node, row) => {
            const at = hosts.get(row);
            return at === undefined ? null : (
              <div className="dr-hung" style={{ marginLeft: (node.depth + 1) * INDENT }}>
                <SnippetView ctx={ctx} snippet={decision.snippets[at]!} />
              </div>
            );
          }}
        />
      )}
      {rest.length > 0 && (
        <div className="dr-snippets">
          {rest.map(({ snippet, at }) => (
            <SnippetView key={at} ctx={ctx} snippet={snippet} />
          ))}
        </div>
      )}
    </>
  );
}

function Badge({ n, onClick }: { n: number; onClick?: () => void }) {
  return (
    <button type="button" className="dr-badge" onClick={onClick} tabIndex={onClick ? 0 : -1}>
      {n + 1}
    </button>
  );
}

/**
 * A decision's tree. Rows keep the walkthrough's geometry, but connectors are measured, so a
 * snippet can hang under its row (H) and push the rest down.
 */
function ReadTree({
  nodes,
  badge,
  picked,
  onPick,
  after,
}: {
  nodes: readonly ReadNode[];
  badge?: (node: ReadNode) => ReactNode;
  picked?: number;
  onPick?: (snippet: number) => void;
  after?: (node: ReadNode, row: number) => ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [tops, setTops] = useState<number[]>([]);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) {
      return;
    }
    const measure = () =>
      setTops([...element.querySelectorAll<HTMLElement>(':scope > .dr-row')].map((row) => row.offsetTop));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [nodes]);
  const parents = useMemo(() => nodes.map((node, row) => parentOf(nodes, row)), [nodes]);
  const height = box.current?.offsetHeight ?? nodes.length * ROW;
  return (
    <div className="walk-tree dr-tree" ref={box}>
      <svg className="walk-lines" width="100%" height={height} aria-hidden>
        {tops.length === nodes.length &&
          nodes.map((node, row) => {
            const parent = parents[row]!;
            if (parent < 0) {
              return null;
            }
            const x = nodes[parent]!.depth * INDENT + MARK / 2;
            const top = tops[parent]! + ROW / 2 + MARK / 2 + 2;
            const y = tops[row]! + ROW / 2;
            return <path key={row} d={`M${x} ${top}V${y - 6}Q${x} ${y} ${x + 6} ${y}H${node.depth * INDENT - 3}`} />;
          })}
      </svg>
      {nodes.map((node, row) => {
        const pickable = onPick && node.snippet !== undefined;
        return (
          <Fragment key={row}>
            <div
              className="walk-row dr-row"
              data-kind={node.kind}
              data-pick={pickable || undefined}
              data-on={(pickable && node.snippet === picked) || undefined}
              style={{ paddingLeft: node.depth * INDENT }}
              onClick={pickable ? () => onPick(node.snippet!) : undefined}
            >
              {node.kind === 'call' ? (
                <>
                  <span className={`walk-mark ${node.status ?? 'same'}`} />
                  <code className="walk-call">
                    {node.receiver && `${node.receiver}.`}
                    <b>{node.name}</b>({node.args ?? ''})
                  </code>
                </>
              ) : (
                <>
                  <span className="dr-dot" />
                  <span className="dr-concept">{node.label}</span>
                </>
              )}
              {node.note && <span className="dr-node-note">{inlineCode(node.note)}</span>}
              {node.snippet !== undefined && badge?.(node)}
              {node.path && node.line !== undefined && (
                <code className="walk-at">
                  {baseName(node.path)}
                  <span>:{node.line}</span>
                </code>
              )}
            </div>
            {after?.(node, row)}
          </Fragment>
        );
      })}
    </div>
  );
}

function parentOf(nodes: readonly ReadNode[], row: number): number {
  const depth = nodes[row]!.depth;
  for (let at = row - 1; at >= 0; at--) {
    if (nodes[at]!.depth < depth) {
      return at;
    }
  }
  return -1;
}

type Note = { note: string };

/** A few lines of one hunk: the caption says what they show, the focus line is marked, its note sits under it. */
function SnippetView({
  ctx,
  snippet,
  id,
  n,
  scroll,
}: {
  ctx: Ctx;
  snippet: ReadSnippet;
  id?: string;
  n?: number;
  scroll?: boolean;
}) {
  const excerpt = useMemo(() => siteExcerpt(ctx.diff, snippet), [ctx.diff, snippet]);
  const file = useMemo(() => (excerpt ? excerptFile(ctx.files, excerpt) : undefined), [ctx.files, excerpt]);
  const parsed = useMemo(() => (file ? processFile(diffText(file)) : undefined), [file]);
  const selected = useMemo<SelectedLineRange>(
    () => ({ start: snippet.focus, end: snippet.focus, side: 'additions', endSide: 'additions' }),
    [snippet.focus],
  );
  const notes = useMemo<DiffLineAnnotation<Note>[]>(
    () => (snippet.note ? [{ side: 'additions', lineNumber: snippet.focus, metadata: { note: snippet.note } }] : []),
    [snippet.note, snippet.focus],
  );
  return (
    <figure className="walk-excerpt dr-snippet" id={id}>
      <figcaption className="walk-excerpt-head dr-snippet-head">
        {n !== undefined && <Badge n={n} />}
        <span className="dr-caption">{inlineCode(snippet.caption)}</span>
        <button
          type="button"
          className="walk-excerpt-path dw-site-path"
          title={`${snippet.path}\nOpen in its group`}
          onClick={() => excerpt && ctx.onJumpToFile(excerpt.fileId)}
        >
          {siteRef(snippet)}
        </button>
      </figcaption>
      {parsed ? (
        <FileDiff<Note>
          fileDiff={parsed}
          disableWorkerPool
          options={scroll ? SCROLL_OPTIONS : EXCERPT_OPTIONS}
          selectedLines={selected}
          lineAnnotations={notes}
          renderAnnotation={(annotation) =>
            annotation.metadata && <div className="dr-note">{inlineCode(annotation.metadata.note)}</div>
          }
        />
      ) : (
        <Skeleton height={Math.min(220, 22 * (snippet.to - snippet.from + 1))} />
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

/** The rest of the decision's reach, one line each: no code, the name opens the file. */
function Refs({ ctx, decision }: { ctx: Ctx; decision: ReadDecision }) {
  if (decision.refs.length === 0) {
    return null;
  }
  return (
    <ul className="dr-refs">
      {decision.refs.map((ref, at) => {
        const file = ctx.diff?.files.find((candidate) => candidate.path === ref.path);
        return (
          <li key={at}>
            <span>{ref.label}</span>
            <button
              type="button"
              className="walk-excerpt-path dw-site-path"
              title={`${ref.path}\nOpen in its group`}
              onClick={() => file && ctx.onJumpToFile(file.id)}
            >
              {siteRef({ path: ref.path, from: ref.line, to: ref.line })}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Links({ ctx, decision }: { ctx: Ctx; decision: ReadDecision }) {
  if (decision.links.length === 0) {
    return null;
  }
  return (
    <ul className="dw-links">
      {decision.links.map((link, at) => (
        <li key={at}>
          <Icon icon={CornerDownRightIcon} size="xsm" />
          <button
            type="button"
            className="dw-link"
            onClick={() =>
              document.getElementById(`decision-${link.to}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          >
            {link.to + 1} {ctx.read.decisions[link.to]!.title}
          </button>
          <span>{link.text}</span>
        </li>
      ))}
    </ul>
  );
}
