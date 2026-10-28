import { Badge } from '@astryxdesign/core/Badge';
import { Heading } from '@astryxdesign/core/Heading';
import { Markdown } from '@astryxdesign/core/Markdown';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import type { GroupView, TourState } from '@gloss/protocol';
import { githubBodyToMarkdown } from '../lib/github-markdown.ts';

/**
 * The tour's first stop: what the change is, how it is split, and where the risk is.
 * Shown once, instead of a summary card repeated above every group.
 */
export function Overview({
  state,
  groups,
  running,
  onSelect,
}: {
  state: TourState;
  groups: GroupView[];
  running: boolean;
  onSelect: (key: string) => void;
}) {
  const files = new Map(state.files.map((file) => [file.id, file]));
  const totals = (fileIds: readonly string[]) =>
    fileIds.reduce(
      (sum, id) => ({
        adds: sum.adds + (files.get(id)?.additions ?? 0),
        dels: sum.dels + (files.get(id)?.deletions ?? 0),
      }),
      { adds: 0, dels: 0 },
    );
  const all = totals(state.files.map((file) => file.id));
  const noteCount = (group: GroupView) =>
    group.notes ? group.notes.fileNotes.length + group.notes.lineNotes.length : 0;
  const meta = state.meta;
  const description = meta?.description ? githubBodyToMarkdown(meta.description) : '';

  return (
    <div className="section">
      {meta ? <Heading level={1}>{meta.title}</Heading> : <Skeleton width={360} height={24} />}
      {meta && (
        <div className="stats">
          <span>
            {meta.baseRef} ← {meta.headRef}
            {meta.author ? ` · ${meta.author}` : ''}
          </span>
          <span>
            <strong>{state.files.length}</strong> files <span className="adds">+{all.adds}</span>{' '}
            <span className="dels">−{all.dels}</span>
          </span>
          <span>
            <strong>{groups.length}</strong> groups
          </span>
          <span>
            <strong>{groups.filter((group) => group.critical).length}</strong> critical
          </span>
          <span>
            <strong>{groups.reduce((sum, group) => sum + noteCount(group), 0)}</strong> notes
          </span>
          {meta.url && (
            <a href={meta.url} target="_blank" rel="noreferrer">
              Open on GitHub
            </a>
          )}
        </div>
      )}
      <div className="prose">
        {state.overallSummary ? (
          <Markdown density="compact">{state.overallSummary}</Markdown>
        ) : running ? (
          <>
            <Skeleton height={14} />
            <Skeleton height={14} width="70%" />
          </>
        ) : null}
      </div>

      {groups.length > 0 && (
        <table className="overview-table">
          <tbody>
            {groups.map((group, index) => {
              const { adds, dels } = totals(group.fileIds);
              return (
                <tr key={group.key} onClick={() => onSelect(group.key)}>
                  <td className="nav-index">{index + 1}</td>
                  <td>
                    <strong>{group.label}</strong>
                  </td>
                  <td>
                    <Badge variant="neutral" label={group.category} />{' '}
                    {group.critical && <Badge variant="error" label="critical" />}
                  </td>
                  <td className="stat">{group.fileIds.length} files</td>
                  <td className="stat">
                    <span className="adds">+{adds}</span> <span className="dels">−{dels}</span>
                  </td>
                  <td className="stat muted">{group.notes ? `${noteCount(group)} notes` : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {description && (
        <div className="section prose">
          <Heading level={3}>Description</Heading>
          <div className="description">
            <Markdown density="compact" headingLevelStart={descriptionHeadingStart(description)}>
              {description}
            </Markdown>
          </div>
        </div>
      )}
      {meta && meta.commits.length > 0 && (
        <div className="section">
          <Heading level={3}>Commits ({meta.commits.length})</Heading>
          {meta.commits.map((commit) => (
            <div className="commit" key={commit.sha}>
              <code>{commit.sha.slice(0, 7)}</code>
              <span>{commit.subject}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The body's top heading level renders as h4, under this page's h3 section titles: PR
 * bodies usually start at `##`, which would otherwise outrank "Description" itself.
 */
function descriptionHeadingStart(markdown: string): 1 | 2 | 3 | 4 {
  const depths = [...markdown.matchAll(/^(#{1,6})\s/gm)].map((match) => match[1]!.length);
  const top = depths.length ? Math.min(...depths) : 1;
  return Math.max(1, Math.min(4, 4 - (top - 1))) as 1 | 2 | 3 | 4;
}
