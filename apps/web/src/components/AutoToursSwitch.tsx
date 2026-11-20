import { Switch } from '@astryxdesign/core/Switch';
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { AsyncResult } from 'effect/reactivity';
import { useEffect, useState } from 'react';
import { autoToursAtom, setAutoToursAtom } from '../lib/client.ts';

/**
 * The background tours switch: while on, the backend tours each PR that asks for your review
 * as it comes in, so its tour is ready when you open it. Hidden when the backend has no switch.
 */
export function AutoToursSwitch() {
  const loaded = AsyncResult.getOrElse(useAtomValue(autoToursAtom), () => undefined);
  const saving = useAtomValue(setAutoToursAtom);
  const set = useAtomSet(setAutoToursAtom);
  // What the user last picked, shown at once; the backend's answer wins once it lands. A failed
  // change shows the last state the backend confirmed, not the one the page loaded with.
  const [picked, setPicked] = useState<boolean>();
  const [confirmed, setConfirmed] = useState<boolean>();
  const answered = AsyncResult.isSuccess(saving) ? saving.value : undefined;
  useEffect(() => {
    if (answered !== undefined) setConfirmed(answered);
  }, [answered]);
  if (loaded === undefined) {
    return null;
  }
  const saved = answered ?? confirmed ?? loaded;
  const value = AsyncResult.isWaiting(saving) ? (picked ?? saved) : saved;
  return (
    <span className="auto-tours" title="Tour PRs that request your review in the background">
      <Switch
        size="sm"
        label="Watch PRs"
        labelPosition="start"
        value={value}
        onChange={(next) => {
          setPicked(next);
          set(next);
        }}
      />
    </span>
  );
}
