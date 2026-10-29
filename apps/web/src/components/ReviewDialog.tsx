import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog } from '@astryxdesign/core/Dialog';
import { Heading } from '@astryxdesign/core/Heading';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { TextArea } from '@astryxdesign/core/TextArea';
import type { ReviewVerdict } from '@gloss/protocol';
import { type ReviewDraft, VERDICT_LABEL } from '../lib/review-draft.ts';
import type { Msg } from '../lib/tour-model.ts';
import { submitKeys } from './ReviewComments.tsx';

const VERDICTS: readonly ReviewVerdict[] = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];

/** Finishing a review: a verdict, an optional summary, and the pending line comments go to GitHub as one review. */
export function ReviewDialog({ review, dispatch }: { review: ReviewDraft; dispatch: (msg: Msg) => void }) {
  const submit = () => dispatch({ type: 'ReviewSubmitted' });
  const count = review.comments.length;
  return (
    <Dialog
      isOpen={review.open}
      onOpenChange={(open) => !open && dispatch({ type: 'ReviewClosed' })}
      purpose="form"
      width={520}
      padding={4}
    >
      <div className="section review-dialog" onKeyDown={submitKeys(submit)}>
        <Heading level={2}>Review</Heading>
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
          label="Summary"
          isLabelHidden
          placeholder={review.verdict === 'APPROVE' ? 'Optional comment' : 'Leave a comment'}
          value={review.body}
          onChange={(body) => dispatch({ type: 'ReviewBodyChanged', body })}
          rows={5}
          hasAutoFocus
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
            isLoading={review.sending}
            onClick={submit}
          />
        </div>
      </div>
    </Dialog>
  );
}
