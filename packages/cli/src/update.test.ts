import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { behindUpstream, createUpdater, headCommit, webBuildStale } from './update.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

/** A remote with one commit, a clone of it, and a second clone to push new commits from. */
function repos() {
  const root = mkdtempSync(join(tmpdir(), 'gloss-update-'));
  const remote = join(root, 'remote.git');
  git(root, 'init', '--bare', '-b', 'main', remote);
  const commit = (cwd: string, name: string) => {
    writeFileSync(join(cwd, name), name);
    git(cwd, 'add', name);
    git(cwd, 'commit', '-m', name);
    git(cwd, 'push', '-q', 'origin', 'HEAD:main');
  };
  git(root, 'clone', '-q', remote, 'other');
  commit(join(root, 'other'), 'a');
  git(root, 'clone', '-q', remote, 'checkout');
  return { checkout: join(root, 'checkout'), push: (name: string) => commit(join(root, 'other'), name), root };
}

describe('update', () => {
  it('counts the upstream commits the checkout does not have', async () => {
    const { checkout, push } = repos();
    expect(await behindUpstream(checkout)).toBe(0);
    push('b');
    push('c');
    expect(await behindUpstream(checkout, false)).toBe(0);
    expect(await behindUpstream(checkout)).toBe(2);
  });

  it('has no upstream to compare on a branch without one, or outside git', async () => {
    const { checkout, root } = repos();
    git(checkout, 'checkout', '-q', '-b', 'local');
    expect(await behindUpstream(checkout)).toBeUndefined();
    expect(await headCommit(root)).toBeUndefined();
  });

  it('reports a pull made without a restart, and fetches at most every few minutes', async () => {
    const { checkout, push } = repos();
    const running = await headCommit(checkout);
    const updater = createUpdater(running, () => {}, checkout);
    expect(await updater.status()).toEqual({ running, head: running, behind: 0 });
    push('b');
    expect((await updater.status()).behind).toBe(0);
    git(checkout, 'pull', '-q', '--ff-only');
    const status = await updater.status();
    expect(status.head).not.toBe(running);
    expect(status.behind).toBe(0);
  });

  it('calls the web build stale when it is missing or older than a source', () => {
    const root = mkdtempSync(join(tmpdir(), 'gloss-web-'));
    for (const dir of ['apps/web/src', 'packages/protocol/src', 'apps/web/dist/client']) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    writeFileSync(join(root, 'apps/web/src/a.ts'), '');
    expect(webBuildStale(root)).toBe(true);
    const shell = join(root, 'apps/web/dist/client/_shell.html');
    writeFileSync(shell, '');
    utimesSync(shell, new Date(), new Date(Date.now() + 60_000));
    expect(webBuildStale(root)).toBe(false);
    writeFileSync(join(root, 'packages/protocol/src/b.ts'), '');
    utimesSync(shell, new Date(), new Date(Date.now() - 60_000));
    expect(webBuildStale(root)).toBe(true);
  });
});
