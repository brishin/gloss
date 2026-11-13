import { Heading } from '@astryxdesign/core/Heading';
import { Markdown } from '@astryxdesign/core/Markdown';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Spinner } from '@astryxdesign/core/Spinner';
import type {
  Decision,
  DiffPayload,
  FileChange,
  FileNote,
  GroupView,
  LineNote,
  ReviewThread,
  TourState,
} from '@gloss/protocol';
import { memo, useMemo } from 'react';
import type { DraftComment, ReviewDraft } from '../lib/review-draft.ts';
import { isFileExpanded } from '../lib/tour-model.ts';
import {
  isGeneratedFile,
  orderedFileIds,
  risksByFile,
  sectionDecisions,
  sectionFlagCounts,
  shortPath,
} from '../lib/tour-view.ts';
import { DecisionCard, FileView } from './FileView.tsx';
import { FlagCounts } from './icons.tsx';
import type { Reviewer } from './ReviewComments.tsx';
import type { ThreadControls } from './Threads.tsx';
import { inlineCode, SectionWalk } from './Walkthrough.tsx';

/** What a flag on a hunk says, by its kind (`Section.hunkFlags`). */
const HUNK_FLAG_TEXT = {
  contract: 'This changes a shape that clients, other services or stored data rely on.',
};

const NO_FILE_NOTES: FileNote[] = [];
const NO_LINE_NOTES: LineNote[] = [];
const NO_DECISIONS: Decision[] = [];
const NO_RISKS: never[] = [];
const NO_DRAFTS: DraftComment[] = [];
const NO_THREADS: ReviewThread[] = [];

export interface FileControls {
  expanded: Readonly<Record<string, boolean>>;
  viewed: ReadonlySet<string>;
  onToggleExpanded: (fileId: string) => void;
  onToggleViewed: (fileId: string) => void;
  review: ReviewDraft;
  reviewer: Reviewer | undefined;
  /** The PR's comment threads on GitHub; undefined on a local diff. */
  threads: ThreadControls | undefined;
}

export const GroupPanel = memo(function GroupPanel({
  group,
  state,
  diff,
  controls,
  onJumpToFile,
  homes,
  pathHomeKey,
}: {
  group: GroupView;
  state: TourState;
  diff: DiffPayload | undefined;
  controls: FileControls;
  onJumpToFile: (fileId: string, line?: number) => void;
  homes?: ReadonlyMap<number, string>;
  /** The group the key code path is read in. */
  pathHomeKey?: string;
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
  const threadList = controls.threads?.threads.list;
  const threads = useMemo(() => {
    const byPath = new Map<string, ReviewThread[]>();
    for (const thread of threadList ?? []) {
      byPath.set(thread.path, [...(byPath.get(thread.path) ?? []), thread]);
    }
    return byPath;
  }, [threadList]);
  // A comment written in the walkthrough shows its composer there, not here.
  const composing = controls.review.composing?.place ? undefined : controls.review.composing;
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
    // A flagged hunk that nothing else points at reads as a note on its first changed line.
    for (const { flag, ...at } of notes?.section?.hunkFlags ?? []) {
      lineNotes.set(at.fileId, [...(lineNotes.get(at.fileId) ?? []), { ...at, text: HUNK_FLAG_TEXT[flag] }]);
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
  const decisions = useMemo(() => sectionDecisions(state, group.key), [state, group.key]);
  const flagCounts = useMemo(() => sectionFlagCounts(state, group), [state, group]);
  // A group with a walk reads as its stops, then its diffs.
  const section = notes?.section;
  const wide = useMemo(
    () =>
      (state.walkthrough?.decisions ?? [])
        .filter((walk) => homes?.get(walk.decision) === group.key)
        .map((walk) => ({ walk, decision: state.decisions?.[walk.decision] })),
    [state.walkthrough, state.decisions, homes, group.key],
  );
  const path = useMemo(
    () => (pathHomeKey === group.key && state.walkthrough ? shortPath(state.walkthrough) : undefined),
    [state.walkthrough, group.key, pathHomeKey],
  );
  const foldedHunks = useMemo(() => {
    const byFile = new Map<string, string[]>();
    for (const { fileId, hunkId } of section?.skimHunks ?? []) {
      byFile.set(fileId, [...(byFile.get(fileId) ?? []), hunkId]);
    }
    return byFile;
  }, [section?.skimHunks]);
  const walked = !!section?.points.length || wide.length > 0 || !!path;
  // A change-wide decision read as a stop here is not also a card above the walk.
  const cards = decisions.filter((decision) => !homes?.has(state.decisions?.indexOf(decision) ?? -1));

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
        {cards.length > 0 && (
          <div className="section-decisions">
            {cards.map((decision, index) => (
              <DecisionCard key={index} decision={decision} />
            ))}
          </div>
        )}
      </header>
      {section && walked && (
        <SectionWalk
          groupKey={group.key}
          section={section}
          diff={diff}
          onJumpToFile={onJumpToFile}
          wide={wide}
          path={path}
          comments={controls.review.comments}
          composing={controls.review.composing?.place ? controls.review.composing : undefined}
          reviewer={controls.reviewer}
        />
      )}
      {section && (walked || section.rest) && (
        <div className="section-rest">
          <Heading level={2}>All changes</Heading>
          {section.rest && <p>{inlineCode(section.rest)}</p>}
        </div>
      )}
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
              foldedHunks={foldedHunks.get(fileId)}
              expanded={isFileExpanded(controls, group, summary)}
              viewed={controls.viewed.has(fileId)}
              onToggleExpanded={controls.onToggleExpanded}
              onToggleViewed={controls.onToggleViewed}
              drafts={drafts.get(fileId) ?? NO_DRAFTS}
              composing={composing?.fileId === fileId ? composing : undefined}
              reviewer={controls.reviewer}
              threads={threads.get(summary.path) ?? NO_THREADS}
              threadControls={controls.threads}
            />
          );
        })}
      </div>
    </div>
  );
});
