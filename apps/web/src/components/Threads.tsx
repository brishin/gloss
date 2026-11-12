import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Markdown } from '@astryxdesign/core/Markdown';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import type { FileSummary, ReviewThread, ThreadComment } from '@gloss/protocol';
import { XIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { githubBodyToMarkdown } from '../lib/github-markdown.ts';
import { isFolded, type ThreadsModel } from '../lib/threads-model.ts';
import { ago, splitPath } from '../lib/tour-view.ts';
import { submitKeys } from './ReviewComments.tsx';

/** What a thread under its line can do; `act` is false when nothing can be sent (an export). */
export interface ThreadControls {
  threads: ThreadsModel;
  act: boolean;
  toggleFold: (threadId: string) => void;
  startReply: (threadId: string) => void;
  changeReply: (body: string) => void;
  cancelReply: () => void;
  submitReply: () => void;
  resolve: (threadId: string) => void;
}

function Face({ comment, size = 20 }: { comment: ThreadComment; size?: number }) {
  return (
    <img
      className="thread-face"
      src={comment.avatar ?? `https://github.com/${encodeURIComponent(comment.author)}.png?size=${size * 2}`}
      alt=""
      title={comment.author}
      width={size}
      height={size}
      loading="lazy"
      onError={(event) => {
        event.currentTarget.style.visibility = 'hidden';
      }}
    />
  );
}

/** The first line of a comment as plain text, for one-row summaries. */
export function firstLine(body: string): string {
  const line = githubBodyToMarkdown(body)
    .split('\n')
    .find((row) => row.trim() && !row.startsWith('```'));
  return (line ?? '').replace(/[*_`#>]/g, '').trim();
}

const faces = (thread: ReviewThread) => [
  ...new Map(thread.comments.map((comment) => [comment.author, comment])).values(),
];

function CommentRow({ comment, now }: { comment: ThreadComment; now: number }) {
  return (
    <div className="thread-comment">
      <Face comment={comment} />
      <div className="thread-comment-main">
        <div className="thread-byline">
          <strong>{comment.author}</strong>
          <a className="thread-ago" href={comment.url} target="_blank" rel="noreferrer" title="Open on GitHub">
            {ago(comment.createdAt, now)}
          </a>
        </div>
        <Markdown density="compact">{githubBodyToMarkdown(comment.body)}</Markdown>
      </div>
    </div>
  );
}

function ReplyBox({ controls, busy }: { controls: ThreadControls; busy: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), []);
  const body = controls.threads.replying?.body ?? '';
  return (
    <div className="thread-reply" onKeyDown={submitKeys(controls.submitReply, controls.cancelReply)}>
      <TextArea
        ref={input}
        label="Reply"
        isLabelHidden
        placeholder="Reply"
        value={body}
        onChange={controls.changeReply}
        rows={2}
        hasAutoFocus
      />
      <div className="comment-actions">
        <Button size="sm" variant="ghost" label="Cancel" onClick={controls.cancelReply} />
        <Button
          size="sm"
          variant="primary"
          label={busy ? 'Replying…' : 'Reply'}
          isDisabled={!body.trim() || busy}
          onClick={controls.submitReply}
        />
      </div>
    </div>
  );
}

/**
 * A thread already on GitHub, under its line (or at the top of its file when its line is gone).
 * Other people's words, so neutral: never gloss's violet. Resolved and outdated threads fold to one row.
 */
export function ThreadCard({ thread, controls }: { thread: ReviewThread; controls: ThreadControls }) {
  const now = Date.now();
  const { threads } = controls;
  const busy = threads.busy.has(thread.id);
  const error = threads.error?.threadId === thread.id ? threads.error.message : undefined;
  if (isFolded(threads, thread)) {
    return (
      <button
        type="button"
        className="thread thread-folded line-note"
        aria-expanded={false}
        onClick={() => controls.toggleFold(thread.id)}
      >
        <span className="thread-faces">
          {faces(thread).map((comment) => (
            <Face key={comment.author} comment={comment} size={16} />
          ))}
        </span>
        <span className="thread-state">{thread.resolved ? 'Resolved' : 'Outdated'}</span>
        <span className="thread-snippet">{firstLine(thread.comments[0]!.body)}</span>
        {thread.comments.length > 1 && <span className="thread-ago">{thread.comments.length}</span>}
      </button>
    );
  }
  const replying = controls.threads.replying?.threadId === thread.id;
  return (
    <div className="thread line-note" data-resolved={thread.resolved || undefined}>
      {thread.outdated && (
        <div className="thread-outdated">
          <span className="thread-state">Outdated</span>
          {thread.quote && <code>{thread.quote}</code>}
        </div>
      )}
      {thread.comments.map((comment) => (
        <CommentRow key={comment.id} comment={comment} now={now} />
      ))}
      {replying ? (
        <ReplyBox controls={controls} busy={busy} />
      ) : (
        <div className="thread-actions">
          {controls.act && (
            <>
              <button type="button" onClick={() => controls.startReply(thread.id)}>
                Reply
              </button>
              <button type="button" disabled={busy} onClick={() => controls.resolve(thread.id)}>
                {thread.resolved ? 'Unresolve' : 'Resolve'}
              </button>
            </>
          )}
          {(thread.resolved || thread.outdated) && (
            <button type="button" onClick={() => controls.toggleFold(thread.id)}>
              Fold
            </button>
          )}
        </div>
      )}
      {error && <div className="thread-error">{error}</div>}
    </div>
  );
}

/** Every thread at once, by file in tour order, in Ask's slot at the right edge. A click jumps to the line. */
export function CommentsPanel({
  threads,
  files,
  fileOrder,
  onJump,
  onToggleResolved,
  onClose,
}: {
  threads: ThreadsModel;
  files: readonly FileSummary[];
  /** File ids in tour order. */
  fileOrder: readonly string[];
  onJump: (fileId: string, line?: number) => void;
  onToggleResolved: () => void;
  onClose: () => void;
}) {
  const list = threads.list ?? [];
  const byPath = new Map(files.map((file) => [file.path, file]));
  const rank = new Map(fileOrder.map((id, index) => [id, index]));
  const paths = [...new Set(list.map((thread) => thread.path))].sort(
    (a, b) =>
      (rank.get(byPath.get(a)?.id ?? '') ?? Infinity) - (rank.get(byPath.get(b)?.id ?? '') ?? Infinity) ||
      a.localeCompare(b),
  );
  const resolved = list.filter((thread) => thread.resolved).length;
  return (
    <aside className="ask-panel comments-panel" aria-label="Comments">
      <div className="ask-header">
        <Text weight="semibold">Comments</Text>
        <IconButton
          size="sm"
          variant="ghost"
          label="Close"
          tooltip="Close (Esc)"
          icon={<Icon icon={XIcon} />}
          onClick={onClose}
        />
      </div>
      <div className="comments-list">
        {paths.map((path) => {
          const file = byPath.get(path);
          const shown = list
            .filter((thread) => thread.path === path && (threads.showResolved || !thread.resolved))
            // Outdated threads have no line: they go last.
            .sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity));
          if (!shown.length) {
            return null;
          }
          return (
            <section key={path} className="comments-file">
              <div className="comments-path" title={path}>
                {splitPath(path).base}
              </div>
              {shown.map((thread) => {
                const first = thread.comments[0]!;
                const replies = thread.comments.length - 1;
                return (
                  <button
                    type="button"
                    key={thread.id}
                    className="comments-row"
                    data-resolved={thread.resolved || undefined}
                    disabled={!file}
                    title={file ? undefined : 'This file is not in the tour'}
                    onClick={() => file && onJump(file.id, thread.side === 'additions' ? thread.line : undefined)}
                  >
                    <Face comment={first} />
                    <span className="comments-text">
                      <span className="thread-byline">
                        <strong>{first.author}</strong>
                        <span className="thread-ago">{thread.outdated ? 'outdated' : `line ${thread.line}`}</span>
                        {replies > 0 && (
                          <span className="thread-ago comments-replies">
                            {replies} {replies === 1 ? 'reply' : 'replies'}
                          </span>
                        )}
                      </span>
                      <span className="comments-clamp">{firstLine(first.body)}</span>
                    </span>
                  </button>
                );
              })}
            </section>
          );
        })}
        {list.length === resolved && !threads.showResolved && (
          <div className="ask-empty">
            <Text color="secondary">Every thread is resolved.</Text>
          </div>
        )}
        {resolved > 0 && (
          <button type="button" className="comments-more" onClick={onToggleResolved}>
            {threads.showResolved ? 'Hide resolved' : `${resolved} resolved`}
          </button>
        )}
      </div>
    </aside>
  );
}
