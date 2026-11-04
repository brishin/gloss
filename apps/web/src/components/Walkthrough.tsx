import { Heading } from '@astryxdesign/core/Heading';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import type {
  CallFrame,
  Decision,
  DecisionNode,
  DecisionWalk,
  DiffPayload,
  Excerpt,
  FileChange,
  Snippet,
  Walkthrough as WalkthroughData,
} from '@gloss/protocol';
import { type DiffLineAnnotation, type FileDiffMetadata, processFile, type SelectedLineRange } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import {
  createContext,
  Fragment,
  memo,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  callLocations,
  callParents,
  excerptFile,
  excerptLabel,
  excerptShows,
  snippetHosts,
  stepFrames,
} from '../lib/excerpt.ts';
import { anchorFromRange, type Composing, type DraftComment } from '../lib/review-draft.ts';
import { decisionFlag, splitPath } from '../lib/tour-view.ts';
import { unifiedText } from './FileView.tsx';
import { FlagIcon } from './icons.tsx';
import { CommentComposer, DraftCommentCard, type Reviewer } from './ReviewComments.tsx';

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

/** The pending review, so the walkthrough's diffs take line comments as the groups' diffs do. */
interface WalkReview {
  comments: readonly DraftComment[];
  /** The comment being written, when it is written in the walkthrough. */
  composing: Composing | undefined;
  reviewer: Reviewer | undefined;
}

const ReviewContext = createContext<WalkReview>({ comments: [], composing: undefined, reviewer: undefined });

/**
 * The change-wide decisions read in code, between the overview and the groups. Each says why,
 * what it chose against and what to check, then shows the few lines that build it: under the
 * rows of its tree when it has one (calls, or a hierarchy of concepts), else in reading order.
 * Then the key code paths the decisions do not walk, step by step down their call tree. A file's name
 * jumps to it in its group, where its notes and comments are. Its diffs take line comments.
 */
export const Walkthrough = memo(function Walkthrough({
  comments,
  composing,
  reviewer,
  ...props
}: Parameters<typeof WalkthroughBody>[0] & WalkReview) {
  const review = useMemo(() => ({ comments, composing, reviewer }), [comments, composing, reviewer]);
  return (
    <ReviewContext.Provider value={review}>
      <WalkthroughBody {...props} />
    </ReviewContext.Provider>
  );
});

const WalkthroughBody = memo(function WalkthroughBody({
  walkthrough,
  decisions,
  diff,
  onJumpToFile,
}: {
  walkthrough: WalkthroughData;
  decisions: readonly Decision[];
  diff: DiffPayload | undefined;
  onJumpToFile: (fileId: string, line?: number) => void;
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
                      onOpen={() => onJumpToFile(ref.fileId, ref.line)}
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
      {walkthrough.steps.length > 0 && (
        <CallPath
          frames={walkthrough.frames}
          steps={walkthrough.steps}
          diff={diff}
          files={files}
          onOpen={onJumpToFile}
        />
      )}
    </div>
  );
});

