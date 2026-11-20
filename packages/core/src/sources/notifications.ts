import { CommandError } from './exec.ts';
import { gh } from './github.ts';
import { responseStatus, splitResponse } from './repo-config.ts';

/** What one look at the viewer's GitHub notifications found. */
export interface NotificationsCheck {
  /** Something arrived since `since` (a review request among it, or anything else). */
  changed: boolean;
  /** The answer's `Last-Modified`, to pass as `since` next time. */
  lastModified?: string;
  /** How long GitHub asks clients to wait before they look again (`X-Poll-Interval`). */
  pollMs: number;
}

/** GitHub's usual `X-Poll-Interval`, and the least gloss waits whatever it says. */
const POLL_MS = 60_000;

/**
 * Whether the viewer's notifications changed since `since` (a `Last-Modified` from the last
 * look). A review request arrives here within seconds. It is a conditional request: GitHub
 * answers 304 when nothing changed, and a 304 does not count against the rate limit.
 */
export async function githubNotifications(
  since: string | undefined,
  signal?: AbortSignal,
  call: (args: string[]) => Promise<string> = (args) => gh(args, signal),
): Promise<NotificationsCheck> {
  let output: string;
  try {
    output = await call(['-i', ...(since ? ['-H', `If-Modified-Since: ${since}`] : []), 'notifications?per_page=1']);
  } catch (error) {
    // `gh` fails on any status past 299, a 304 too; `-i` has already printed the headers.
    const printed = error instanceof CommandError ? `${error.stdout}\n${error.stderr}` : '';
    if (responseStatus(printed) === 304) {
      return {
        changed: false,
        ...(since ? { lastModified: since } : {}),
        pollMs: pollMs(splitResponse(printed).headers),
      };
    }
    throw error;
  }
  const { headers } = splitResponse(output);
  const lastModified = headers.get('last-modified');
  return { changed: true, ...(lastModified ? { lastModified } : {}), pollMs: pollMs(headers) };
}

function pollMs(headers: ReadonlyMap<string, string>): number {
  const seconds = Number(headers.get('x-poll-interval'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(POLL_MS, seconds * 1000) : POLL_MS;
}
