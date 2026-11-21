import {
  groupsInOrder,
  initialTourState,
  reduceTourEvent,
  type GroupView,
  type SourceRef,
  type TourState,
} from '@gloss/protocol';
import { useEffect, useMemo, useState } from 'react';
import { useBackend } from './backend.tsx';

export interface TourStream {
  state: TourState;
  groups: GroupView[];
  error?: string;
}

/**
 * Starts (or joins) the tour for `ref` and folds its events with the same reducer the web
 * app uses. The server dedupes jobs, so the web page in the WebView joins the same one.
 */
export function useTour(ref: SourceRef): TourStream {
  const { client } = useBackend();
  const [state, setState] = useState(initialTourState);
  const [error, setError] = useState<string>();
  const key = JSON.stringify(ref);

  useEffect(() => {
    const abort = new AbortController();
    let current = initialTourState();
    let flush: ReturnType<typeof setTimeout> | undefined;
    setState(current);
    setError(undefined);
    void (async () => {
      try {
        const { jobId } = await client.startTour(ref);
        for await (const event of client.events(jobId, { signal: abort.signal })) {
          current = reduceTourEvent(current, event);
          // Events can arrive hundreds at a time on replay; render at most every 100 ms.
          flush ??= setTimeout(() => {
            flush = undefined;
            setState(current);
          }, 100);
        }
        clearTimeout(flush);
        setState(current);
      } catch (cause) {
        if (!abort.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => {
      abort.abort();
      clearTimeout(flush);
    };
    // `key` stands for `ref`, which callers rebuild every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);

  const groups = useMemo(() => groupsInOrder(state), [state]);
  return { state, groups, error };
}
