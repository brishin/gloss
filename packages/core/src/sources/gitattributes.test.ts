import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isGenerated, parseGitattributes } from './gitattributes.ts';

const ATTRIBUTES = `
# comments and unrelated attributes are ignored
*.png binary
*.lock linguist-generated
/dist/** linguist-generated=true
packages/*/gen/*.ts linguist-generated
schema.graphql -diff
docs/** linguist-generated
docs/keep.md -linguist-generated
`;

const PATHS = [
  'yarn.lock',
  'deep/nested/Cargo.lock',
  'dist/a.js',
  'src/dist/a.js',
  'packages/x/gen/api.ts',
  'packages/x/y/gen/api.ts',
  'schema.graphql',
  'sub/schema.graphql',
  'docs/a/b.md',
  'docs/keep.md',
  'img.png',
  'src/main.ts',
];

describe('parseGitattributes', () => {
  it('agrees with git check-attr', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gloss-attr-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      writeFileSync(join(repo, '.gitattributes'), ATTRIBUTES);
      const out = execFileSync('git', ['check-attr', '-z', '--stdin', 'linguist-generated', 'diff'], {
        cwd: repo,
        input: PATHS.join('\0'),
      }).toString();
      const parts = out.split('\0');
      const expected = new Set<string>();
      for (let i = 0; i + 2 < parts.length; i += 3) {
        const [path, attr, value] = parts.slice(i, i + 3);
        if (
          (attr === 'linguist-generated' && (value === 'set' || value === 'true')) ||
          (attr === 'diff' && value === 'unset')
        ) {
          expected.add(path!);
        }
      }
      const rules = parseGitattributes(ATTRIBUTES);
      expect(PATHS.filter((path) => isGenerated(rules, path))).toEqual(PATHS.filter((path) => expected.has(path)));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
