import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiffPayload } from '@gloss/protocol';
import { describe, expect, test } from 'vitest';
import { sha256 } from '../hash.ts';
import { git } from './exec.ts';
import { readLfsObject } from './lfs.ts';

async function repoWithObject(bytes: Uint8Array) {
  const repo = await mkdtemp(join(tmpdir(), 'gloss-lfs-'));
  await git(repo, ['init', '-q']);
  const oid = sha256(bytes);
  const dir = join(repo, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, oid), bytes);
  const diff = { ref: { kind: 'local', repo, target: 'HEAD' } } as DiffPayload;
  return { diff, oid };
}

describe('readLfsObject', () => {
  test('reads a local object from the LFS store', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
    const { diff, oid } = await repoWithObject(bytes);
    expect([...(await readLfsObject(diff, { oid, size: bytes.length }))]).toEqual([...bytes]);
  });

  test('rejects bytes that do not match the oid', async () => {
    const { diff, oid } = await repoWithObject(new Uint8Array([1, 2, 3]));
    const other = 'f'.repeat(64);
    const dir = join(diff.ref.kind === 'local' ? diff.ref.repo : '', '.git', 'lfs', 'objects', 'ff', 'ff');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, other), new Uint8Array([1, 2, 3]));
    expect(oid).not.toBe(other);
    await expect(readLfsObject(diff, { oid: other, size: 3 })).rejects.toThrow(/does not match/);
  });
});
