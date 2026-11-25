import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
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
  chord,
  canMerge = false,
  dispatch,
  children,
}: {
  review: ReviewDraft;
  /** A key chord is pending: after `r`, the next key picks the verdict, so it must not land in the summary. */
  chord: boolean;
  /** The viewer may merge the PR: an approval can merge it too. */
  canMerge?: boolean;
  dispatch: (msg: Msg) => void;
  children: ReactNode;
}) {
  const submit = () => dispatch({ type: 'ReviewSubmitted' });
  const merging = canMerge && review.verdict === 'APPROVE' && Boolean(review.thenMerge);
  // The summary takes the keys, whichever way the panel opened (button, `r`, a refused send),
  // once the chord after `r` is over.
  const summary = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (review.open && !chord) {
      requestAnimationFrame(() => summary.current?.focus());
    }
  }, [review.open, chord]);
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
        status={review.problem ? { type: 'error', message: review.problem } : undefined}
      />
      {canMerge && review.verdict === 'APPROVE' && (
        <CheckboxInput
          size="sm"
          label="Then merge"
          value={Boolean(review.thenMerge)}
          onChange={(thenMerge) => dispatch({ type: 'ReviewThenMergeChanged', thenMerge })}
        />
      )}
      {review.error && <Banner status="error" title="Not sent" description={review.error} />}
      <div className="comment-actions">
        <Button size="sm" variant="ghost" label="Cancel" onClick={() => dispatch({ type: 'ReviewClosed' })} />
        <span className={merging ? 'merge-go' : undefined}>
          <Button
            size="sm"
            variant="primary"
            label={merging ? 'Approve and merge' : VERDICT_LABEL[review.verdict]}
            isLoading={Boolean(review.sending)}
            onClick={submit}
          />
        </span>
      </div>
    </div>
  );
  return (
    <Popover
      label="Review"
      isOpen={review.open}
      // The popover also reports opens it did not start (`r`); echoing one would end the chord.
      onOpenChange={(open) =>
        open !== review.open && dispatch(open ? { type: 'ReviewOpened' } : { type: 'ReviewClosed' })
      }
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
