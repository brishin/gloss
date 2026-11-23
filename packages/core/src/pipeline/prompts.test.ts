import type { FileChange } from '@gloss/protocol';
import { describe, expect, it } from 'vitest';
import { FILE_BUDGET, fileCaps, groupBodies, isSource, pathBudget, quotedGaps, TOTAL_BUDGET } from './prompts.ts';

describe('quotedGaps', () => {
  const meta = {
    title: 'Admin tools: bulk email',
    description: 'Adds a **bulk send** to the\n  admin Comms page.\n\nOnly staff see it.',
    baseRef: 'a',
    headRef: 'b',
    commits: [{ sha: 's', subject: 'Keep the “old composer” for now' }],
  };

  it('keeps gaps that quote the title, description or commits, loosely', () => {
    const gaps = [
      { quote: 'bulk send to the admin Comms page', text: 'a' },
      { quote: '"Only staff see it."', text: 'b' },
      { quote: 'keep the "old composer"', text: 'c' },
      { quote: 'admin only, behind a flag', text: 'd' },
      { quote: '', text: 'e' },
    ];
    expect(quotedGaps(meta, gaps).map((gap) => gap.text)).toEqual(['a', 'b', 'c']);
  });
});

describe('fileCaps', () => {
  it('gives every file FILE_BUDGET when nothing is over it', () => {
    expect(fileCaps([100, FILE_BUDGET])).toEqual([FILE_BUDGET, FILE_BUDGET]);
  });

  it('lets a long file use what the other files leave under TOTAL_BUDGET', () => {
    expect(fileCaps([1_000, 50_000])).toEqual([FILE_BUDGET, 50_000]);
    expect(fileCaps([1_000, 70_000])).toEqual([FILE_BUDGET, TOTAL_BUDGET - 1_000]);
  });

  it('shares the spare room in order and never goes over TOTAL_BUDGET', () => {
    const caps = fileCaps([40_000, 40_000, 2_000]);
    expect(caps).toEqual([40_000, TOTAL_BUDGET - 40_000 - 2_000, FILE_BUDGET]);
    expect(caps.reduce((sum, cap, at) => sum + Math.min(cap, [40_000, 40_000, 2_000][at]!), 0)).toBe(TOTAL_BUDGET);
  });

  it('adds nothing when the group is already over TOTAL_BUDGET at FILE_BUDGET each', () => {
    expect(fileCaps(Array.from({ length: 6 }, () => 20_000))).toEqual(Array.from({ length: 6 }, () => FILE_BUDGET));
  });
});

describe('groupBodies', () => {
  const file = (id: string, rows: number): FileChange => ({
    id,
    path: `src/${id}.ts`,
    status: 'modified',
    additions: rows,
    deletions: 0,
    isBinary: false,
    truncated: false,
    hunks: [
      {
        id: 'h1',
        header: `@@ -0,0 +1,${rows} @@`,
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: rows,
        patch: Array.from({ length: rows }, (_, i) => `+const value${i} = compute(${i});`).join('\n'),
      },
    ],
  });

  it('shows a long file whole when the group has room for it', () => {
    const [small, long] = groupBodies([file('a', 20), file('b', 1_000)]);
    expect(long!.length).toBeGreaterThan(FILE_BUDGET);
    expect(long).not.toContain('truncated');
    expect(small).not.toContain('truncated');
  });

  it('cuts a long file only at what is left of TOTAL_BUDGET', () => {
    const bodies = groupBodies([file('a', 20), file('b', 3_000)]);
    expect(bodies[1]).toContain('... (truncated)');
    expect(bodies.reduce((sum, body) => sum + body!.length, 0)).toBeLessThanOrEqual(TOTAL_BUDGET + 20);
  });

  it('gives a collapsed file no body', () => {
    expect(groupBodies([{ ...file('a', 5), isBinary: true }])).toEqual([undefined]);
  });
});

describe('key path budget', () => {
  it('gives two paths to a small change, one more per five source files, at most six', () => {
    expect([0, 4, 9, 10, 15, 24, 25, 80].map(pathBudget)).toEqual([2, 2, 2, 3, 4, 5, 6, 6]);
  });

  it('counts only files with code a path can run through', () => {
    const at = (path: string, status: FileChange['status'] = 'modified') =>
      ({ id: path, path, status, additions: 1, deletions: 0, hunks: [] }) as unknown as FileChange;
    const counted = [
      at('src/api/route.ts'),
      at('app/models.py'),
      at('src/old.ts', 'removed'),
      at('src/route.test.ts'),
      at('package.json'),
      at('pnpm-lock.yaml'),
      at('README.md'),
      at('src/styles.css'),
      at('src/__snapshots__/a.snap'),
    ].filter(isSource);
    expect(counted.map((file) => file.path)).toEqual(['src/api/route.ts', 'app/models.py']);
  });
});
