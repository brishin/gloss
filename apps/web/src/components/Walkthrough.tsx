import { Heading } from '@astryxdesign/core/Heading';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import type { CallFrame, DiffPayload, Excerpt, FileChange, Walkthrough as WalkthroughData } from '@gloss/protocol';
import { processFile } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import { memo, type ReactNode, useMemo } from 'react';
import { callLocations, callParents, excerptFile, excerptLabel, stepFrames } from '../lib/excerpt.ts';
import { unifiedText } from './FileView.tsx';

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
 * The call path read in order, between the overview and the groups: each step is a sentence,
 * the slice of the call tree it covers, and short read-only excerpts from any files. A file's
 * name jumps to it in its group, where its notes and comments are.
 */
export const Walkthrough = memo(function Walkthrough({
  walkthrough,
  diff,
  onJumpToFile,
}: {
  walkthrough: WalkthroughData;
  diff: DiffPayload | undefined;
  onJumpToFile: (fileId: string) => void;
}) {
  const files = useMemo(() => new Map(diff?.files.map((file) => [file.id, file])), [diff]);
  const { frames, steps } = walkthrough;
  const parents = useMemo(() => callParents(frames), [frames]);
  return (
    <div className="page">
      <header className="page-head">
        <Heading level={1}>Walkthrough</Heading>
      </header>
      <ol className="walk-steps">
        {steps.map((step, number) => (
          <li key={number} className="walk-step">
            <Heading level={2}>
              <span className="walk-step-n">{number + 1}</span>
              {step.title}
            </Heading>
            {step.text && <p className="walk-step-text">{inlineCode(step.text)}</p>}
            {step.frames.length > 0 && (
              <WalkTree frames={frames} only={stepFrames(frames, parents, step.frames)} active={new Set(step.frames)} />
            )}
            {step.excerpts.map((excerpt, index) =>
              diff ? (
                <ExcerptView key={index} files={files} excerpt={excerpt} onOpen={onJumpToFile} />
              ) : (
                <Skeleton key={index} height={120} />
              ),
            )}
          </li>
        ))}
      </ol>
    </div>
  );
});

/** One hunk slice under a slim `dir/base:lines` label, with no file chrome, so several read as one. */
function ExcerptView({
  files,
  excerpt,
  onOpen,
}: {
  files: ReadonlyMap<string, FileChange>;
  excerpt: Excerpt;
  onOpen: (fileId: string) => void;
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
        <button type="button" className="walk-excerpt-path" title="Open in its group" onClick={() => onOpen(file.id)}>
          <span>{dir}</span>
          {base}
          <span>:{lines}</span>
        </button>
      </figcaption>
      <FileDiff fileDiff={parsed} disableWorkerPool options={EXCERPT_OPTIONS} />
    </figure>
  );
}

/**
 * Part of the call tree with connectors: `only` keeps a subset (with its callers), and frames
 * outside `active` dim, so a step shows where it sits on the path.
 */
function WalkTree({
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

/** `code` spans in a step's sentence. */
function inlineCode(text: string): ReactNode[] {
  return text
    .split(/(`[^`]+`)/)
    .map((part, index) =>
      part.startsWith('`') && part.length > 1 ? <code key={index}>{part.slice(1, -1)}</code> : part,
    );
}
