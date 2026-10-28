import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Heading } from '@astryxdesign/core/Heading';
import { Markdown } from '@astryxdesign/core/Markdown';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Spinner } from '@astryxdesign/core/Spinner';
import type { DiffPayload, FileChange, FileNote, FileSummary, GroupView, LineNote, TourState } from '@gloss/protocol';
import { useMemo } from 'react';
import {
  defaultExpanded,
  isGeneratedFile,
  orderedFileIds,
  RISK_SHORT,
  risksByFile,
  splitPath,
} from '../lib/tour-view.ts';
import { FileView } from './FileView.tsx';

const NO_FILE_NOTES: FileNote[] = [];
const NO_LINE_NOTES: LineNote[] = [];
const NO_RISKS: never[] = [];

export interface FileControls {
  expandedOverrides: Readonly<Record<string, boolean>>;
  viewed: ReadonlySet<string>;
  onToggleExpanded: (fileId: string) => void;
  onToggleViewed: (fileId: string) => void;
  onJumpToFile: (fileId: string) => void;
}

export function isFileExpanded(
  controls: Pick<FileControls, 'expandedOverrides' | 'viewed'>,
  group: GroupView | undefined,
  file: FileSummary,
): boolean {
  return (
    controls.expandedOverrides[file.id] ??
    defaultExpanded(file, isGeneratedFile(group, file), controls.viewed.has(file.id))
  );
}

export function GroupPanel({
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
  const byFile = useMemo(() => {
    const fileNotes = new Map<string, FileNote[]>();
    const lineNotes = new Map<string, LineNote[]>();
    for (const note of notes?.fileNotes ?? []) {
      fileNotes.set(note.fileId, [...(fileNotes.get(note.fileId) ?? []), note]);
    }
    for (const note of notes?.lineNotes ?? []) {
      lineNotes.set(note.fileId, [...(lineNotes.get(note.fileId) ?? []), note]);
    }
    return { fileNotes, lineNotes };
  }, [notes]);
  const notesPending =
    !notes &&
    group.phase === 'resolved' &&
    group.key !== 'generated' &&
    state.stages.notes.state !== 'done' &&
    state.stages.notes.state !== 'failed';
  const riskNotes = notes?.riskNotes ?? [];

  return (
    <div className="section">
      <div className="group-header">
        <Heading level={3}>{group.label}</Heading>
        <Badge variant="neutral" label={group.category} />
        {group.critical && <Badge variant="error" label="critical" />}
        {group.phase === 'provisional' && <Badge variant="warning" label="provisional" />}
        {notesPending && <Spinner size="sm" label="Writing notes" />}
      </div>
      {group.summary ? (
        <div className="prose">
          <Markdown density="compact">{group.summary}</Markdown>
        </div>
      ) : group.phase === 'provisional' ? (
        <span className="muted">Grouped by path while the model reads the change…</span>
      ) : null}
      {riskNotes.length > 0 && (
        <Banner
          status="warning"
          title={`${riskNotes.length} risk ${riskNotes.length === 1 ? 'flag' : 'flags'} in this group`}
          collapsible={{ defaultIsOpen: true }}
        >
          <div className="risk-list">
            {riskNotes.map((risk, index) => {
              const path = files.get(risk.fileId)?.path ?? risk.fileId;
              return (
                <div className="risk-row" key={index}>
                  <Badge variant="warning" label={RISK_SHORT[risk.risk]} />
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
                </div>
              );
            })}
          </div>
        </Banner>
      )}
      {order.map((fileId) => {
        const summary = files.get(fileId);
        if (!summary) {
          return <Skeleton key={fileId} height={32} />;
        }
        return (
          <FileView
            key={fileId}
            summary={summary}
            change={changes.get(fileId)}
            fileNotes={byFile.fileNotes.get(fileId) ?? NO_FILE_NOTES}
            lineNotes={byFile.lineNotes.get(fileId) ?? NO_LINE_NOTES}
            risks={risks.get(fileId) ?? NO_RISKS}
            generated={isGeneratedFile(group, summary)}
            expanded={isFileExpanded(controls, group, summary)}
            viewed={controls.viewed.has(fileId)}
            onToggleExpanded={controls.onToggleExpanded}
            onToggleViewed={controls.onToggleViewed}
          />
        );
      })}
    </div>
  );
}
