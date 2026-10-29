import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Popover } from '@astryxdesign/core/Popover';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { TextArea } from '@astryxdesign/core/TextArea';
import type { ReviewVerdict } from '@gloss/protocol';
import { type ReactNode, useEffect, useRef } from 'react';
import { type ReviewDraft, VERDICT_LABEL } from '../lib/review-draft.ts';
import type { Msg } from '../lib/tour-model.ts';
import { submitKeys } from './ReviewComments.tsx';

const VERDICTS: readonly ReviewVerdict[] = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];

/**
 * Finishing a review, as on GitHub: a panel under the Review button (`children`) with a verdict,
 * an optional summary, and the pending line comments, sent to GitHub as one review.
 */
export function ReviewPanel({
  review,
  dispatch,
  children,
}: {
  review: ReviewDraft;
  dispatch: (msg: Msg) => void;
  children: ReactNode;
}) {
  const submit = () => dispatch({ type: 'ReviewSubmitted' });
  const count = review.comments.length;
  // The summary takes the keys, whichever way the panel opened (button, `r a`, a refused send).
  const summary = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (review.open) {
      requestAnimationFrame(() => summary.current?.focus());
    }
  }, [review.open]);
  const panel = (
    <div className="section review-panel" onKeyDown={submitKeys(submit)}>
      <SegmentedControl
        label="Verdict"
        size="sm"
        value={review.verdict}
        onChange={(verdict) => dispatch({ type: 'ReviewVerdictChanged', verdict: verdict as ReviewVerdict })}
      >
        {VERDICTS.map((verdict) => (
          <SegmentedControlItem key={verdict} value={verdict} label={VERDICT_LABEL[verdict]} />
        ))}
      </SegmentedControl>
      <TextArea
        ref={summary}
        label="Summary"
        isLabelHidden
        placeholder={review.verdict === 'APPROVE' ? 'Optional comment' : 'Leave a comment'}
        value={review.body}
        onChange={(body) => dispatch({ type: 'ReviewBodyChanged', body })}
        rows={5}
      />
      {review.error && <Banner status="error" title="Not sent" description={review.error} />}
      <div className="comment-actions">
        {count > 0 && (
          <span className="muted">
            With {count} line {count === 1 ? 'comment' : 'comments'}
          </span>
        )}
        <Button size="sm" variant="ghost" label="Cancel" onClick={() => dispatch({ type: 'ReviewClosed' })} />
        <Button
          size="sm"
          variant="primary"
          label={VERDICT_LABEL[review.verdict]}
          tooltip="⌘↵"
          isLoading={Boolean(review.sending)}
          onClick={submit}
        />
      </div>
    </div>
  );
  return (
    <Popover
      label="Review"
      isOpen={review.open}
      onOpenChange={(open) => dispatch(open ? { type: 'ReviewOpened' } : { type: 'ReviewClosed' })}
      placement="below"
      alignment="end"
      width={440}
      isModal={false}
      hasAutoFocus={false}
      content={panel}
    >
      {children}
    </Popover>
  );
}
