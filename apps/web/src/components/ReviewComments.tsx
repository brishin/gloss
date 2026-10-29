import { Button } from '@astryxdesign/core/Button';
import { Markdown } from '@astryxdesign/core/Markdown';
import { TextArea } from '@astryxdesign/core/TextArea';
import type { KeyboardEvent } from 'react';
import type { CommentAnchor, DraftComment } from '../lib/review-draft.ts';

/** What a file's diff needs to take line comments; absent when the tour cannot be reviewed (a local diff). */
export interface Reviewer {
  start: (anchor: CommentAnchor) => void;
  edit: (id: string) => void;
  change: (body: string) => void;
  cancel: () => void;
  save: () => void;
  remove: (id: string) => void;
}

/** ⌘↵ / Ctrl↵ sends, Escape cancels: the keys every review box shares. */
export function submitKeys(onSubmit: () => void, onCancel?: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit();
    } else if (event.key === 'Escape' && onCancel) {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };
}

const lines = (anchor: CommentAnchor) =>
  anchor.startLine !== undefined ? `lines ${anchor.startLine}–${anchor.line}` : `line ${anchor.line}`;

export function CommentComposer({
  anchor,
  body,
  reviewer,
}: {
  anchor: CommentAnchor;
  body: string;
  reviewer: Reviewer;
}) {
  return (
    <div className="comment-composer line-note" onKeyDown={submitKeys(reviewer.save, reviewer.cancel)}>
      <TextArea
        label={`Comment on ${lines(anchor)}`}
        isLabelHidden
        placeholder={`Comment on ${lines(anchor)}`}
        value={body}
        onChange={reviewer.change}
        rows={3}
        hasAutoFocus
      />
      <div className="comment-actions">
        <Button size="sm" variant="ghost" label="Cancel" onClick={reviewer.cancel} />
        <Button
          size="sm"
          variant="primary"
          label="Add to review"
          tooltip="⌘↵"
          isDisabled={!body.trim()}
          onClick={reviewer.save}
        />
      </div>
    </div>
  );
}

/** A written comment, waiting to go out with the review. */
export function DraftCommentCard({ comment, reviewer }: { comment: DraftComment; reviewer: Reviewer }) {
  return (
    <div className="note draft-comment line-note">
      <span className="note-label">
        Pending{comment.startLine !== undefined ? ` · ${lines(comment)}` : ''}
        <span className="comment-tools">
          <button type="button" onClick={() => reviewer.edit(comment.id)}>
            Edit
          </button>
          <button type="button" onClick={() => reviewer.remove(comment.id)}>
            Delete
          </button>
        </span>
      </span>
      <Markdown density="compact">{comment.body}</Markdown>
    </div>
  );
}
