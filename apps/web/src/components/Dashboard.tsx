import { useAtomValue } from '@effect/atom-react';
import type { RecentTours, SourceRef, Stack, StackMember } from '@gloss/protocol';
import { describeRef, serializeRef } from '@gloss/protocol';
import { AsyncResult } from 'effect/reactivity';
import { type CSSProperties, useState } from 'react';
import { stackNameAtom } from '../lib/client.ts';
import { ageOf, compactCount, hueOf, inboxFacts, standOf } from '../lib/dashboard.ts';
import { isClosed, railSections, type RecentEntry, stackRefs } from '../lib/sidebar-tree.ts';
import { RefLink } from '../lib/source-routes.tsx';
import { ChevronIcon, RefIcon } from './icons.tsx';
import { AuthorFace, Faces, Talk, TopicTile } from './PullBits.tsx';

type Facts = ReturnType<typeof inboxFacts>;

/**
 * The home page's PRs: those on the viewer's move, those waiting on others, the viewer's drafts
 * (folded) and other open recent tours. The same sections as the rail, as wide rows.
 */
export function Dashboard({ recent }: { recent: RecentTours }) {
  const sections = railSections(recent, new Set());
  const facts = inboxFacts(recent);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const now = Date.now();
  // The repo most rows are in goes unnamed; others get their name before the number.
  const repoCounts = new Map<string, number>();
  for (const entry of [...sections.yourMove, ...sections.waiting, ...sections.drafts, ...sections.recent]) {
    const ref = entry.kind === 'tour' ? entry.tour.ref : stackRefs(entry.stack)[0]!;
    if (ref.kind === 'github-pr') {
      repoCounts.set(`${ref.owner}/${ref.repo}`, (repoCounts.get(`${ref.owner}/${ref.repo}`) ?? 0) + 1);
    }
  }
  const mainRepo = [...repoCounts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const row = (entry: RecentEntry) => (
    <DashboardEntry key={entryKey(entry)} entry={entry} recent={recent} facts={facts} mainRepo={mainRepo} now={now} />
  );
  return (
    <div className="dashboard">
      {sections.yourMove.length > 0 && (
        <section>
          <h2 className="dashboard-section">Your move</h2>
          {sections.yourMove.map(row)}
        </section>
      )}
      {sections.waiting.length > 0 && (
        <section>
          <h2 className="dashboard-section">Waiting on others</h2>
          {sections.waiting.map(row)}
        </section>
      )}
      {sections.drafts.length > 0 && (
        <section>
          <button
            type="button"
            className="dashboard-fold"
            aria-expanded={draftsOpen}
            onClick={() => setDraftsOpen((open) => !open)}
          >
            <ChevronIcon />
            {sections.drafts.length === 1 ? '1 draft' : `${sections.drafts.length} drafts`}
          </button>
          {draftsOpen && sections.drafts.map(row)}
        </section>
      )}
      {sections.recent.length > 0 && (
        <section>
          <h2 className="dashboard-section">Recent</h2>
          {sections.recent.map(row)}
        </section>
      )}
    </div>
  );
}

const entryKey = (entry: RecentEntry) => (entry.kind === 'tour' ? serializeRef(entry.tour.ref) : entry.key);

function DashboardEntry({
  entry,
  recent,
  facts,
  mainRepo,
  now,
}: {
  entry: RecentEntry;
  recent: RecentTours;
  facts: Facts;
  mainRepo: string | undefined;
  now: number;
}) {
  if (entry.kind === 'tour') {
    const { tour } = entry;
    return (
      <PullRow
        sourceRef={tour.ref}
        title={tour.title}
        author={tour.author}
        state={tour.state}
        recent={recent}
        facts={facts}
        mainRepo={mainRepo}
        now={now}
      />
    );
  }
  const { stack } = entry;
  const refs = stackRefs(stack);
  return (
    <div className="dashboard-stack">
      <StackRow stack={stack} viewer={recent.viewer} facts={facts} refs={refs} />
      <div className="dashboard-kids" style={{ '--topic-hue': hueOf(serializeRef(refs[0]!)) } as CSSProperties}>
        {stack.members.map((member, index) =>
          isClosed(member.state) ? null : (
            <PullRow
              key={member.number}
              sourceRef={refs[index]!}
              title={member.title}
              author={member.author}
              state={member.state}
              recent={recent}
              facts={facts}
              mainRepo={mainRepo}
              now={now}
              inStack
            />
          ),
        )}
      </div>
    </div>
  );
}

function StackRow({
  stack,
  viewer,
  facts,
  refs,
}: {
  stack: Stack;
  viewer: string | undefined;
  facts: Facts;
  refs: readonly SourceRef[];
}) {
  const name = AsyncResult.getOrElse(useAtomValue(stackNameAtom(JSON.stringify(stack))), () => undefined);
  const open = stack.members.filter((member) => !isClosed(member.state));
  const sum = (pick: (activity: NonNullable<StackMember['activity']>) => number) =>
    refs.reduce((total, ref) => {
      const activity = facts.activity.get(serializeRef(ref));
      return total + (activity ? pick(activity) : 0);
    }, 0);
  const authors = [...new Set(open.map((member) => member.author).filter((login) => login && login !== viewer))];
  return (
    <div className="dashboard-row dashboard-stack-head">
      <TopicTile titles={stack.members.map((member) => member.title)} seed={serializeRef(refs[0]!)} />
      <span className="dashboard-title">
        {name ?? (
          <>
            Stack onto <code className="tree-branch">{stack.base}</code>
          </>
        )}
        <span className="dashboard-quiet">
          {' · '}
          {open.length} PRs{name && ' onto '}
          {name && <code className="tree-branch">{stack.base}</code>}
        </span>
      </span>
      <span />
      <span />
      <span className="dashboard-who">
        {authors.map((login) => (
          <AuthorFace key={login} login={login!} />
        ))}
      </span>
      <span className="dashboard-size">
        +{compactCount(sum((a) => a.additions))} −{compactCount(sum((a) => a.deletions))}
      </span>
      <span />
    </div>
  );
}

function PullRow({
  sourceRef,
  title,
  author,
  state,
  recent,
  facts,
  mainRepo,
  now,
  inStack,
}: {
  sourceRef: SourceRef;
  title: string;
  author: string | undefined;
  state: StackMember['state'] | undefined;
  recent: RecentTours;
  facts: Facts;
  mainRepo: string | undefined;
  now: number;
  inStack?: boolean;
}) {
  const key = serializeRef(sourceRef);
  const activity = facts.activity.get(key);
  const stand = standOf({ author, state, activity, requested: facts.requested.has(key) }, recent.viewer);
  const others = !!author && author !== recent.viewer;
  const repo = sourceRef.kind === 'github-pr' ? `${sourceRef.owner}/${sourceRef.repo}` : undefined;
  return (
    <RefLink sourceRef={sourceRef} className="dashboard-row">
      {inStack || !activity ? (
        <span className="dashboard-lead">
          <RefIcon kind={sourceRef.kind} state={state} />
        </span>
      ) : (
        <TopicTile titles={[title]} seed={key} />
      )}
      <span className="dashboard-title" data-done={isClosed(state) || undefined}>
        {repo && repo !== mainRepo && (
          <span className="dashboard-quiet">{sourceRef.kind === 'github-pr' && sourceRef.repo} </span>
        )}
        {sourceRef.kind === 'github-pr' ? <span className="tree-number">#{sourceRef.number}</span> : null}
        {sourceRef.kind === 'github-pr' ? title : `${title} · ${describeRef(sourceRef)}`}
      </span>
      <span className="dashboard-reason" data-move={stand.move} data-urgent={stand.urgent || undefined}>
        {stand.reason}
      </span>
      {activity?.comments ? <Talk comments={activity.comments} /> : <span />}
      <span className="dashboard-who">
        {others && !inStack && <AuthorFace login={author!} />}
        {others && !inStack && activity && activity.reviewers.length > 0 && <span className="dashboard-divider" />}
        {activity && <Faces reviewers={activity.reviewers} />}
      </span>
      <span className="dashboard-size">
        {activity && `+${compactCount(activity.additions)} −${compactCount(activity.deletions)}`}
      </span>
      <span className="dashboard-age">{activity && ageOf(activity.updatedAt, now)}</span>
    </RefLink>
  );
}
