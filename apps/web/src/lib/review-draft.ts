import type { DiffSide, ReviewComment, ReviewVerdict } from '@gloss/protocol';

/** Where a line comment sits: `line` on `side`, starting at `startLine` when it spans several lines. */
export interface CommentAnchor {
  fileId: string;
  side: DiffSide;
  line: number;
  startLine?: number;
}

/** A line comment written but not yet sent; it goes out with the review, as in GitHub's pending review. */
export interface DraftComment extends CommentAnchor {
  id: string;
  path: string;
  body: string;
}

export interface ReviewDraft {
  /** The review dialog is open. */
  open: boolean;
  verdict: ReviewVerdict;
  body: string;
  comments: readonly DraftComment[];
  /** The line comment being written. `editing` is the draft it replaces. */
  composing?: CommentAnchor & { body: string; editing?: string };
  sending: boolean;
  error?: string;
  /** The last review sent, for the confirmation. */
  sent?: { verdict: ReviewVerdict; url: string };
}

export const emptyReview: ReviewDraft = { open: false, verdict: 'COMMENT', body: '', comments: [], sending: false };

/** What is kept across reloads, per diff: the words, not the dialog. */
export interface SavedReview {
  body: string;
  comments: readonly DraftComment[];
}

export const toReviewComments = (comments: readonly DraftComment[]): ReviewComment[] =>
  comments.map(({ path, side, line, startLine, body }) => ({
    path,
    side,
    line,
    ...(startLine !== undefined && startLine < line ? { startLine } : {}),
    body: body.trim(),
  }));

/** pierre's gutter selection, as a comment anchor: one side, lowest line first. */
export function anchorFromRange(
  fileId: string,
  range: { start: number; end: number; side?: DiffSide; endSide?: DiffSide },
): CommentAnchor {
  const side = range.endSide ?? range.side ?? 'additions';
  const sameSide = (range.side ?? side) === side;
  const line = sameSide ? Math.max(range.start, range.end) : range.end;
  const start = sameSide ? Math.min(range.start, range.end) : line;
  return start < line ? { fileId, side, line, startLine: start } : { fileId, side, line };
}

export const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  COMMENT: 'Comment',
  APPROVE: 'Approve',
  REQUEST_CHANGES: 'Request changes',
};

export const SENT_LABEL: Record<ReviewVerdict, string> = {
  COMMENT: 'Review comments sent',
  APPROVE: 'Approved',
  REQUEST_CHANGES: 'Changes requested',
};
