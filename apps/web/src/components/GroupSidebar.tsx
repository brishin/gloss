import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import type { FileSummary, GroupView } from '@gloss/protocol';
import { notedFileIds, OVERVIEW, orderedFileIds, risksByFile, splitPath } from '../lib/tour-view.ts';

export function GroupSidebar({
  groups,
  files,
  selection,
  activeFileId,
  viewed,
  loading,
  onSelect,
  onSelectFile,
}: {
  groups: GroupView[];
  files: ReadonlyMap<string, FileSummary>;
  selection: string;
  activeFileId: string | undefined;
  viewed: ReadonlySet<string>;
  loading: boolean;
  onSelect: (key: string) => void;
  onSelectFile: (fileId: string) => void;
}) {
  return (
    <nav className="sidebar" aria-label="Review groups">
      <button
        type="button"
        className="nav-item"
        aria-current={selection === OVERVIEW ? 'step' : undefined}
        onClick={() => onSelect(OVERVIEW)}
      >
        <span className="nav-index" />
        <span className="nav-label">Overview</span>
        <span className="nav-count">{files.size || ''}</span>
      </button>
      {groups.length === 0 && loading
        ? [0, 1, 2].map((index) => <Skeleton key={index} index={index} height={28} />)
        : groups.map((group, index) => {
            const selected = group.key === selection;
            return (
              <div key={group.key}>
                <button
                  type="button"
                  className="nav-item"
                  data-phase={group.phase}
                  aria-current={selected ? 'step' : undefined}
                  aria-expanded={selected}
                  onClick={() => onSelect(group.key)}
                  title={group.label}
                >
                  <span className="nav-index">{index + 1}</span>
                  <span className="nav-label">{group.label}</span>
                  {group.critical && (
                    // A dot, not a pill: a pill truncates the group name at narrow widths.
                    <Tooltip content="Critical: touches auth, stored data, secrets or personal data">
                      <span className="marker marker-critical" role="img" aria-label="Critical" />
                    </Tooltip>
                  )}
                  <span className="nav-count">{group.fileIds.length}</span>
                </button>
                {selected && (
                  <FileList
                    group={group}
                    files={files}
                    activeFileId={activeFileId}
                    viewed={viewed}
                    onSelectFile={onSelectFile}
                  />
                )}
              </div>
            );
          })}
    </nav>
  );
}

/** The active group's files, risk-flagged first (the panel's order), with scroll-spy highlighting. */
function FileList({
  group,
  files,
  activeFileId,
  viewed,
  onSelectFile,
}: {
  group: GroupView;
  files: ReadonlyMap<string, FileSummary>;
  activeFileId: string | undefined;
  viewed: ReadonlySet<string>;
  onSelectFile: (fileId: string) => void;
}) {
  const noted = notedFileIds(group);
  const risky = risksByFile(group);
  return (
    <div className="file-list">
      {orderedFileIds(group).map((fileId) => {
        const file = files.get(fileId);
        if (!file) {
          return null;
        }
        return (
          <button
            type="button"
            key={fileId}
            className="file-link"
            title={file.path}
            aria-current={fileId === activeFileId ? 'location' : undefined}
            data-viewed={viewed.has(fileId)}
            onClick={() => onSelectFile(fileId)}
          >
            {risky.has(fileId) ? (
              <span className="marker marker-risk" aria-label="Risk flagged" />
            ) : noted.has(fileId) ? (
              <span className="marker marker-note" aria-label="Has notes" />
            ) : (
              <span className="marker" />
            )}
            <span className="file-link-name">{splitPath(file.path).base}</span>
            <span className="stat" aria-label={`${file.additions} additions, ${file.deletions} deletions`}>
              {file.additions > 0 && <span className="adds">+{file.additions}</span>}{' '}
              {file.deletions > 0 && <span className="dels">−{file.deletions}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
