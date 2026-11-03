import { Heading } from '@astryxdesign/core/Heading';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import type {
  Decision,
  DecisionNode,
  DecisionWalk,
  DiffPayload,
  FileChange,
  Snippet,
  Walkthrough as WalkthroughData,
} from '@gloss/protocol';
import { type DiffLineAnnotation, processFile, type SelectedLineRange } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import { Fragment, memo, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { callParents, excerptFile, excerptLabel, snippetHosts } from '../lib/excerpt.ts';
import { decisionFlag, splitPath } from '../lib/tour-view.ts';
import { unifiedText } from './FileView.tsx';
import { FlagIcon } from './icons.tsx';

/** Row height and indent per level, in px. */
const ROW = 28;
const INDENT = 22;
const MARK = 9;

const EXCERPT_OPTIONS = {
  diffStyle: 'unified' as const,
  disableFileHeader: true,
  overflow: 'wrap' as const,
  themeType: 'system' as const,
  hunkSeparators: 'simple' as const,
};

/**
 * The change-wide decisions read in code, between the overview and the groups. Each says why,
 * what it chose against and what to check, then shows the few lines that build it: under the
 * rows of its tree when it has one (calls, or a hierarchy of concepts), else in reading order.
 * A file's name jumps to it in its group, where its notes and comments are.
 */
export const Walkthrough = memo(function Walkthrough({
  walkthrough,
  decisions,
  diff,
  onJumpToFile,
}: {
  walkthrough: WalkthroughData;
  decisions: readonly Decision[];
  diff: DiffPayload | undefined;
  onJumpToFile: (fileId: string) => void;
}) {
  const files = useMemo(() => new Map(diff?.files.map((file) => [file.id, file])), [diff]);
  const numbers = new Map(walkthrough.decisions.map((walk, index) => [walk.decision, index + 1]));
  return (
    <div className="page">
      <header className="page-head">
        <Heading level={1}>Walkthrough</Heading>
      </header>
      <ol className="walk-steps">
        {walkthrough.decisions.map((walk, index) => (
          <li key={walk.decision} className="walk-step">
            <Heading level={2}>
              <span className="walk-step-n">{index + 1}</span>
              {decisions[walk.decision] && (
                <span className="walk-flag">
                  <FlagIcon level={decisionFlag(decisions[walk.decision]!)} />
                </span>
              )}
              {walk.title}
            </Heading>
            <Explain walk={walk} />
            <DecisionCode walk={walk} diff={diff} files={files} onOpen={onJumpToFile} />
            {walk.refs.length > 0 && (
              <ul className="walk-refs">
                {walk.refs.map((ref, at) => (
                  <li key={at}>
                    <span>{ref.label}</span>
                    <FileRef
                      path={files.get(ref.fileId)?.path}
                      line={ref.line}
                      onOpen={() => onJumpToFile(ref.fileId)}
                    />
                  </li>
                ))}
              </ul>
            )}
            {walk.links.some((link) => numbers.has(link.to)) && (
              <ul className="walk-links">
                {walk.links.map((link) => {
                  const number = numbers.get(link.to);
                  const other = walkthrough.decisions[(number ?? 0) - 1];
                  return number && other ? (
                    <li key={link.to}>
                      <b>
                        {number} {other.title}
                      </b>{' '}
                      {inlineCode(link.text)}
                    </li>
                  ) : null;
                })}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
});

/** The decision in words: why, what it chose against, and what to hold the code to. */
function Explain({ walk }: { walk: DecisionWalk }) {
  return (
    <div className="walk-explain">
      {walk.why && <p className="walk-why">{inlineCode(walk.why)}</p>}
      {walk.instead && (
        <p className="walk-line">
          <span>Instead of</span>
          <span>{inlineCode(walk.instead)}</span>
        </p>
      )}
      {walk.check && (
        <p className="walk-line">
          <span>Check</span>
          <span>{inlineCode(walk.check)}</span>
        </p>
      )}
    </div>
  );
}

/** The tree with snippets hung under their rows, then any snippet no row shows. */
function DecisionCode({
  walk,
  diff,
  files,
  onOpen,
}: {
  walk: DecisionWalk;
  diff: DiffPayload | undefined;
  files: ReadonlyMap<string, FileChange>;
  onOpen: (fileId: string) => void;
}) {
  const hosts = useMemo(() => snippetHosts(walk.tree ?? []), [walk.tree]);
  const hung = new Set(hosts.values());
  const view = (snippet: Snippet) =>
    diff ? (
      <SnippetView files={files} snippet={snippet} onOpen={onOpen} />
    ) : (
      <Skeleton height={Math.min(220, 22 * (snippet.to - snippet.from + 2))} />
    );
  return (
    <>
      {walk.tree && (
        <DecisionTree
          nodes={walk.tree}
          after={(node, row) => {
            const at = hosts.get(row);
            return at === undefined ? null : (
              <div className="walk-hung" style={{ marginLeft: (node.depth + 1) * INDENT }}>
                {view(walk.snippets[at]!)}
              </div>
            );
          }}
        />
      )}
      {walk.snippets.map((snippet, at) => (hung.has(at) ? null : <Fragment key={at}>{view(snippet)}</Fragment>))}
    </>
  );
}

/**
 * A decision's tree with connectors. Rows keep the call tree's geometry, but the connectors are
 * measured, because a snippet hung under a row pushes the rows after it down.
 */
function DecisionTree({
  nodes,
  after,
}: {
  nodes: readonly DecisionNode[];
  after: (node: DecisionNode, row: number) => ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ tops: number[]; height: number }>();
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) {
      return;
    }
    const measure = () =>
      setLayout({
        tops: [...element.querySelectorAll<HTMLElement>(':scope > .walk-row')].map((row) => row.offsetTop),
        height: element.offsetHeight,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [nodes]);
  const parents = useMemo(() => callParents(nodes), [nodes]);
  const tops = layout?.tops;
  return (
    <div className="walk-tree" ref={box}>
      {tops?.length === nodes.length && (
        <svg className="walk-lines" width="100%" height={layout!.height} aria-hidden>
          {nodes.map((node, row) => {
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
      )}
      {nodes.map((node, row) => (
        <Fragment key={row}>
          <div className="walk-row" data-kind={node.kind} style={{ paddingLeft: node.depth * INDENT }}>
            {node.kind === 'call' ? (
              <>
                <span className={`walk-mark ${node.status}`} />
                <code className="walk-call">
                  {node.receiver && `${node.receiver}.`}
                  <b>{node.name}</b>({node.args ?? ''})
                </code>
              </>
            ) : (
              <>
                <span className="walk-dot" />
                <span className="walk-concept">{node.label}</span>
              </>
            )}
            {node.note && <span className="walk-node-note">{inlineCode(node.note)}</span>}
            {node.path && (
              <code className="walk-at">
                {splitPath(node.path).base}
                {node.line !== undefined && <span>:{node.line}</span>}
              </code>
            )}
          </div>
          {after(node, row)}
        </Fragment>
      ))}
    </div>
  );
}

type Note = { note: string };

/** A few lines of one hunk: the caption says what they show, the focus line is marked, its note sits under it. */
function SnippetView({
  files,
  snippet,
  onOpen,
}: {
  files: ReadonlyMap<string, FileChange>;
  snippet: Snippet;
  onOpen: (fileId: string) => void;
}) {
  const file = useMemo(() => excerptFile(files, snippet), [files, snippet]);
  const parsed = useMemo(() => (file ? processFile(unifiedText(file)) : undefined), [file]);
  const selected = useMemo<SelectedLineRange>(
    () => ({ start: snippet.focus, end: snippet.focus, side: 'additions', endSide: 'additions' }),
    [snippet.focus],
  );
  const notes = useMemo<DiffLineAnnotation<Note>[]>(
    () => (snippet.note ? [{ side: 'additions', lineNumber: snippet.focus, metadata: { note: snippet.note } }] : []),
    [snippet.note, snippet.focus],
  );
  if (!file || !parsed) {
    return null;
  }
  const { dir, base, lines } = excerptLabel(file);
  return (
    <figure className="walk-excerpt">
      <figcaption className="walk-excerpt-head">
        <span className="walk-caption">{inlineCode(snippet.caption)}</span>
        <button
          type="button"
          className="walk-excerpt-path"
          title={`${dir}${base}\nOpen in its group`}
          onClick={() => onOpen(file.id)}
        >
          {base}
          <span>:{lines}</span>
        </button>
      </figcaption>
      <FileDiff<Note>
        fileDiff={parsed}
        disableWorkerPool
        options={EXCERPT_OPTIONS}
        selectedLines={selected}
        lineAnnotations={notes}
        renderAnnotation={(annotation) =>
          annotation.metadata && <div className="walk-note">{inlineCode(annotation.metadata.note)}</div>
        }
      />
    </figure>
  );
}

function FileRef({ path, line, onOpen }: { path: string | undefined; line?: number; onOpen: () => void }) {
  if (!path) {
    return null;
  }
  return (
    <button type="button" className="walk-excerpt-path" title={`${path}\nOpen in its group`} onClick={onOpen}>
      {splitPath(path).base}
      {line !== undefined && <span>:{line}</span>}
    </button>
  );
}

/** `code` spans in a sentence. */
export function inlineCode(text: string): ReactNode[] {
  return text
    .split(/(`[^`]+`)/)
    .map((part, index) =>
      part.startsWith('`') && part.length > 1 ? <code key={index}>{part.slice(1, -1)}</code> : part,
    );
}
