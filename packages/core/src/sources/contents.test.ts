import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiffPayload } from '@gloss/protocol';
import { describe, expect, it } from 'vitest';
import { findImporters, readRepoFile, reverseApply, searchRepo, StaleFileError } from './contents.ts';
import { fileImportQuery } from './importers.ts';
import { parseHunks } from './patch-parser.ts';

const hunks = (patch: string) => parseHunks(patch.split('\n'));

describe('reverseApply', () => {
  it.each([
    [
      'a change between unchanged lines',
      '1\n2\nTWO\n4\n5\n6\n7\n8\n9\n',
      '1\n2\n3\n4\n5\n6\n7\n8\n9\n',
      '@@ -2,3 +2,3 @@\n 2\n-3\n+TWO\n 4',
    ],
    [
      'two hunks, one adding and one removing lines',
      'x\n1\n2\n3\n4\n5\n6\n7\n9\n',
      '1\n2\n3\n4\n5\n6\n7\n8\n9\n',
      '@@ -1,2 +1,3 @@\n+x\n 1\n 2\n@@ -7,3 +8,2 @@\n 7\n-8\n 9',
    ],
    ['lines removed without context', '1\n2\n5\n', '1\n2\n3\n4\n5\n', '@@ -3,2 +2,0 @@\n-3\n-4'],
    ['lines added without context', '1\nx\n2\n', '1\n2\n', '@@ -1,0 +2 @@\n+x'],
    ['a file emptied', '', 'a\nb\n', '@@ -1,2 +0,0 @@\n-a\n-b'],
    ['a newline added at the end', 'a\nb\n', 'a\nb', '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b'],
    ['a newline removed at the end', 'a\nb', 'a\nb\n', '@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file'],
    [
      'an unchanged last line without a newline',
      'A\nb',
      'a\nb',
      '@@ -1,2 +1,2 @@\n-a\n+A\n b\n\\ No newline at end of file',
    ],
  ])('rebuilds the old side: %s', (_, newContents, oldContents, patch) => {
    expect(reverseApply(newContents, hunks(patch))).toBe(oldContents);
  });

  it('refuses a new side that no longer matches the patch', () => {
    const patch = hunks('@@ -2,3 +2,3 @@\n 2\n-3\n+TWO\n 4');
    expect(() => reverseApply('1\ninserted\n2\nTWO\n4\n', patch)).toThrow(StaleFileError);
  });

  it('leaves a file with no hunks (a rename) as it is', () => {
    expect(reverseApply('a\nb\n', [])).toBe('a\nb\n');
    expect(reverseApply('a\nb', [])).toBe('a\nb');
  });

  it('rebuilds a large file', () => {
    const tail = Array.from({ length: 200_000 }, (_, i) => `line ${i}`).join('\n');
    expect(reverseApply(`NEW\n${tail}\n`, hunks('@@ -1 +1 @@\n-old\n+NEW'))).toBe(`old\n${tail}\n`);
  });
});

describe('readRepoFile', () => {
  it('never follows a working-tree symlink out of the repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gloss-read-'));
    const repo = join(dir, 'repo');
    try {
      execFileSync('git', ['init', '-q', repo]);
      writeFileSync(join(dir, 'secret'), 'TOKEN');
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      symlinkSync('../secret', join(repo, 'linked'));
      const file = (path: string) => ({
        id: path,
        path,
        status: 'added' as const,
        additions: 1,
        deletions: 0,
        isBinary: false,
        truncated: false,
        hunks: [],
      });
      const diff: DiffPayload = {
        id: 'd',
        ref: { kind: 'local', repo, target: '' },
        sourceKey: 'k',
        fingerprint: 'x',
        meta: { title: 't', baseRef: 'a', headRef: 'b', commits: [] },
        files: [file('a.txt'), file('linked')],
      };
      expect(await readRepoFile(diff, 'a.txt')).toBe('a\n');
      expect(await readRepoFile(diff, 'linked')).toBe('../secret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('searchRepo', () => {
  it('finds callers in a working tree, untracked ones too, and nothing that is ignored', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gloss-search-'));
    try {
      execFileSync('git', ['init', '-q', repo]);
      writeFileSync(join(repo, 'shared.ts'), 'export function sharedThing() {}\n');
      writeFileSync(join(repo, '.gitignore'), 'build/\n');
      execFileSync('git', ['-C', repo, 'add', '.']);
      writeFileSync(join(repo, 'screen.ts'), 'sharedThing();\n');
      writeFileSync(join(repo, 'écran.ts'), 'sharedThing();\n');
      execFileSync('mkdir', [join(repo, 'build')]);
      writeFileSync(join(repo, 'build', 'out.js'), 'sharedThing();\n');
      const diff: DiffPayload = {
        id: 'd',
        ref: { kind: 'local', repo, target: '' },
        sourceKey: 'k',
        fingerprint: 'x',
        meta: { title: 't', baseRef: 'a', headRef: 'b', commits: [] },
        files: [],
      };
      expect(await searchRepo(diff, { cwd: repo }, 'sharedThing', undefined)).toEqual([
        'screen.ts:1:sharedThing();',
        'shared.ts:1:export function sharedThing() {}',
        'écran.ts:1:sharedThing();',
      ]);
      expect(await searchRepo(diff, { cwd: repo }, 'notThere', undefined)).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('findImporters', () => {
  it('finds the real import in a file that also imports a namesake, once per file', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gloss-importers-'));
    try {
      execFileSync('git', ['init', '-q', repo]);
      writeFileSync(
        join(repo, 'screen.ts'),
        "import { A } from './mobile/Button';\nimport { B } from './web/Button';\nexport { C } from './web/Button';\n",
      );
      const diff: DiffPayload = {
        id: 'd',
        ref: { kind: 'local', repo, target: '' },
        sourceKey: 'k',
        fingerprint: 'x',
        meta: { title: 't', baseRef: 'a', headRef: 'b', commits: [] },
        files: [],
      };
      expect(await findImporters(diff, { cwd: repo }, fileImportQuery('web/Button.ts')!)).toEqual([
        "screen.ts:2:import { B } from './web/Button';",
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
