import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { UpdateStatus } from '@gloss/protocol';

/** The gloss checkout this CLI runs from. */
export const CHECKOUT = fileURLToPath(new URL('../../..', import.meta.url));

/** The built web app (`pnpm --filter @gloss/web build`). */
export const WEB_ROOT = join(CHECKOUT, 'apps/web/dist/client');
export const SHELLS = ['index.html', '_shell.html'];
/** Sources compiled into the web build. */
const WEB_SOURCES = ['apps/web/src', 'packages/protocol/src'];

const FETCH_EVERY_MS = 5 * 60_000;

/**
 * Runs a tool in `root`. A server that the browser extension started has the browser's bare
 * PATH, so Node's own directory (where pnpm often lives) and Homebrew's come after it.
 */
async function sh(root: string, command: string, args: string[], timeout = 10 * 60_000): Promise<string> {
  const PATH = [process.env.PATH, dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin']
    .filter(Boolean)
    .join(delimiter);
  try {
    const { stdout } = await promisify(execFile)(command, args, {
      cwd: root,
      env: { ...process.env, PATH },
      timeout,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
    const reason = `${stderr}\n${stdout}`
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /error|fatal|ERR_/i.test(line));
    throw new Error(`${command} ${args.join(' ')} failed${reason ? `: ${reason}` : ''}`, { cause: error });
  }
}

/** The checkout's commit, or undefined when it is not a git checkout. */
export function headCommit(root = CHECKOUT): Promise<string | undefined> {
  return sh(root, 'git', ['rev-parse', 'HEAD']).catch(() => undefined);
}

/** Fetches the checkout's upstream; offline, the last fetch stands. */
export async function fetchUpstream(root = CHECKOUT): Promise<void> {
  await sh(root, 'git', ['fetch', '--quiet'], 30_000).catch(() => undefined);
}

/**
 * How many commits HEAD trails its upstream branch by, after fetching it when `fetch` is set.
 * Undefined without an upstream.
 */
export async function behindUpstream(root = CHECKOUT, fetch = true): Promise<number | undefined> {
  const upstream = await sh(root, 'git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(
    () => undefined,
  );
  if (!upstream) {
    return undefined;
  }
  if (fetch) {
    await fetchUpstream(root);
  }
  return Number(await sh(root, 'git', ['rev-list', '--count', 'HEAD..@{u}']));
}

/** Whether the web app is unbuilt, or older than a source compiled into it. */
export function webBuildStale(root = CHECKOUT): boolean {
  const shell = SHELLS.map((name) => join(root, 'apps/web/dist/client', name)).find((path) => existsSync(path));
  if (!shell) {
    return true;
  }
  const built = statSync(shell).mtimeMs;
  return WEB_SOURCES.some((source) =>
    readdirSync(join(root, source), { recursive: true, withFileTypes: true }).some(
      (entry) => entry.isFile() && statSync(join(entry.parentPath, entry.name)).mtimeMs > built,
    ),
  );
}

/**
 * Brings the checkout up to date: fast-forwards it to its upstream, installs dependencies, and
 * builds the web app when the pull brought commits or its build is stale. Returns the commit before and after; a checkout
 * that is not a git repository is left alone.
 */
export async function syncCheckout(
  log: (line: string) => void,
  root = CHECKOUT,
): Promise<{ before?: string; after?: string }> {
  const before = await headCommit(root);
  if (!before) {
    return {};
  }
  const behind = await behindUpstream(root);
  if (behind) {
    log(`Pulling ${behind} new commit${behind === 1 ? '' : 's'}…`);
    await sh(root, 'git', ['pull', '--ff-only', '--quiet']);
  }
  // No terminal to confirm in: pnpm would abort when it needs to rebuild node_modules.
  await sh(root, 'pnpm', ['install', '--prefer-offline', '--config.confirmModulesPurge=false']);
  const after = await headCommit(root);
  // New commits can change dependencies or build config, which the source check does not see.
  if (after !== before || webBuildStale(root)) {
    log('Building the web app…');
    await sh(root, 'pnpm', ['--filter', '@gloss/web', 'build']);
  }
  return { before, after };
}

/**
 * The server's side of `/api/update`. Status fetches the upstream at most every five minutes;
 * apply syncs the checkout, then calls `restart` (which replaces this server) after a moment,
 * so the response gets out first. One apply runs at a time.
 */
export function createUpdater(running: string | undefined, restart: () => void, root = CHECKOUT) {
  let fetchedAt = 0;
  let fetching: Promise<void> = Promise.resolve();
  let applying: Promise<void> | undefined;
  return {
    async status(): Promise<UpdateStatus> {
      if (Date.now() - fetchedAt > FETCH_EVERY_MS) {
        fetchedAt = Date.now();
        fetching = fetchUpstream(root);
      }
      // A check that comes in while another fetches waits for that fetch.
      await fetching;
      const [head, behind] = await Promise.all([headCommit(root), behindUpstream(root, false)]);
      return { running, head, behind: behind ?? 0 };
    },
    apply(): Promise<void> {
      applying ??= syncCheckout((line) => console.error(`gloss: ${line}`), root)
        .then(() => {
          setTimeout(restart, 250);
        })
        .finally(() => {
          applying = undefined;
        });
      return applying;
    },
  };
}