/** The key code paths read in order: each step is a sentence, the slice of the call tree it covers, and short excerpts. */
function CallPath({
  frames,
  steps,
  diff,
  files,
  onOpen,
}: {
  frames: readonly CallFrame[];
  steps: WalkthroughData['steps'];
  diff: DiffPayload | undefined;
  files: ReadonlyMap<string, FileChange>;
  onOpen: (fileId: string, line?: number) => void;
}) {
  const parents = useMemo(() => callParents(frames), [frames]);
  return (
    <section className="walk-path">
      <Heading level={2}>Key Code Paths</Heading>
      <ol className="walk-steps">
        {steps.map((step, number) => (
          <li key={number} className="walk-step">
            <Heading level={3}>
              <span className="walk-step-n">{number + 1}</span>
              {step.title}
            </Heading>
            {step.text && <p className="walk-step-text">{inlineCode(step.text)}</p>}
            {step.frames.length > 0 && (
              <PathTree frames={frames} only={stepFrames(frames, parents, step.frames)} active={new Set(step.frames)} />
            )}
            {step.excerpts.map((excerpt, index) =>
              diff ? (
                <ExcerptView
                  key={index}
                  place={`path:${number}:${index}`}
                  files={files}
                  excerpt={excerpt}
                  onOpen={onOpen}
                />
              ) : (
                <Skeleton key={index} height={120} />
              ),
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** One hunk slice under a slim `dir/base:lines` label, with no file chrome, so several read as one. */
function ExcerptView({
  place,
  files,
  excerpt,
  onOpen,
}: {
  place: string;
  files: ReadonlyMap<string, FileChange>;
  excerpt: Excerpt;
  onOpen: (fileId: string, line?: number) => void;
}) {
  const file = useMemo(() => excerptFile(files, excerpt), [files, excerpt]);
  const parsed = useMemo(() => (file ? processFile(unifiedText(file)) : undefined), [file]);
  if (!file || !parsed) {
    return null;
  }
  const { dir, base, lines } = excerptLabel(file);
  return (
    <figure className="walk-excerpt">
      <figcaption className="walk-excerpt-head">
        <button
          type="button"
          className="walk-excerpt-path"
          title="Open in its group"
          onClick={() => onOpen(file.id, excerpt.from)}
        >
          <span>{dir}</span>
          {base}
          <span>:{lines}</span>
        </button>
      </figcaption>
      <ExcerptDiff place={place} file={file} parsed={parsed} />
    </figure>
  );
}

/**
 * Part of the path's call tree with connectors: `only` keeps a subset (with its callers), and
 * frames outside `active` dim, so a step shows where it sits on the path.
 */
function PathTree({
  frames,
  only,
  active,
}: {
  frames: readonly CallFrame[];
  only: readonly number[];
  active: ReadonlySet<number>;
}) {
  const rows = only.map((index) => frames[index]!);
  const parents = callParents(rows);
  const locations = callLocations(rows);
  const mid = (row: number) => row * ROW + ROW / 2;
  return (
    <div className="walk-tree">
      <svg className="walk-lines" width="100%" height={rows.length * ROW} aria-hidden>
        {rows.map((frame, row) => {
          const parent = parents[row]!;
          if (parent < 0) {
            return null;
          }
          const x = rows[parent]!.depth * INDENT + MARK / 2;
          const y = mid(row);
          const dim = !active.has(only[row]!);
          return (
            <path
              key={row}
              data-dim={dim || undefined}
              d={`M${x} ${mid(parent) + MARK / 2 + 2}V${y - 6}Q${x} ${y} ${x + 6} ${y}H${frame.depth * INDENT - 3}`}
            />
          );
        })}
      </svg>
      {rows.map((frame, row) => {
        const index = only[row]!;
        const location = locations[row]!;
        const file = location.startsWith(':') ? '' : location.replace(/:\d+$/, '');
        return (
          <div
            key={index}
            className="walk-row"
            data-dim={!active.has(index) || undefined}
            style={{ paddingLeft: frame.depth * INDENT }}
          >
            <span className={`walk-mark ${frame.status}`} />
            <code className="walk-call">
              {frame.receiver && `${frame.receiver}.`}
              <b>{frame.name}</b>({frame.args ?? ''})
            </code>
            <code className="walk-at">
              {file}
              <span>{location.slice(file.length)}</span>
            </code>
          </div>
        );
      })}
    </div>
  );
}

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
  onOpen: (fileId: string, line?: number) => void;
}) {
  const hosts = useMemo(() => snippetHosts(walk.tree ?? []), [walk.tree]);
  const hung = new Set(hosts.values());
  const view = (snippet: Snippet, at: number) =>
    diff ? (
      <SnippetView place={`walk:${walk.decision}:${at}`} files={files} snippet={snippet} onOpen={onOpen} />
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
                {view(walk.snippets[at]!, at)}
              </div>
            );
          }}
        />
      )}
      {walk.snippets.map((snippet, at) => (hung.has(at) ? null : <Fragment key={at}>{view(snippet, at)}</Fragment>))}
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

/** A few lines of one hunk: the caption says what they show, the focus line is marked, its note sits under it. */
function SnippetView({
  place,
  files,
  snippet,
  onOpen,
}: {
  place: string;
  files: ReadonlyMap<string, FileChange>;
  snippet: Snippet;
  onOpen: (fileId: string, line?: number) => void;
}) {
  const file = useMemo(() => excerptFile(files, snippet), [files, snippet]);
  const parsed = useMemo(() => (file ? processFile(unifiedText(file)) : undefined), [file]);
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
          onClick={() => onOpen(file.id, snippet.focus)}
        >
          {base}
          <span>:{lines}</span>
        </button>
      </figcaption>
      <ExcerptDiff place={place} file={file} parsed={parsed} focus={snippet.focus} note={snippet.note} />
    </figure>
  );
}

/**
 * Marks a snippet's focus line as pierre marks a selected one. Not a selection: pierre pins the
 * gutter's "+" to the selection, so every comment would land on the focus line.
 */
const focusCSS = (line: number) => `
  :is([data-line="${line}"], [data-column-number="${line}"]):not([data-line-type="change-deletion"]) {
    --diffs-computed-selected-line-bg: light-dark(
      color-mix(in lab, var(--diffs-computed-diff-line-bg) 82%, var(--diffs-selection-mix-target)),
      color-mix(in lab, var(--diffs-computed-diff-line-bg) 75%, var(--diffs-selection-mix-target))
    );
  }
`;

/** What a walkthrough line carries: a snippet's note, or the reviewer's comments. */
type ExcerptAnnotation =
  | { kind: 'note'; note: string }
  | { kind: 'draft'; comment: DraftComment }
  | { kind: 'composer' };

/**
 * An excerpt's diff. The gutter's "+" starts a review comment here as in the file's own diff:
 * it joins the same pending review, and shows in both places.
 */
function ExcerptDiff({
  place,
  file,
  parsed,
  focus,
  note,
}: {
  /** Which walkthrough diff this is, so the composer opens only in the one it was started in. */
  place: string;
  file: FileChange;
  parsed: FileDiffMetadata;
  focus?: number;
  note?: string;
}) {
  const { comments, composing, reviewer } = useContext(ReviewContext);
  const here = composing?.place === place ? composing : undefined;
  const editing = here?.editing;
  const side = here?.side;
  const line = here?.line;
  const startLine = here?.startLine;
  const drafts = useMemo(
    () => comments.filter((comment) => comment.fileId === file.id && excerptShows(file, comment.side, comment.line)),
    [comments, file],
  );
  const annotations = useMemo<DiffLineAnnotation<ExcerptAnnotation>[]>(
    () => [
      ...(note && focus !== undefined
        ? [{ side: 'additions' as const, lineNumber: focus, metadata: { kind: 'note' as const, note } }]
        : []),
      // The comment being edited gives way to its composer.
      ...drafts
        .filter((comment) => comment.id !== editing)
        .map((comment) => ({
          side: comment.side,
          lineNumber: comment.line,
          metadata: { kind: 'draft' as const, comment },
        })),
      ...(side && line !== undefined ? [{ side, lineNumber: line, metadata: { kind: 'composer' as const } }] : []),
    ],
    [note, focus, drafts, editing, side, line],
  );
  // The lines being commented on; selected only while the comment is written, as in the file's diff.
  const selected = useMemo<SelectedLineRange | null>(
    () => (side && line !== undefined ? { start: startLine ?? line, end: line, side, endSide: side } : null),
    [side, line, startLine],
  );
  const placed = useMemo<Reviewer | undefined>(
    () =>
      reviewer && {
        ...reviewer,
        start: (anchor) => reviewer.start(anchor, place),
        edit: (id) => reviewer.edit(id, place),
      },
    [reviewer, place],
  );
  const options = useMemo(
    () => ({
      ...EXCERPT_OPTIONS,
      unsafeCSS: focus === undefined ? undefined : focusCSS(focus),
      ...(placed && {
        enableGutterUtility: true,
        onGutterUtilityClick: (range: Parameters<typeof anchorFromRange>[1]) =>
          placed.start(anchorFromRange(file.id, range)),
      }),
    }),
    [placed, file.id, focus],
  );
  return (
    <FileDiff<ExcerptAnnotation>
      fileDiff={parsed}
      disableWorkerPool
      options={options}
      selectedLines={selected}
      lineAnnotations={annotations}
      renderAnnotation={(annotation) =>
        annotation.metadata?.kind === 'composer' ? (
          here && placed && <CommentComposer anchor={here} body={here.body} reviewer={placed} />
        ) : annotation.metadata?.kind === 'draft' ? (
          placed && <DraftCommentCard comment={annotation.metadata.comment} reviewer={placed} />
        ) : annotation.metadata ? (
          <div className="walk-note">{inlineCode(annotation.metadata.note)}</div>
        ) : null
      }
    />
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
