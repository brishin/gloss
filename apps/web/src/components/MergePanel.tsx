import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { Popover } from '@astryxdesign/core/Popover';
import type { StackMember } from '@gloss/protocol';
import { CheckIcon, ClockIcon, GitMergeIcon, XIcon } from 'lucide-react';
import { type MergeModel, type MergeRow, mergeView } from '../lib/merge-model.ts';
import type { Msg } from '../lib/tour-model.ts';

const ROW_ICON = { ok: CheckIcon, bad: XIcon, info: ClockIcon } as const;

function Row({ row }: { row: MergeRow }) {
  return (
    <div className="merge-row" data-tone={row.tone}>
      <span className="merge-row-icon">
        {row.tone === 'wait' ? <span className="merge-dot" /> : <Icon icon={ROW_ICON[row.tone]} size="xsm" />}
      </span>
      <span>{row.text}</span>
      {row.detail && <span className="merge-row-detail">{row.detail}</span>}
      {row.end && <span className="merge-row-end">{row.end}</span>}
    </div>
  );
}

/**
 * Merging from the top bar, beside Review: a green Merge button opens what is left (checks,
 * review, the base, the queue) and the one thing to do now: merge, merge once ready, join the
 * merge queue or leave it. Only PRs the viewer may merge have it.
 */
export function MergePanel({
  pull,
  merge,
  dispatch,
}: {
  pull: StackMember & { merge: NonNullable<StackMember['merge']> };
  merge: MergeModel;
  dispatch: (msg: Msg) => void;
}) {
  const view = mergeView(pull);
  const panel = (
    <div className="merge-panel">
      {view.rows.map((row) => (
        <Row key={row.text} row={row} />
      ))}
      {merge.error && <Banner status="error" title="Not merged" description={merge.error} />}
      {(view.buttons.length > 0 || view.note) && (
        <div className="merge-actions">
          {view.note && <span className="merge-note">{view.note}</span>}
          {view.buttons.map((button) =>
            button.kind === 'merge' ? (
              <span key={button.action} className="merge-go">
                <Button
                  size="sm"
                  variant="primary"
                  label={button.label}
                  isLoading={merge.sending === button.action}
                  onClick={() => dispatch({ type: 'MergeClicked', action: button.action })}
                />
              </span>
            ) : (
              <Button
                key={button.action}
                size="sm"
                variant="ghost"
                label={button.label}
                isLoading={merge.sending === button.action}
                onClick={() => dispatch({ type: 'MergeClicked', action: button.action })}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
  return (
    <Popover
      label="Merge"
      isOpen={merge.open}
      onOpenChange={(open) => open !== merge.open && dispatch(open ? { type: 'MergeOpened' } : { type: 'MergeClosed' })}
      placement="below"
      alignment="end"
      width={360}
      isModal={false}
      hasAutoFocus={false}
      content={panel}
    >
      <span className="merge-go" data-state={pull.state}>
        <Button
          size="sm"
          variant="primary"
          label={pull.state === 'queued' ? 'Queued' : 'Merge'}
          icon={<Icon icon={GitMergeIcon} size="xsm" />}
        />
      </span>
    </Popover>
  );
}
