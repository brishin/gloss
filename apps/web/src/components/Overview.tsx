import { Heading } from '@astryxdesign/core/Heading';
import { Icon } from '@astryxdesign/core/Icon';
import { Markdown } from '@astryxdesign/core/Markdown';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import type { GroupView, ReviewState, Reviewer, StackMember, TourState } from '@gloss/protocol';
import { UsersIcon } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { githubBodyToMarkdown } from '../lib/github-markdown.ts';
import {
  decisionFlag,
  decisionsInOrder,
  PULL_STATE_LABEL,
  pullStateDetail,
  REVIEW_DECISION_LABEL,
  REVIEW_STATE_LABEL,
  splitPath,
  WALKTHROUGH,
} from '../lib/tour-view.ts';
import { DescriptionMedia } from './DescriptionMedia.tsx';
import { FlagIcon, RefIcon } from './icons.tsx';
import { TourVisual } from './TourVisual.tsx';

/**
 * The change's title and its numbers: PR state, reviewers, branches, size, groups, notes.
 * Pinned under the top bar on every stop, at one fixed height (`--head-h`), so the title is
 * always in view and nothing below shifts as reviewers or stats load.
 */
export const PullHead = memo(function PullHead({
  state,
  pull,
  groups,
}: {
  state: TourState;
  /** The PR as GitHub has it now, fetched fresh on open (never from the tour cache). */
  pull?: StackMember;
  groups: GroupView[];
}) {
  const all = state.files.reduce(
    (sum, file) => ({ adds: sum.adds + file.additions, dels: sum.dels + file.deletions }),
    { adds: 0, dels: 0 },
  );
  const noteCount = (group: GroupView) =>
    group.notes ? group.notes.fileNotes.length + group.notes.lineNotes.length : 0;
  const notes = groups.reduce((sum, group) => sum + noteCount(group), 0);
  const meta = state.meta;

  return (
    <header className="pull-head">
      {meta ? <Heading level={1}>{meta.title}</Heading> : <Skeleton width={360} height={24} />}
      {meta && (
        <div className="stats">
          {pull && <PullStateLine pull={pull} />}
          {pull?.reviewers && <ReviewerFaces reviewers={pull.reviewers} />}
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
    </header>
  );
});

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
  const meta = state.meta;
  const description = meta?.description ? githubBodyToMarkdown(meta.description) : '';
  const decisions = decisionsInOrder(state, groups);
  // A change-wide decision the walkthrough reads in code opens it, instead of pointing at its group.
  const walked = new Set(state.walkthrough?.decisions.map((walk) => state.decisions?.[walk.decision]));

  return (
    <div className="page">
      <header className="page-head">
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

      {state.visuals?.map((visual, index) => (
        <TourVisual key={index} visual={visual} />
      ))}

      {decisions.length > 0 && (
        <section className="section">
          <Heading level={2}>Decisions</Heading>
          <table className="overview-table decisions">
            <tbody>
              {decisions.map(({ decision, groupKey }, index) => {
                const path = decision.fileId ? files.get(decision.fileId)?.path : undefined;
                const inWalk = walked.has(decision);
                const section =
                  !decision.fileId && groupKey && !inWalk ? groups.find((group) => group.key === groupKey) : undefined;
                return (
                  <tr key={index}>
                    <td className="decision-priority">
                      <FlagIcon level={decisionFlag(decision)} />
                    </td>
                    <td>
                      {inWalk ? (
                        <a
                          className="decision-walk"
                          href={`#group-${WALKTHROUGH}`}
                          title="Read it in code"
                          onClick={(event) => {
                            event.preventDefault();
                            onSelectGroup(WALKTHROUGH);
                          }}
                        >
                          {decision.text}
                        </a>
                      ) : (
                        decision.text
                      )}
                    </td>
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

/** Each reviewer's face with a mark for their latest word; the words are in the tooltip. */
function ReviewerFaces({ reviewers }: { reviewers: readonly Reviewer[] }) {
  return (
    <span className="reviewers" aria-label="Reviewers">
      {reviewers.map((reviewer) => {
        const label = `${reviewer.login} ${REVIEW_STATE_LABEL[reviewer.state]}`;
        return (
          <span key={reviewer.login} className="reviewer" title={label} aria-label={label}>
            {reviewer.team ? (
              <span className="reviewer-team">
                <Icon icon={UsersIcon} size="xsm" />
              </span>
            ) : (
              <img
                className="reviewer-avatar"
                src={`https://github.com/${encodeURIComponent(reviewer.login)}.png?size=40`}
                alt=""
                width={18}
                height={18}
                loading="lazy"
              />
            )}
            <ReviewMark state={reviewer.state} />
          </span>
        );
      })}
    </span>
  );
}

const REVIEW_MARK: Record<ReviewState, ReactNode> = {
  approved: <path d="M4.5 8.2 7 10.5l4.5-5" />,
  changes: <path d="M8 4.5v4M8 11v.2" />,
  commented: <path d="M4.5 6h7M4.5 9.5h4.5" />,
  pending: <circle cx="8" cy="8" r="2.6" />,
};

function ReviewMark({ state }: { state: ReviewState }) {
  return (
    <svg
      className="review-mark"
      data-state={state}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {REVIEW_MARK[state]}
    </svg>
  );
}

/**
 * The PR's state in its colour, then who and when in plain text. An open PR's review
 * decision takes the state's place, so "Approved" stays in view in the pinned head.
 */
function PullStateLine({ pull }: { pull: StackMember }) {
  const detail = pullStateDetail(pull, Date.now());
  const decision = pull.state === 'open' ? pull.reviewDecision : undefined;
  return (
    <span className="pull-state" data-state={pull.state} data-review={decision}>
      <RefIcon kind="github-pr" state={pull.state} />
      <strong>{decision ? REVIEW_DECISION_LABEL[decision] : PULL_STATE_LABEL[pull.state]}</strong>
      {detail && <span className="pull-state-detail">{detail}</span>}
    </span>
  );
}
