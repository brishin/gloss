import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createSqliteCacheStore } from './sqlite.ts';

// Another process takes the write lock, holds it briefly, then commits.
const HOLD_LOCK = `
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.argv[1]);
  db.exec('BEGIN IMMEDIATE');
  db.exec("INSERT INTO entries VALUES ('other', 'notes', '1', NULL, 0, 1)");
  console.log('locked');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  db.exec('COMMIT');
`;

describe('sqlite cache store', () => {
  it('waits for another process holding the write lock instead of failing', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'gloss-cache-')), 'cache.sqlite');
    const store = createSqliteCacheStore(path);
    const child = spawn(process.execPath, ['-e', HOLD_LOCK, path], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    await new Promise((resolve) => child.stdout.once('data', resolve));

    store.put('mine', 'notes', { ok: true });

    expect(await exited).toBe(0);
    expect(store.get('mine')).toEqual({ ok: true });
    expect(store.get('other')).toBe(1);
    store.close();
  });

  it('adds the author column to an older file and lists each PR with its author and last stack', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'gloss-cache-')), 'cache.sqlite');
    const old = new DatabaseSync(path);
    old.exec(
      'CREATE TABLE recent (source_key TEXT PRIMARY KEY, ref TEXT NOT NULL, title TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    );
    old.exec(`INSERT INTO recent VALUES ('old', '{"kind":"local","repo":"/r","target":"HEAD"}', 'Old', 0)`);
    old.close();

    const store = createSqliteCacheStore(path);
    const ref = { kind: 'github-pr', owner: 'O', repo: 'R', number: 2 } as const;
    store.recordRecent(ref, 'pr2', 'Two', 'ana');
    const member = (number: number) => ({
      number,
      title: `#${number}`,
      state: 'open' as const,
      baseRef: 'b',
      headRef: 'h',
    });
    store.recordStack({ owner: 'o', repo: 'r', base: 'main', members: [member(1), member(2)] });

    const [pr, local] = store.listRecent();
    expect(pr).toMatchObject({ title: 'Two', author: 'ana', stack: { members: [{ number: 1 }, { number: 2 }] } });
    expect(local).toMatchObject({ title: 'Old' });
    expect(local).not.toHaveProperty('author');
    expect(local).not.toHaveProperty('stack');
    store.close();
  });
});
