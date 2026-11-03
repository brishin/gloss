import type { DiffPayload, FileChange } from '@gloss/protocol';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../sources/contents.ts';
import { fileReader } from './read-file.ts';

const file = (id: string, path: string, status: FileChange['status'] = 'modified'): FileChange => ({
  id,
  path,
  status,
  additions: 1,
  deletions: 0,
  isBinary: false,
  truncated: false,
  hunks: [],
});
const diff: DiffPayload = {
  id: 'd',
  ref: { kind: 'local', repo: '/r', target: 'HEAD' },
  sourceKey: 'k',
  fingerprint: 'x',
  meta: { title: 't', baseRef: 'a', headRef: 'b', commits: [] },
  files: [file('f1', 'src/service.py'), file('f2', 'old.py', 'removed')],
};
const long = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n');

describe('repoPath', () => {
  it('keeps relative paths inside the repository', () => {
    expect(repoPath('src/a.ts')).toBe('src/a.ts');
    expect(repoPath('./src/a.ts')).toBe('src/a.ts');
    for (const bad of ['', '/etc/passwd', '../x', 'src/../../x', 'src//a', '-n', 'HEAD:x', 'a\\b', 'src/./a']) {
      expect(repoPath(bad)).toBeUndefined();
    }
  });
});

describe('fileReader', () => {
  it('reads a numbered window and says where to read on', async () => {
    const asked: string[] = [];
    const reader = fileReader(diff, async (path) => {
      asked.push(path);
      return long;
    });
    const first = await reader.tool.run({ path: 'src/service.py' });
    expect(first.split('\n')[0]).toBe('1 line 1');
    expect(first.split('\n').at(-1)).toBe('... (lines 1-400 of 1000; read from 401 for more)');
    const last = await reader.tool.run({ path: 'f1', from: 990 });
    expect(last.split('\n')).toEqual(Array.from({ length: 11 }, (_, i) => `${990 + i} line ${990 + i}`));
    expect(asked).toEqual(['src/service.py', 'src/service.py']);
    expect(reader.reads()).toEqual(['src/service.py lines 1-400', 'src/service.py lines 990-1000']);
  });

  it('clips one huge line', async () => {
    const reader = fileReader(diff, async () => `${'x'.repeat(100_000)}\nnext`);
    const out = await reader.tool.run({ path: 'bundle.js' });
    expect(out.length).toBeLessThan(25_000);
    expect(out).toContain('... (line cut)');
    expect(out).toContain('read from 2 for more');
  });

  it('refuses paths outside the repository, removed files, failed and binary reads, and too many reads', async () => {
    const reader = fileReader(diff, async (path) => {
      if (path === 'missing.py') {
        throw new Error('404');
      }
      return path === 'logo.png' ? 'PNG\0' : 'x';
    });
    expect(await reader.tool.run({ path: '../secret' })).toContain('not a path inside');
    expect(await reader.tool.run({ path: 'old.py' })).toContain('removed by this change');
    expect(await reader.tool.run({ path: 'missing.py' })).toContain('cannot be read');
    expect(await reader.tool.run({ path: 'logo.png' })).toContain('binary');
    expect(await reader.tool.run({ nope: 1 })).toContain('Give a path');
    for (let i = 0; i < 6; i++) {
      expect(await reader.tool.run({ path: 'a.py' })).toBe('1 x');
    }
    expect(await reader.tool.run({ path: 'a.py' })).toContain('No reads left');
    expect(reader.reads()).toHaveLength(6);
  });
});
