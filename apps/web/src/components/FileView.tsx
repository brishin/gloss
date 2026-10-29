import { Badge } from '@astryxdesign/core/Badge';
import { Markdown } from '@astryxdesign/core/Markdown';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import type { Decision, FileChange, FileNote, FileSummary, LineNote, RiskNote } from '@gloss/protocol';
import type { DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs';
import { processFile } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import { memo, useMemo } from 'react';
import { RISK_SHORT, splitPath } from '../lib/tour-view.ts';
import { PriorityIcon } from './icons.tsx';

function unifiedText(file: FileChange): string {
  const oldPath = file.previousPath ?? file.path;
  const lines = [`diff --git a/${oldPath} b/${file.path}`];
  if (file.status === 'added') {
    lines.push('new file mode 100644');
  } else if (file.status === 'removed') {
    lines.push('deleted file mode 100644');
  } else if (file.status === 'renamed') {
    lines.push(`rename from ${oldPath}`, `rename to ${file.path}`);
  }
  lines.push(`--- ${file.status === 'added' ? '/dev/null' : `a/${oldPath}`}`);
  lines.push(`+++ ${file.status === 'removed' ? '/dev/null' : `b/${file.path}`}`);
  for (const hunk of file.hunks) {
    lines.push(hunk.header, hunk.patch);
  }
  return `${lines.join('\n')}\n`;
}

function NoteCard({ text, critical, className }: { text: string; critical?: boolean; className?: string }) {
  return (
    <div className={`note ${className ?? ''}`} data-critical={critical ?? false}>
      <span className="note-label">{critical ? 'gloss · critical' : 'gloss'}</span>
      <Markdown density="compact">{text}</Markdown>
    </div>
  );
}

function DecisionCard({ decision, className }: { decision: Decision; className?: string }) {
  return (
    <div className={`note decision ${className ?? ''}`}>
      <PriorityIcon priority={decision.priority} />
      <span>{decision.text}</span>
    </div>
  );
}

/** What a diff line carries: a note or a decision, rendered under the line. */
type LineAnnotation = { kind: 'note'; note: LineNote } | { kind: 'decision'; decision: Decision };

function Chevron() {
  return (
    <svg className="chevron" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export const FileView = memo(function FileView({
  summary,
  change,
  fileNotes,
  lineNotes,
  decisions,
  risks,
  generated,
  expanded,
  viewed,
  onToggleExpanded,
  onToggleViewed,
}: {
  summary: FileSummary;
  /** Undefined until the diff body has loaded. */
  change: FileChange | undefined;
  fileNotes: readonly FileNote[];
  lineNotes: readonly LineNote[];
  /** Decisions in this file; one without a line shows with the file notes. */
  decisions: readonly Decision[];
  risks: readonly RiskNote[];
  generated: boolean;
  expanded: boolean;
  viewed: boolean;
  onToggleExpanded: (fileId: string) => void;
  onToggleViewed: (fileId: string) => void;
}) {
  const fileDiff = useMemo<FileDiffMetadata | undefined>(
    () => (change && change.hunks.length ? processFile(unifiedText(change)) : undefined),
    [change],
  );
  // Stable per notes array: pierre re-measures line heights when annotations change identity.
  const annotations = useMemo<DiffLineAnnotation<LineAnnotation>[]>(
    () => [
      ...decisions.flatMap((decision) =>
        decision.side && decision.line !== undefined
          ? [{ side: decision.side, lineNumber: decision.line, metadata: { kind: 'decision' as const, decision } }]
          : [],
      ),
      ...lineNotes.map((note) => ({
        side: note.side,
        lineNumber: note.line,
        metadata: { kind: 'note' as const, note },
      })),
    ],
    [decisions, lineNotes],
  );
  const fileDecisions = decisions.filter((decision) => decision.line === undefined);
  const { dir, base } = splitPath(summary.path);
  const riskKinds = [...new Set(risks.map((risk) => risk.risk))];

  return (
    <section className="file" id={`file-${summary.id}`} data-file-id={summary.id} data-expanded={expanded}>
      <header className="file-head">
        <button
          type="button"
          className="file-head-toggle"
          aria-expanded={expanded}
          onClick={() => onToggleExpanded(summary.id)}
          title={summary.previousPath ? `${summary.previousPath} → ${summary.path}` : summary.path}
        >
          <Chevron />
          <span className="file-path">
            {summary.previousPath && <span className="file-dir">{summary.previousPath} → </span>}
            <span className="file-dir">{dir}</span>
            <strong>{base}</strong>
          </span>
        </button>
        {/* The same mark as the group head and the sidebar dot; a pill would outshout the file name. */}
        {riskKinds.map((risk) => (
          <span key={risk} className="risk-kind">
            <span className="marker marker-risk" />
            {RISK_SHORT[risk]}
          </span>
        ))}
        {generated && <Badge variant="neutral" label="generated" />}
        {summary.status !== 'modified' && <Badge variant="neutral" label={summary.status} />}
        <span className="stat" aria-label={`${summary.additions} additions, ${summary.deletions} deletions`}>
          {summary.additions > 0 && <span className="adds">+{summary.additions} </span>}
          {summary.deletions > 0 && <span className="dels">−{summary.deletions}</span>}
        </span>
        <label className="viewed">
          <input type="checkbox" checked={viewed} onChange={() => onToggleViewed(summary.id)} />
          Viewed
        </label>
      </header>
      {expanded && fileNotes.length + fileDecisions.length > 0 && (
        <div className="file-notes">
          {fileDecisions.map((decision, index) => (
            <DecisionCard key={`d${index}`} decision={decision} />
          ))}
          {fileNotes.map((note, index) => (
            <NoteCard key={index} text={note.text} critical={note.critical} />
          ))}
        </div>
      )}
      {expanded &&
        (summary.isBinary ? (
          <div className="collapsed">Binary file</div>
        ) : summary.truncated ? (
          <div className="collapsed">Diff too large to show</div>
        ) : !change ? (
          <div className="collapsed">
            <Skeleton height={80} />
          </div>
        ) : !fileDiff ? (
          <div className="collapsed">No content changes</div>
        ) : (
          <FileDiff<LineAnnotation, undefined>
            fileDiff={fileDiff}
            disableWorkerPool
            options={{ diffStyle: 'unified', disableFileHeader: true, overflow: 'wrap', themeType: 'system' }}
            lineAnnotations={annotations}
            renderAnnotation={(annotation) =>
              annotation.metadata?.kind === 'decision' ? (
                <DecisionCard className="line-note" decision={annotation.metadata.decision} />
              ) : annotation.metadata ? (
                <NoteCard
                  className="line-note"
                  text={annotation.metadata.note.text}
                  critical={annotation.metadata.note.critical}
                />
              ) : null
            }
          />
        ))}
    </section>
  );
});
