import type { DiffMeta, FileChange, ResolvedGroup } from '@gloss/protocol';
import { describe, expect, it } from 'vitest';
import { checkBatches, mergeDecisions, PYTHON_CHECKS } from './decision-checks.ts';
import { buildChecksPrompt, buildNotesPrompt } from './prompts.ts';

const file = (path: string): FileChange => ({
  id: path,
  path,
  status: 'modified',
  additions: 1,
  deletions: 0,
  isBinary: false,
  truncated: false,
  hunks: [],
});

describe('checkBatches', () => {
  it('runs the Python checks only for a group with Python source', () => {
    expect(checkBatches([file('app/users/service.py')])).toEqual([PYTHON_CHECKS]);
    expect(checkBatches([file('app/types.pyi')], PYTHON_CHECKS, 'each')).toEqual(PYTHON_CHECKS.map((check) => [check]));
  });

  it('runs nothing for other languages and for Python tests', () => {
    expect(checkBatches([file('src/app.ts'), file('ios/View.swift')])).toEqual([]);
    expect(checkBatches([file('tests/users/test_service.py'), file('app/users/service_test.py')])).toEqual([]);
  });
});

describe('mergeDecisions', () => {
  const at = (fileId: string, line: number, text = '') => ({ fileId, side: 'additions', line, text });

  it('keeps every written decision and only check findings on new lines', () => {
    const written = [at('a', 10, 'usual')];
    const merged = mergeDecisions(written, [at('a', 12, 'dup'), at('a', 20, 'new'), at('b', 10, 'other file')]);
    expect(merged.map((decision) => decision.text)).toEqual(['usual', 'new', 'other file']);
  });

  it('drops a check finding that repeats another check finding', () => {
    expect(mergeDecisions([], [at('a', 5), at('a', 6)])).toHaveLength(1);
  });
});

describe('checks prompts', () => {
  const meta = { title: 'T', baseRef: 'main', headRef: 'b', commits: [] } as unknown as DiffMeta;
  const group = { key: 'g', label: 'G', summary: 'S', category: 'core', fileIds: [] } as unknown as ResolvedGroup;

  it('leaves the notes prompt free of checks, so it matches a tour without them', () => {
    const prompt = buildNotesPrompt(meta, undefined, group, [file('app/jobs.py')], {});
    expect(prompt).not.toContain('## Reviewer checks');
  });

  it('puts the checks last, after the files', () => {
    const prompt = buildChecksPrompt(meta, undefined, group, [file('app/jobs.py')], PYTHON_CHECKS.slice(0, 2));
    expect(prompt.indexOf('## Reviewer checks')).toBeGreaterThan(prompt.indexOf('## Files'));
    expect(prompt.endsWith(`- ${PYTHON_CHECKS[1]!.text}`)).toBe(true);
    expect(prompt).not.toContain('## Flagged risks');
  });
});
