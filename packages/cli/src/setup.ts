import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { glossPath } from '@gloss/models';
import type { GithubLogin, SetupStatus } from '@gloss/protocol';
import type { SetupHooks } from '@gloss/server';
import { bundledExtensionId, EXTENSION_DIR, installExtension, NATIVE_HOST, nativeHostDirs } from './extension.ts';

const BIN = fileURLToPath(new URL('./bin.ts', import.meta.url));
const DEVICE_URL = 'https://github.com/login/device';

/** The one-time code in what `gh auth login --web` prints ("! First copy your one-time code: ABCD-1234"). */
export function parseDeviceCode(output: string): string | undefined {
  return /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(output)?.[1];
}

/** `text` (a .env file) with `key` set to `value`: the existing line replaced, else one appended. */
export function upsertEnv(text: string, key: string, value: string): string {
  const line = `${key}=${JSON.stringify(value)}`;
  const lines = text.split('\n');
  const at = lines.findIndex((existing) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(existing));
  if (at >= 0) {
    lines[at] = line;
    return lines.join('\n');
  }
  const body = text.replace(/\n*$/, '');
  return `${body ? `${body}\n` : ''}${line}\n`;
}

/** Whether `gloss extension install` (or the setup page) registered the native host for any browser. */
export function nativeHostInstalled(platform = process.platform, home = homedir()): boolean {
  return nativeHostDirs(platform, home).some(({ dir }) => existsSync(join(dir, `${NATIVE_HOST}.json`)));
}

/** The `gh` login: `undefined` when signed out, `null` when `gh` is not on PATH. */
function githubUser(): Promise<string | undefined | null> {
  return new Promise((resolve) => {
    execFile('gh', ['api', 'user', '--jq', '.login'], { timeout: 10_000 }, (error, stdout) => {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') resolve(null);
      else resolve(error ? undefined : stdout.trim() || undefined);
    });
  });
}

/**
 * The setup page's backend side, on this machine: GitHub through `gh`, the extension's native
 * host, and a Jev key. Saving a key restarts the server on `port` (`gloss restart`), since Jev
 * is chosen when the server starts.
 */
export function createSetup({ port }: { port: number }): SetupHooks {
  /** The running `gh auth login --web`, kept until gh exits (signed in, failed or timed out). */
  let pending: { child: ChildProcess; login: Promise<GithubLogin>; code?: string } | undefined;

  const startGithubLogin = () => {
    const child = spawn('gh', ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const entry: { child: ChildProcess; login: Promise<GithubLogin>; code?: string } = {
      child,
      login: new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('GitHub did not give a sign-in code.'));
        }, 20_000);
        const read = (chunk: Buffer) => {
          output += chunk.toString();
          const code = parseDeviceCode(output);
          if (code && !entry.code) {
            entry.code = code;
            clearTimeout(timer);
            // gh waits for Enter, then opens the device page in this machine's browser.
            child.stdin?.write('\n');
            resolve({ code, url: DEVICE_URL });
          }
        };
        child.stdout?.on('data', read);
        child.stderr?.on('data', read);
        child.on('error', (error: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          reject(error.code === 'ENOENT' ? new Error('The GitHub CLI (gh) is not installed.') : error);
        });
        child.on('close', () => {
          clearTimeout(timer);
          if (pending === entry) pending = undefined;
          reject(new Error(output.trim().split('\n').at(-1) || 'gh auth login ended.'));
        });
      }),
    };
    pending = entry;
    return entry.login;
  };

  return {
    async status(): Promise<SetupStatus> {
      const user = await githubUser();
      return {
        github: {
          state: user === null ? 'missing' : user ? 'signed-in' : 'signed-out',
          login: user ?? undefined,
          pending: pending?.code && user === undefined ? { code: pending.code, url: DEVICE_URL } : undefined,
        },
        extension: { dir: EXTENSION_DIR, id: bundledExtensionId(), hostInstalled: nativeHostInstalled() },
      };
    },

    githubLogin: () => pending?.login ?? startGithubLogin(),

    async installNativeHost() {
      installExtension();
    },

    async saveJudgeKey(key) {
      const path = glossPath('.env');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, upsertEnv(existsSync(path) ? readFileSync(path, 'utf8') : '', 'TYPESAFE_API_KEY', key));
      chmodSync(path, 0o600);
      // After the response goes out: the restart stops this server and starts it again.
      setTimeout(() => {
        spawn(process.execPath, [BIN, 'restart', '--port', String(port)], { detached: true, stdio: 'ignore' }).unref();
      }, 200);
    },
  };
}
