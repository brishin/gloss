import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { GlossHttpError, updateAvailable } from '@gloss/protocol';
import { Cause } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { GlossRequestError, updateAtom, updateStatusAtom } from '../lib/client.ts';

/** What went wrong, from the backend's `{ error }` body when it sent one. */
function reason(failure: Cause.Cause<GlossRequestError>): string {
  const error = Cause.squash(failure);
  const cause = error instanceof GlossRequestError ? error.cause : error;
  if (cause instanceof GlossHttpError) {
    try {
      return (JSON.parse(cause.message) as { error: string }).error;
    } catch {
      return cause.message;
    }
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Shows when the backend's checkout has newer code. Update pulls, installs and builds there,
 * restarts the server, and reloads the page on the new version. Dismissed until the next load.
 */
export function UpdatePrompt() {
  const status = AsyncResult.getOrElse(useAtomValue(updateStatusAtom), () => undefined);
  const result = useAtomValue(updateAtom);
  const start = useAtomSet(updateAtom);
  const [dismissed, setDismissed] = useState(false);
  const done = AsyncResult.isSuccess(result);

  useEffect(() => {
    if (done) window.location.reload();
  }, [done]);

  if (!status || !updateAvailable(status) || dismissed) {
    return null;
  }
  if (AsyncResult.isWaiting(result) || done) {
    return (
      <div className="update-prompt" role="status">
        <Spinner size="sm" aria-label="Updating gloss" />
        <Text size="sm">Updating gloss…</Text>
      </div>
    );
  }
  const failed = AsyncResult.isFailure(result);
  return (
    <div className="update-prompt" role="status">
      <Text size="sm">{failed ? `Update failed: ${reason(result.cause)}` : 'A new version of gloss is ready.'}</Text>
      <Button size="sm" variant="primary" label={failed ? 'Retry' : 'Update'} onClick={() => start(status.running)} />
      <IconButton
        size="sm"
        variant="ghost"
        label="Dismiss"
        icon={<Icon icon={XIcon} />}
        onClick={() => setDismissed(true)}
      />
    </div>
  );
}
