import {
  ChatComposer,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatMessageMetadata,
  ChatToolCalls,
} from '@astryxdesign/core/Chat';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Markdown } from '@astryxdesign/core/Markdown';
import { Text } from '@astryxdesign/core/Text';
import { type AskAnswer, type FileSummary, parseAskRef } from '@gloss/protocol';
import { XIcon } from 'lucide-react';
import { type KeyboardEvent, memo } from 'react';
import { type AskModel, checkedRef, contextLabel } from '../lib/ask-model.ts';
import type { Msg } from '../lib/tour-model.ts';

/** How a checked citation's link reads once rewritten: a fragment, so the browser never follows it. */
const REF_PREFIX = '#gloss-ref=';

/**
 * Turns the answer's `[label](f1a2b3:42)` citations into in-page links when the backend checked
 * them against the diff, and into plain labels when it did not: model output is untrusted.
 */
export function linkRefs(answer: AskAnswer): string {
  return answer.text.replace(/\[([^\]\n]+)\]\(\s*([^)\s]+)\s*\)/g, (whole, label: string, href: string) => {
    const ref = parseAskRef(href);
    if (!ref) {
      return whole;
    }
    return answer.state === 'streaming' || !checkedRef(answer, ref) ? label : `[${label}](${REF_PREFIX}${href})`;
  });
}

const Answer = memo(function Answer({ answer, onJump }: { answer: AskAnswer; onJump: (fileId: string) => void }) {
  const streaming = answer.state === 'streaming';
  return (
    <ChatMessage
      sender="assistant"
      metadata={
        answer.state === 'done' ? (
          <ChatMessageMetadata timestamp={answer.model} />
        ) : answer.state === 'stopped' ? (
          <ChatMessageMetadata timestamp="Stopped" />
        ) : undefined
      }
    >
      {/* No bubble: the answer, the files it read and the model name share the list's left edge. */}
      <div className="ask-answer">
        {answer.tools.length > 0 && (
          <ChatToolCalls
            calls={answer.tools.map((tool) => ({
              key: tool.id,
              name: tool.name === 'read_file' ? 'Read' : tool.name,
              target: tool.target,
              status: tool.state === 'done' ? 'complete' : tool.state === 'failed' ? 'error' : 'running',
            }))}
          />
        )}
        {(answer.text || streaming) && (
          <Markdown
            isStreaming={streaming}
            onLinkClick={(href) => {
              if (!href.startsWith(REF_PREFIX)) {
                return;
              }
              const ref = parseAskRef(href.slice(REF_PREFIX.length));
              if (ref) {
                onJump(ref.fileId);
              }
              return false;
            }}
          >
            {linkRefs(answer)}
          </Markdown>
        )}
        {answer.state === 'failed' && <span className="ask-error">{answer.error ?? 'The answer failed.'}</span>}
      </div>
    </ChatMessage>
  );
});

/**
 * The Ask panel: a card floating at the right edge of the tour page, so the tour does not move
 * under the reader. Questions go to the model that wrote the tour, with the diff and the tour
 * as its context. All state is in the tour program's model (`ask-model.ts`).
 */
export function AskPanel({
  ask,
  files,
  model,
  enabled,
  dispatch,
}: {
  ask: AskModel;
  files: readonly FileSummary[];
  /** The model that wrote the tour, which answers. */
  model: string | undefined;
  enabled: boolean;
  dispatch: (msg: Msg) => void;
}) {
  const streaming = ask.turns.some((turn) => turn.answer.state === 'streaming');
  const pending = contextLabel(ask.context, files);
  const onJump = (fileId: string) => dispatch({ type: 'FileJumped', fileId });
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      dispatch({ type: 'AskClosed' });
    }
  };

  const composer = (
    <div className="ask-composer">
      {pending && (
        <div className="ask-context">
          <Text size="sm" color="secondary">
            About <code title={pending.path}>{pending.name}</code>
            {pending.lines}
          </Text>
          <IconButton
            size="sm"
            variant="ghost"
            label="Remove lines"
            icon={<Icon icon={XIcon} />}
            onClick={() => dispatch({ type: 'AskContextCleared' })}
          />
        </div>
      )}
      <ChatComposer
        density="compact"
        elevation="none"
        placeholder={
          !enabled ? 'You can ask once the tour is done' : pending ? 'Ask about these lines' : 'Ask about this change'
        }
        value={ask.draft}
        onChange={(draft) => dispatch({ type: 'AskDraftChanged', draft })}
        onSubmit={() => dispatch({ type: 'AskSubmitted' })}
        isStopShown={streaming}
        onStop={() => dispatch({ type: 'AskStopClicked' })}
        isDisabled={!enabled}
      />
    </div>
  );

  return (
    <aside className="ask-panel" aria-label="Ask" onKeyDown={onKeyDown}>
      <div className="ask-header">
        <Text weight="semibold">Ask</Text>
        <IconButton
          size="sm"
          variant="ghost"
          label="Close"
          tooltip="Close (Esc)"
          icon={<Icon icon={XIcon} />}
          onClick={() => dispatch({ type: 'AskClosed' })}
        />
      </div>
      <ChatLayout density="compact" composer={composer}>
        {ask.turns.length ? (
          // Top-aligned: a question stays put under the header while its answer grows below it.
          <ChatMessageList density="compact" align="top">
            {ask.turns.map((turn) => {
              const about = contextLabel(turn.context, files);
              return [
                <ChatMessage key={`q${turn.id}`} sender="user">
                  {about && (
                    <div className="ask-quote">
                      <Text size="sm" color="secondary">
                        <code title={about.path}>{about.name}</code>
                        {about.lines}
                      </Text>
                    </div>
                  )}
                  <ChatMessageBubble>{turn.question}</ChatMessageBubble>
                </ChatMessage>,
                <Answer key={`a${turn.id}`} answer={turn.answer} onJump={onJump} />,
              ];
            })}
          </ChatMessageList>
        ) : (
          <div className="ask-empty">
            <Text color="secondary">
              {model ?? 'The model'}, which wrote this tour, answers with the diff and the tour in context.
            </Text>
          </div>
        )}
      </ChatLayout>
    </aside>
  );
}
