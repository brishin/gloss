import { describe, expect, it } from 'vitest';
import { globMatcher } from './glob.ts';

describe('globMatcher', () => {
  it.each([
    ['*.py', 'app/models/user.py', true],
    ['*.py', 'user.py', true],
    ['*.py', 'user.pyc', false],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/lib/a.ts', false],
    ['src/*.ts', 'other/src/a.ts', false],
    ['src/**/*.ts', 'src/a.ts', true],
    ['src/**/*.ts', 'src/lib/deep/a.ts', true],
    ['**/*.{tsx,jsx}', 'apps/web/App.tsx', true],
    ['**/*.{tsx,jsx}', 'apps/web/App.ts', false],
    ['apps/web', 'apps/web/src/a.ts', true],
    ['apps/web/', 'apps/web/src/a.ts', true],
    ['/README.md', 'README.md', true],
    ['/README.md', 'docs/README.md', false],
    ['migrations', 'db/migrations/0001.sql', true],
    ['*.[ch]', 'lib/a.h', true],
    ['file?.txt', 'file1.txt', true],
    ['a.{b', 'a.{b', true],
    ['(', '(', true],
    ['[z-a].py', 'a.py', false],
    ['src/app/\\[id\\]/**', 'src/app/[id]/page.tsx', true],
    ['src/app/\\[id\\]/**', 'src/app/i/page.tsx', false],
    ['a\\*.md', 'a*.md', true],
    ['a\\*.md', 'ab.md', false],
  ])('%s on %s', (glob, path, matches) => {
    expect(globMatcher(glob)(path)).toBe(matches);
  });

  it('takes time in proportion to the path, whatever the glob', () => {
    const start = performance.now();
    expect(globMatcher(`${'*a'.repeat(200)}b.ts`)(`${'a'.repeat(400)}.ts`)).toBe(false);
    expect(globMatcher(`${'**/a'.repeat(50)}b`)(`${'a/'.repeat(200)}c`)).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('matches nothing past 64 brace alternatives', () => {
    expect(globMatcher('{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}')('aaaaaa')).toBe(true);
    expect(globMatcher('{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}')('aaaaaaa')).toBe(false);
  });
});
