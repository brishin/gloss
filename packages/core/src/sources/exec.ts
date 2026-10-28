import { execFile } from 'node:child_process';
import process from 'node:process';

/** Big enough for any diff a reviewer would open; `execFile` rejects past it rather than truncating. */
const MAX_BUFFER = 512 * 1024 * 1024;

export class CommandError extends Error {
  readonly stderr: string;
  readonly code: number | string | undefined;
  constructor(message: string, stderr: string, code: number | string | undefined) {
    super(message);
    this.name = 'CommandError';
    this.stderr = stderr;
    this.code = code;
  }
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  signal?: AbortSignal;
}

/** Runs a command without a shell, in the C locale so output parses the same everywhere. */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        maxBuffer: MAX_BUFFER,
        signal: options.signal,
        env: { ...process.env, LC_ALL: 'C', GIT_PAGER: 'cat', GH_PAGER: 'cat', NO_COLOR: '1', ...options.env },
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            reject(new CommandError(`\`${command}\` is not installed or not on PATH.`, '', code));
            return;
          }
          const detail = String(stderr).trim() || error.message;
          reject(new CommandError(`${command} ${args.slice(0, 3).join(' ')} failed: ${detail}`, String(stderr), code));
          return;
        }
        resolve(String(stdout));
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

export const git = (cwd: string, args: readonly string[], options: Omit<RunOptions, 'cwd'> = {}) =>
  run('git', args, { ...options, cwd });

export async function tryGit(cwd: string, args: readonly string[], options?: Omit<RunOptions, 'cwd'>) {
  try {
    return await git(cwd, args, options);
  } catch {
    return undefined;
  }
}
