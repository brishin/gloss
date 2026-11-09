import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { glossCacheDir } from './paths.ts';

describe('glossCacheDir', () => {
  it('is the OS cache dir, unless GLOSS_CACHE_DIR names one', () => {
    expect(glossCacheDir('darwin', {}, '/Users/b')).toBe(join('/Users/b', 'Library', 'Caches', 'gloss'));
    expect(glossCacheDir('linux', {}, '/home/b')).toBe(join('/home/b', '.cache', 'gloss'));
    expect(glossCacheDir('linux', { XDG_CACHE_HOME: '/x' }, '/home/b')).toBe(join('/x', 'gloss'));
    expect(glossCacheDir('win32', { LOCALAPPDATA: 'C:/L' }, 'C:/b')).toBe(join('C:/L', 'gloss', 'Cache'));
    expect(glossCacheDir('darwin', { GLOSS_CACHE_DIR: '/c' }, '/Users/b')).toBe('/c');
  });
});
