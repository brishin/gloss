import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
