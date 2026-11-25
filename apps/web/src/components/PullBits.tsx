import { useAtomValue } from '@effect/atom-react';
import type { PullActivity, Reviewer } from '@gloss/protocol';
import { AsyncResult } from 'effect/reactivity';
import { BotIcon, CheckIcon, MessageSquareIcon, XIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { topicIconAtom } from '../lib/client.ts';
import { faceOrder, hueOf, type Stand } from '../lib/dashboard.ts';
import { FALLBACK_TOPIC_GLYPH, TOPIC_ICON_GLYPHS } from '../lib/topic-icons.ts';
import { REVIEW_STATE_LABEL, reviewerAvatar } from '../lib/tour-view.ts';
import { ChecksFailingIcon } from './icons.tsx';

/**
 * A PR or stack's topic icon on a tinted square. The fast model picks the icon from the titles;
 * the hue comes from `seed` (its ref), so each row keeps its colour.
 */
export function TopicTile({ titles, seed, size = 22 }: { titles: readonly string[]; seed: string; size?: number }) {
  const icon = AsyncResult.getOrElse(useAtomValue(topicIconAtom(JSON.stringify({ titles }))), () => undefined);
  const Glyph = (icon && TOPIC_ICON_GLYPHS[icon]) ?? FALLBACK_TOPIC_GLYPH;
  return (
    <span
      className="topic-tile"
      aria-hidden
      style={{ '--topic-hue': hueOf(seed), width: size, height: size } as CSSProperties}
    >
      <Glyph size={Math.round(size * 0.62)} strokeWidth={2} />
    </span>
  );
}

/** Faces in a row, overlapping; a check or cross marks a verdict, a ring marks a review still asked. */
export function Faces({ reviewers, size = 20 }: { reviewers: readonly Reviewer[]; size?: number }) {
  if (reviewers.length === 0) {
    return null;
  }
  return (
    <span className="faces">
      {faceOrder(reviewers).map((reviewer) => (
        <span
          key={reviewer.login}
          className="face"
          data-state={reviewer.state}
          style={{ width: size, height: size }}
          title={`${reviewer.login} ${REVIEW_STATE_LABEL[reviewer.state]}`}
        >
          <img src={reviewerAvatar(reviewer)} alt={reviewer.login} loading="lazy" />
          {reviewer.state === 'approved' && (
            <span className="face-mark">
              <CheckIcon size={8} strokeWidth={4} />
            </span>
          )}
          {reviewer.state === 'changes' && (
            <span className="face-mark">
              <XIcon size={8} strokeWidth={4} />
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

/** The author's face, set apart from the reviewers'. */
export function AuthorFace({ login, size = 20 }: { login: string; size?: number }) {
  return (
    <span className="face" data-state="author" style={{ width: size, height: size }} title={`${login} wrote it`}>
      <img src={reviewerAvatar({ login })} alt={login} loading="lazy" />
    </span>
  );
}

/** Comments from people, then from bots; a zero keeps its place but shows nothing. */
export function Talk({ comments, compact }: { comments: NonNullable<PullActivity['comments']>; compact?: boolean }) {
  const size = compact ? 11 : 13;
  return (
    <span className="talk" data-compact={compact || undefined}>
      <span
        className="talk-count"
        data-zero={comments.people === 0 || undefined}
        title={`${comments.people} from people`}
      >
        <MessageSquareIcon size={size} strokeWidth={2} aria-hidden />
        {comments.people}
      </span>
      <span
        className="talk-count talk-bots"
        data-zero={comments.bots === 0 || undefined}
        title={`${comments.bots} from bots`}
      >
        <BotIcon size={size + 1} strokeWidth={2} aria-hidden />
        {comments.bots}
      </span>
    </span>
  );
}

/**
 * The rail's end of a row: a word when the viewer acts next, else the reviewers' faces. Failing
 * checks are only a small mark, named on hover.
 */
export function RailStand({ stand, activity }: { stand: Stand; activity: PullActivity | undefined }) {
  if (stand.move === 'mine' && stand.urgent) {
    return (
      <span className="rail-mark" title={stand.reason} role="img" aria-label={stand.reason}>
        <ChecksFailingIcon size={14} />
      </span>
    );
  }
  if (stand.move === 'mine' && stand.short) {
    return <span className="nav-count">{stand.short}</span>;
  }
  return activity ? <Faces reviewers={activity.reviewers} size={16} /> : null;
}
