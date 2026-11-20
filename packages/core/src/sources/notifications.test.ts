import { describe, expect, it } from 'vitest';
import { CommandError } from './exec.ts';
import { githubNotifications } from './notifications.ts';

const SINCE = 'Thu, 20 Nov 2026 16:00:00 GMT';
const LATER = 'Thu, 20 Nov 2026 16:05:00 GMT';

describe('githubNotifications', () => {
  it('asks with If-Modified-Since and reads a change, its Last-Modified and the poll interval', async () => {
    let asked: string[] = [];
    const check = await githubNotifications(SINCE, undefined, async (args) => {
      asked = args;
      return `HTTP/2.0 200 OK\r\nLast-Modified: ${LATER}\r\nX-Poll-Interval: 120\r\n\r\n[{"reason":"review_requested"}]`;
    });
    expect(asked).toEqual(['-i', '-H', `If-Modified-Since: ${SINCE}`, 'notifications?per_page=1']);
    expect(check).toEqual({ changed: true, lastModified: LATER, pollMs: 120_000 });
  });

  it('reads the 304 that gh fails on as no change, keeping the last Last-Modified', async () => {
    const check = await githubNotifications(SINCE, undefined, async () => {
      throw new CommandError(
        'gh api failed',
        'gh: HTTP 304',
        1,
        'HTTP/2.0 304 Not Modified\r\nX-Poll-Interval: 60\r\n\r\n',
      );
    });
    expect(check).toEqual({ changed: false, lastModified: SINCE, pollMs: 60_000 });
  });

  it('never polls faster than once a minute, and passes other failures on', async () => {
    const fast = await githubNotifications(
      undefined,
      undefined,
      async () => 'HTTP/2.0 200 OK\r\nX-Poll-Interval: 5\r\n\r\n[]',
    );
    expect(fast).toEqual({ changed: true, pollMs: 60_000 });
    await expect(
      githubNotifications(SINCE, undefined, async () => {
        throw new CommandError('gh api failed', 'gh: HTTP 401', 1, 'HTTP/2.0 401 Unauthorized\r\n\r\n');
      }),
    ).rejects.toThrow('gh api failed');
  });
});
