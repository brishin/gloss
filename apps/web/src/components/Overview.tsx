import { Heading } from '@astryxdesign/core/Heading';
import { Markdown } from '@astryxdesign/core/Markdown';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import type { GroupView, TourState } from '@gloss/protocol';
import { githubBodyToMarkdown } from '../lib/github-markdown.ts';
import { CATEGORY_LABEL } from '../lib/sidebar-tree.ts';
import { decisionsInOrder, splitPath } from '../lib/tour-view.ts';
import { DescriptionMedia } from './DescriptionMedia.tsx';
import { PriorityIcon } from './icons.tsx';

/**
 * The tour's first stop: what the change is, how it is split, and where the risk is.
 * Shown once, instead of a summary card repeated above every group.
 */
export function Overview({
  state,
  groups,
  running,
  onSelect,
  onJumpToFile,
}: {
  state: TourState;
  groups: GroupView[];
  running: boolean;
  onSelect: (key: string) => void;
  onJumpToFile: (fileId: string) => void;
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
  const decisions = decisionsInOrder(state, groups);
  const notes = groups.reduce((sum, group) => sum + noteCount(group), 0);

  return (
    <div className="page">
      <header className="page-head">
        {meta ? <Heading level={1}>{meta.title}</Heading> : <Skeleton width={360} height={24} />}
        {meta && (
          <div className="stats">
            <span>
              {meta.baseRef} ← {meta.headRef}
              {meta.author ? ` · ${meta.author}` : ''}
            </span>
            <span>
              <strong>{state.files.length}</strong> {plural(state.files.length, 'file')}{' '}
              <span className="adds">+{all.adds}</span> <span className="dels">−{all.dels}</span>
            </span>
            <span>
              <strong>{groups.length}</strong> {plural(groups.length, 'group')}
            </span>
            <span>
              <strong>{groups.filter((group) => group.critical).length}</strong> critical
            </span>
            <span>
              <strong>{notes}</strong> {plural(notes, 'note')}
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
      </header>

      {decisions.length > 0 && (
        <section className="section">
          <Heading level={2}>Decisions</Heading>
          <table className="overview-table decisions">
            <tbody>
              {decisions.map(({ decision, groupKey }, index) => {
                const path = decision.fileId ? files.get(decision.fileId)?.path : undefined;
                return (
                  <tr key={index}>
                    <td className="decision-priority">
                      <PriorityIcon priority={decision.priority} />
                    </td>
                    <td>{decision.text}</td>
                    <td className="stat">
                      {path && groupKey && decision.fileId && (
                        <a
                          className="decision-ref"
                          href={`#file-${decision.fileId}`}
                          title={path}
                          onClick={(event) => {
                            event.preventDefault();
                            onSelect(groupKey);
                            onJumpToFile(decision.fileId!);
                          }}
                        >
                          {splitPath(path).base}
                          {decision.line !== undefined && `:${decision.line}`}
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {groups.length > 0 && (
        <section className="section">
          <Heading level={2}>Groups</Heading>
          <table className="overview-table groups">
            <tbody>
              {groups.map((group, index) => {
                const { adds, dels } = totals(group.fileIds);
                return (
                  <tr key={group.key} onClick={() => onSelect(group.key)}>
                    <td className="nav-index">{index + 1}</td>
                    <td>
                      <span className="group-cell">
                        <button type="button" className="row-link" onClick={() => onSelect(group.key)}>
                          {group.label}
                        </button>
                        {group.critical && (
                          <span className="tree-critical">
                            <span className="marker marker-critical" />
                            critical
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="stat muted">{CATEGORY_LABEL[group.category]}</td>
                    <td className="stat muted">
                      {group.fileIds.length} {plural(group.fileIds.length, 'file')}
                    </td>
                    <td className="stat">
                      <span className="adds">+{adds}</span> <span className="dels">−{dels}</span>
                    </td>
                    <td className="stat muted">
                      {group.notes ? `${noteCount(group)} ${plural(noteCount(group), 'note')}` : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {description && (
        <section className="section prose">
          <Heading level={2}>Description</Heading>
          <div className="description">
            <Markdown
              density="compact"
              headingLevelStart={descriptionHeadingStart(description)}
              components={DESCRIPTION_COMPONENTS}
            >
              {description}
            </Markdown>
          </div>
        </section>
      )}
      {meta && meta.commits.length > 0 && (
        <section className="section">
          <Heading level={2}>Commits ({meta.commits.length})</Heading>
          {meta.commits.map((commit) => (
            <div className="commit" key={commit.sha}>
              <code>{commit.sha.slice(0, 7)}</code>
              <span>{commit.subject}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

const plural = (count: number, word: string) => (count === 1 ? word : `${word}s`);

const DESCRIPTION_COMPONENTS = { image: DescriptionMedia };

/**
 * The body's top heading level renders as h3 or below, under this page's h2 section titles: PR
 * bodies usually start at `##`, which would otherwise outrank "Description" itself.
 */
function descriptionHeadingStart(markdown: string): 1 | 2 | 3 | 4 {
  const depths = [...markdown.matchAll(/^(#{1,6})\s/gm)].map((match) => match[1]!.length);
  const top = depths.length ? Math.min(...depths) : 1;
  return Math.max(1, Math.min(4, 3 - (top - 1))) as 1 | 2 | 3 | 4;
}
