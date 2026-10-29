/** Ports a local gloss server may listen on: the default (4777) and the next few. */
export const PORTS = Array.from({ length: 10 }, (_, index) => 4777 + index);

/** The native messaging host `gloss extension install` registers to start the server. */
export const NATIVE_HOST = 'dev.gloss.launcher';

const PR_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#]|$)/;

/**
 * The gloss route for a GitHub pull request URL (any tab of it: files, commits, a comment
 * anchor), or undefined when the URL is not a pull request.
 * @param {string | undefined} url
 */
export function tourPath(url) {
  const match = url ? PR_RE.exec(url) : null;
  return match ? `/gh/${match[1]}/${match[2]}/pull/${match[3]}` : undefined;
}

/**
 * The base URL of a running gloss server on 127.0.0.1, preferring the lowest port.
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string | undefined>}
 */
export async function findServer(fetchImpl = fetch) {
  const found = await Promise.all(
    PORTS.map(async (port) => {
      const url = `http://127.0.0.1:${port}`;
      try {
        const response = await fetchImpl(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
        const body = response.ok ? await response.json() : undefined;
        return typeof body?.pipelineVersion === 'string' ? url : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return found.find(Boolean);
}
