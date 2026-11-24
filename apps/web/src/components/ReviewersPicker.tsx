import { Banner } from '@astryxdesign/core/Banner';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Popover } from '@astryxdesign/core/Popover';
import { TextInput } from '@astryxdesign/core/TextInput';
import type { StackMember } from '@gloss/protocol';
import { UserPlusIcon, UsersIcon, XIcon } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef } from 'react';
import { pickerRows, type ReviewersModel, type Who } from '../lib/reviewers-model.ts';
import type { Msg } from '../lib/tour-model.ts';

const WHY_LABEL = { wrote: 'Wrote these files', reviewed: 'Reviewed these files' } as const;

const STATE_LABEL = {
  approved: 'Approved',
  changes: 'Requested changes',
  commented: 'Commented',
  pending: 'Waiting',
} as const;

function Face({ login, team }: Who) {
  return team ? (
    <span className="reviewer-team picker-face">
      <Icon icon={UsersIcon} size="xsm" />
    </span>
  ) : (
    <img
      className="reviewer-avatar picker-face"
      src={`https://github.com/${encodeURIComponent(login)}.png?size=40`}
      alt=""
      width={20}
      height={20}
      loading="lazy"
    />
  );
}

/**
 * Asking for reviews, as on GitHub's sidebar: an icon after the reviewers' faces opens a search,
 * GitHub's suggested reviewers with why, then who is reviewing now. A pick asks at once.
 */
export function ReviewersPicker({
  pull,
  reviewers,
  dispatch,
}: {
  pull: StackMember;
  reviewers: ReviewersModel;
  dispatch: (msg: Msg) => void;
}) {
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (reviewers.open) {
      requestAnimationFrame(() => search.current?.focus());
    }
  }, [reviewers.open]);
  const { suggested, found } = pickerRows(pull, reviewers);
  const add = (who: Who) => dispatch({ type: 'ReviewerAdded', who });
  const first = suggested[0] ?? found[0];
  const onSearchKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && first) {
      event.preventDefault();
      add({ login: first.login });
    }
  };
  const current = pull.reviewers ?? [];
  const searching = reviewers.query.trim() !== '';

  const panel = (
    <div className="reviewers-picker">
      <TextInput
        ref={search}
        size="sm"
        label="Request a reviewer"
        isLabelHidden
        placeholder="Request a reviewer"
        value={reviewers.query}
        onChange={(query) => dispatch({ type: 'ReviewerQueryChanged', query })}
        onKeyDown={onSearchKey}
      />
      {(suggested.length > 0 || found.length > 0) && (
        <div className="picker-rows">
          {suggested.map((one) => (
            <button type="button" key={one.login} className="picker-row" onClick={() => add({ login: one.login })}>
              <Face login={one.login} />
              <span className="picker-login">{one.login}</span>
              <span className="picker-aside">{WHY_LABEL[one.why]}</span>
            </button>
          ))}
          {found.map((one) => (
            <button type="button" key={one.login} className="picker-row" onClick={() => add({ login: one.login })}>
              <Face login={one.login} />
              <span className="picker-login">{one.login}</span>
              {one.name && <span className="picker-aside">{one.name}</span>}
            </button>
          ))}
        </div>
      )}
      {searching &&
        found.length === 0 &&
        suggested.length === 0 &&
        reviewers.found?.query === reviewers.query.trim() && <p className="picker-empty">No one with access matches</p>}
      {current.length > 0 && !searching && (
        <div className="picker-rows picker-current">
          {current.map((reviewer) => (
            <div key={reviewer.login} className="picker-row">
              <Face login={reviewer.login} team={reviewer.team} />
              <span className="picker-login">{reviewer.login}</span>
              <span className="picker-aside">{STATE_LABEL[reviewer.state]}</span>
              {reviewer.state === 'pending' && (
                <IconButton
                  size="sm"
                  variant="ghost"
                  label={`Remove ${reviewer.login}`}
                  icon={<Icon icon={XIcon} />}
                  onClick={() =>
                    dispatch({ type: 'ReviewerRemoved', who: { login: reviewer.login, team: reviewer.team } })
                  }
                />
              )}
            </div>
          ))}
        </div>
      )}
      {reviewers.error && <Banner status="error" title="Not changed" description={reviewers.error} />}
    </div>
  );

  return (
    <Popover
      label="Request review"
      isOpen={reviewers.open}
      onOpenChange={(open) =>
        open !== reviewers.open && dispatch(open ? { type: 'ReviewersOpened' } : { type: 'ReviewersClosed' })
      }
      placement="below"
      alignment="end"
      width={320}
      isModal={false}
      hasAutoFocus={false}
      content={panel}
    >
      <IconButton
        size="sm"
        variant="ghost"
        label="Request review"
        tooltip="Request review"
        icon={<Icon icon={UserPlusIcon} />}
      />
    </Popover>
  );
}
