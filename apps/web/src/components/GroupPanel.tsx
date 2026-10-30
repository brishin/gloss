import { Heading } from '@astryxdesign/core/Heading';
import { Markdown } from '@astryxdesign/core/Markdown';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Spinner } from '@astryxdesign/core/Spinner';
import type { Decision, DiffPayload, FileChange, FileNote, GroupView, LineNote, TourState } from '@gloss/protocol';
import { memo, useMemo } from 'react';
import type { DraftComment, ReviewDraft } from '../lib/review-draft.ts';
import { isFileExpanded } from '../lib/tour-model.ts';
import {
  isGeneratedFile,
  orderedFileIds,
  RISK_SHORT,
  risksByFile,
  sectionDecisions,
  sectionFlagCounts,
  splitPath,
} from '../lib/tour-view.ts';
import { DecisionCard, FileView } from './FileView.tsx';
import { FlagCounts, FlagIcon } from './icons.tsx';
import type { Reviewer } from './ReviewComments.tsx';

const NO_FILE_NOTES: FileNote[] = [];
const NO_LINE_NOTES: LineNote[] = [];
const NO_DECISIONS: Decision[] = [];
const NO_RISKS: never[] = [];
const NO_DRAFTS: DraftComment[] = [];

export interface FileControls {
  expanded: Readonly<Record<string, boolean>>;
  viewed: ReadonlySet<string>;
  onToggleExpanded: (fileId: string) => void;
  onToggleViewed: (fileId: string) => void;
  onJumpToFile: (fileId: string) => void;
  review: ReviewDraft;
  reviewer: Reviewer | undefined;
}

export const GroupPanel = memo(function GroupPanel({
  group,
  state,
  diff,
  controls,
}: {
  group: GroupView;
  state: TourState;
  diff: DiffPayload | undefined;
  controls: FileControls;
}) {
  const files = useMemo(() => new Map(state.files.map((file) => [file.id, file])), [state.files]);
  const changes = useMemo(() => new Map<string, FileChange>(diff?.files.map((file) => [file.id, file])), [diff]);
  const notes = group.notes;
  const risks = useMemo(() => risksByFile(group), [group]);
  const order = useMemo(() => orderedFileIds(group), [group]);
  const drafts = useMemo(() => {
    const byId = new Map<string, DraftComment[]>();
    for (const comment of controls.review.comments) {
      byId.set(comment.fileId, [...(byId.get(comment.fileId) ?? []), comment]);
    }
    return byId;
  }, [controls.review.comments]);
  const composing = controls.review.composing;
  const byFile = useMemo(() => {
    const fileNotes = new Map<string, FileNote[]>();
    const lineNotes = new Map<string, LineNote[]>();
    const decisions = new Map<string, Decision[]>();
    for (const note of notes?.fileNotes ?? []) {
      fileNotes.set(note.fileId, [...(fileNotes.get(note.fileId) ?? []), note]);
    }
    for (const note of notes?.lineNotes ?? []) {
      lineNotes.set(note.fileId, [...(lineNotes.get(note.fileId) ?? []), note]);
    }
    for (const decision of notes?.decisions ?? []) {
      if (decision.fileId) {
        decisions.set(decision.fileId, [...(decisions.get(decision.fileId) ?? []), decision]);
      }
    }
    return { fileNotes, lineNotes, decisions };
  }, [notes]);
  const notesPending =
    !notes &&
    group.phase === 'resolved' &&
    group.key !== 'generated' &&
    state.stages.notes.state !== 'done' &&
    state.stages.notes.state !== 'failed';
  const riskNotes = notes?.riskNotes ?? [];
  const decisions = useMemo(() => sectionDecisions(state, group.key), [state, group.key]);
  const flagCounts = useMemo(() => sectionFlagCounts(state, group), [state, group]);

  return (
    <div className="page">
      <header className="page-head">
        <div className="group-header">
          <Heading level={1}>{group.label}</Heading>
          {/* The same quiet mark as the overview table and the sidebar, not a pill of its own. */}
          {group.critical && (
            <span className="tree-critical">
              <span className="marker marker-critical" />
              critical
            </span>
          )}
          <FlagCounts counts={flagCounts} />
          {notesPending && (
            <span className="muted">
              <Spinner size="sm" label="Writing notes" />
            </span>
          )}
        </div>
        {group.summary ? (
          <div className="prose">
            <Markdown density="compact">{group.summary}</Markdown>
          </div>
        ) : group.phase === 'provisional' ? (
          <span className="muted">Grouped by path while the model reads the change…</span>
        ) : null}
        {/* Decisions about the group as a whole; ones in code sit on their files and lines below. */}
        {decisions.length > 0 && (
          <div className="section-decisions">
            {decisions.map((decision, index) => (
              <DecisionCard key={index} decision={decision} />
            ))}
          </div>
        )}
        {/* Where the risk is, read right after what the group does: a list under the summary, not an alert. */}
        {riskNotes.length > 0 && (
          <ul className="risk-list" aria-label="Risk flags">
            {riskNotes.map((risk, index) => {
              const path = files.get(risk.fileId)?.path ?? risk.fileId;
              return (
                <li className="risk-row" key={index}>
                  <span className="risk-kind">
                    <FlagIcon level="warning" />
                    {RISK_SHORT[risk.risk]}
                  </span>
                  <a
                    href={`#file-${risk.fileId}`}
                    title={path}
                    onClick={(event) => {
                      event.preventDefault();
                      controls.onJumpToFile(risk.fileId);
                    }}
                  >
                    {splitPath(path).base}
                  </a>
                  <span>{risk.text}</span>
                </li>
              );
            })}
          </ul>
        )}
      </header>
      <div className="files">
        {order.map((fileId) => {
          const summary = files.get(fileId);
          if (!summary) {
            return <Skeleton key={fileId} height={32} />;
          }
          return (
            <FileView
              key={fileId}
              diffId={diff?.id}
              summary={summary}
              change={changes.get(fileId)}
              fileNotes={byFile.fileNotes.get(fileId) ?? NO_FILE_NOTES}
              lineNotes={byFile.lineNotes.get(fileId) ?? NO_LINE_NOTES}
              decisions={byFile.decisions.get(fileId) ?? NO_DECISIONS}
              risks={risks.get(fileId) ?? NO_RISKS}
              generated={isGeneratedFile(group, summary)}
              expanded={isFileExpanded(controls, group, summary)}
              viewed={controls.viewed.has(fileId)}
              onToggleExpanded={controls.onToggleExpanded}
              onToggleViewed={controls.onToggleViewed}
              drafts={drafts.get(fileId) ?? NO_DRAFTS}
              composing={composing?.fileId === fileId ? composing : undefined}
              reviewer={controls.reviewer}
            />
          );
        })}
      </div>
    </div>
  );
});
