import type { DiffMeta, FileChange, ResolvedGroup } from '@gloss/protocol';
import { describe, expect, it } from 'vitest';
import { checksSection, PYTHON_CHECKS } from './decision-checks.ts';
import { buildNotesPrompt } from './prompts.ts';

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

describe('checksSection', () => {
  it('lists the Python checks only for a group with Python source', () => {
    expect(checksSection([file('app/users/service.py')])).toEqual([
      '',
      '## Reviewer checks',
      expect.any(String),
      ...PYTHON_CHECKS.map((check) => `- ${check.text}`),
    ]);
    expect(checksSection([file('app/types.pyi')])).not.toEqual([]);
  });

  it('adds nothing for other languages and for Python tests', () => {
    expect(checksSection([file('src/app.ts'), file('ios/View.swift')])).toEqual([]);
    expect(checksSection([file('tests/users/test_service.py'), file('app/users/service_test.py')])).toEqual([]);
  });
});

describe('notes prompt checks', () => {
  const meta = { title: 'T', baseRef: 'main', headRef: 'b', commits: [] } as unknown as DiffMeta;
  const group = { key: 'g', label: 'G', summary: 'S', category: 'core', fileIds: [] } as unknown as ResolvedGroup;

  it('adds no checks section to a group without Python', () => {
    const files = [file('src/app.ts')];
    const prompt = buildNotesPrompt(meta, undefined, group, files, {});
    expect(prompt).not.toContain('## Reviewer checks');
    expect(prompt.indexOf('## Flagged risks')).toBeLessThan(prompt.indexOf('## Files'));
  });

  it('puts the checks between the flagged risks and the files', () => {
    const prompt = buildNotesPrompt(meta, undefined, group, [file('app/jobs.py')], {});
    const at = prompt.indexOf('## Reviewer checks');
    expect(at).toBeGreaterThan(prompt.indexOf('## Flagged risks'));
    expect(at).toBeLessThan(prompt.indexOf('## Files'));
  });
});
