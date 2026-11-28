import { describe, expect, test } from 'vitest';
import { newSideLines, renderTourMarkdown } from './tour-text.ts';
import type { Tour } from './tour.ts';

const file = (id: string, path: string) => ({
  id,
  path,
  status: 'modified' as const,
  additions: 3,
  deletions: 1,
  isBinary: false,
  truncated: false,
  hunkIds: [`h${id}`],
});
const snippet = { fileId: 'fa', hunkId: 'hfa', from: 11, to: 12, focus: 11, caption: 'c' };
const tour: Tour = {
  diffId: 'd',
  ref: { kind: 'github-pr', owner: 'o', repo: 'r', number: 7 },
  meta: {
    title: 'Retry uploads',
    description: 'the PR body, which the agent already has',
    url: 'https://github.com/o/r/pull/7',
    baseRef: 'main',
    headRef: 'f',
    headSha: '0123456789abcdef',
    commits: [],
  },
  files: [file('fa', 'src/upload.ts'), file('fb', 'src/upload.test.ts')],
  overallSummary: 'Uploads retry twice.',
  decisions: [
    { text: 'Retries without a cap on total time.', priority: 'high' },
    { text: 'The description promises backoff; the diff has none.', priority: 'medium', source: 'description' },
  ],
  walkthrough: {
    decisions: [
      { decision: 0, title: 'Retry twice', why: 'Flaky networks.', snippets: [snippet], refs: [], links: [] },
    ],
    frames: [],
    steps: [],
  },
  groups: [
    {
      key: 'core',
      label: 'Upload retries',
      summary: 'The retry loop.',
      category: 'core',
      critical: true,
      fileIds: ['fa'],
    },
    {
      key: 'tests',
      label: 'Tests',
      summary: 'Tests.',
      category: 'tests',
      critical: false,
      fileIds: ['fb'],
      synthetic: true,
    },
  ],
  placements: { fa: { groupKey: 'core', reason: 'llm' }, fb: { groupKey: 'tests', reason: 'heuristic' } },
  judgments: { fa: { generated: 0.01, testsOnly: 0.02 } },
  notes: {
    core: {
      fileNotes: [{ fileId: 'fa', text: 'Whole-file note.' }],
      lineNotes: [{ fileId: 'fa', hunkId: 'hfa', side: 'deletions', line: 9, text: 'The old timeout is gone.' }],
      riskNotes: [],
      decisions: [
        { text: 'Retries on 4xx too.', priority: 'urgent', fileId: 'fa', hunkId: 'hfa', side: 'additions', line: 12 },
        { text: 'Keeps the old error type.', priority: 'low', fileId: 'fa' },
      ],
      section: {
        points: [
          { kind: 'decision', decision: 0, title: 'Retries on 4xx', why: 'Simpler loop.', snippets: [snippet] },
          { kind: 'wide', wide: 0, title: 'Retry twice', why: 'w', snippets: [] },
        ],
        skim: [],
      },
    },
  },
  models: { define: 'm', followup: 'm', notes: 'm' },
};

describe('renderTourMarkdown', () => {
  const full = renderTourMarkdown(tour);
  const brief = renderTourMarkdown(tour, { detail: 'brief' });

  test('cites code by path and new-side line, a removed line as -line, and never by id', () => {
    expect(full).toContain('https://github.com/o/r/pull/7 @ 012345678');
    expect(full).toContain('- P3 Keeps the old error type. (src/upload.ts)');
    expect(full).toContain('- src/upload.ts:-9: The old timeout is gone.');
    expect(full).toContain('Code: src/upload.ts:11-12');
    expect(full).not.toMatch(/\bf[ab]\b|\bhfa\b/);
  });

  test('every file is listed in exactly one group', () => {
    for (const path of ['src/upload.ts +3-1', 'src/upload.test.ts +3-1']) {
      expect(full.split(path).length - 1).toBe(1);
    }
  });

  test('leaves out what only the page uses', () => {
    expect(full).not.toContain('the PR body');
    expect(full).not.toContain('testsOnly');
    expect(full).not.toContain('heuristic');
  });

  test('a decision a stop reads is printed once, as the stop; a wide stop points at the walkthrough', () => {
    expect(full).not.toContain('Retries on 4xx too.');
    expect(full).toContain('### Retries on 4xx (P0)');
    expect(full).toContain('- P3 Keeps the old error type. (src/upload.ts)');
    expect(full.match(/### Retry twice/g)).toHaveLength(2);
    expect(full).toContain('Read in the walkthrough above.');
  });

  test('brief keeps decisions, groups and files, and drops notes and walks', () => {
    expect(brief).toContain('- P1 Retries without a cap on total time.');
    expect(brief).toContain('- P2 Description: The description promises backoff; the diff has none.');
    expect(brief).toContain('- P0 Retries on 4xx too. (src/upload.ts:12)');
    expect(brief).toContain('## Upload retries (critical)');
    expect(brief).not.toContain('The old timeout is gone.');
    expect(brief).not.toContain('###');
  });

  test('with the diff, a snippet prints its lines instead of its range', () => {
    const hunks = [
      { id: 'hfa', header: '', oldStart: 9, oldLines: 2, newStart: 10, newLines: 3, patch: ' a\n-b\n+c\n+d' },
    ];
    const text = renderTourMarkdown(tour, { files: [{ id: 'fa', hunks }] });
    expect(text).toContain('```diff src/upload.ts:11-12\n+c\n+d\n```');
    expect(text).not.toContain('Code: src/upload.ts:11-12');
  });
});

describe('newSideLines', () => {
  test('numbers context and added lines by the new file and skips removed ones', () => {
    const hunk = { newStart: 5, patch: ' five\n-gone\n+six\n seven\n\\ No newline at end of file' };
    expect(newSideLines(hunk, 6, 7)).toEqual(['+six', ' seven']);
  });
});
