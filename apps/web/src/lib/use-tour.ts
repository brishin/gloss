import type { DiffPayload, SourceRef, TourEvent } from '@gloss/protocol';
import { GlossHttpError, initialTourState, reduceTourEvent } from '@gloss/protocol';
import { useCallback, useEffect, useReducer, useState } from 'react';
import * as v from 'valibot';
import { useGlossClient } from './client.tsx';

export type Connection = 'connecting' | 'streaming' | 'closed' | 'error';

export interface ConnectionError {
  title: string;
  message: string;
}

/** Tells a stale page apart from an unreachable backend: they need different fixes. */
function describeError(error: unknown): ConnectionError {
  const message = error instanceof Error ? error.message : String(error);
  if (v.isValiError(error)) {
    return {
      title: 'This page is out of date with the gloss backend',
      message: `The backend sent an event this build of the web app does not understand. Rebuild it with \`pnpm --filter @gloss/web build\` and reload. (${message})`,
    };
  }
  if (error instanceof GlossHttpError) {
    return { title: `The gloss backend returned an error (${error.status})`, message };
  }
  return { title: 'Could not reach the gloss backend', message };
}

/**
 * Starts (or attaches to) the tour for `ref` and folds its event stream through the
 * shared reducer. The page remounts per ref, so state never mixes two tours.
 */
export function useTour(ref: SourceRef) {
  const client = useGlossClient();
  const [state, dispatch] = useReducer(reduceTourEvent, undefined, initialTourState);
  const [diff, setDiff] = useState<DiffPayload>();
  const [connection, setConnection] = useState<Connection>('connecting');
  const [connectionError, setConnectionError] = useState<ConnectionError>();
  const [run, setRun] = useState({ id: 0, force: false });
  const [jobId, setJobId] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    setConnection('connecting');
    setConnectionError(undefined);
    (async () => {
      const started = await client.startTour(ref, { force: run.force });
      setJobId(started.jobId);
      setConnection('streaming');
      for await (const event of client.events(started.jobId, { signal: controller.signal })) {
        dispatch(event as TourEvent);
      }
      setConnection('closed');
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setConnection('error');
        setConnectionError(describeError(error));
      }
    });
    return () => controller.abort();
    // The ref is fixed for this page instance; `run` restarts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, run]);

  // Hunk bodies come separately from the event stream, as soon as the diff exists.
  useEffect(() => {
    if (!state.diffId || diff?.id === state.diffId) {
      return;
    }
    let cancelled = false;
    client
      .diff(state.diffId)
      .then((payload) => !cancelled && setDiff(payload))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, state.diffId, diff?.id]);

  const rerun = useCallback(() => setRun((current) => ({ id: current.id + 1, force: true })), []);
  const abort = useCallback(() => {
    if (jobId) {
      void client.abort(jobId);
    }
  }, [client, jobId]);

  return { state, diff, connection, connectionError, rerun, abort };
}
