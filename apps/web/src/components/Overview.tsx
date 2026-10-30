import { Heading } from '@astryxdesign/core/Heading';
import { Markdown } from '@astryxdesign/core/Markdown';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import type { GroupView, TourState } from '@gloss/protocol';
import { memo } from 'react';
import { githubBodyToMarkdown } from '../lib/github-markdown.ts';
import { decisionFlag, decisionsInOrder, splitPath } from '../lib/tour-view.ts';
import { DescriptionMedia } from './DescriptionMedia.tsx';
import { FlagIcon } from './icons.tsx';
import { TourVisual } from './TourVisual.tsx';

/**
 * The top of the page: what the change is and where the risk is. Shown once, instead of a
 * summary card repeated above every group. The groups themselves are listed in the sidebar
 * and follow below.
 */
export const Overview = memo(function Overview({
  state,
  groups,
  running,
  onJumpToFile,
  onSelectGroup,
}: {
  state: TourState;
  groups: GroupView[];
  running: boolean;
  onJumpToFile: (fileId: string) => void;
  onSelectGroup: (key: string) => void;
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

      {state.visual && <TourVisual visual={state.visual} />}

      {decisions.length > 0 && (
        <section className="section">
          <Heading level={2}>Decisions</Heading>
          <table className="overview-table decisions">
            <tbody>
              {decisions.map(({ decision, groupKey }, index) => {
                const path = decision.fileId ? files.get(decision.fileId)?.path : undefined;
                const section =
                  !decision.fileId && groupKey ? groups.find((group) => group.key === groupKey) : undefined;
                return (
                  <tr key={index}>
                    <td className="decision-priority">
                      <FlagIcon level={decisionFlag(decision)} />
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
                            onJumpToFile(decision.fileId!);
                          }}
                        >
                          {splitPath(path).base}
                          {decision.line !== undefined && `:${decision.line}`}
                        </a>
                      )}
                      {section && (
                        <a
                          className="decision-ref decision-section"
                          href={`#group-${section.key}`}
                          onClick={(event) => {
                            event.preventDefault();
                            onSelectGroup(section.key);
                          }}
                        >
                          {section.label}
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
});

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
