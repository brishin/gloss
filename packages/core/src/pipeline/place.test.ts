import type { FileChange, FileJudgment, GroupDefinition } from '@gloss/protocol';
import { describe, expect, it } from 'vitest';
import { YES } from './judge-questions.ts';
import { applyFollowup, placeFiles, reconcileListedFiles, resolveGroups } from './place.ts';

const file = (id: string, extra: Partial<FileChange> = {}): FileChange => ({
  id,
  path: `src/${id}.ts`,
  status: 'modified',
  additions: 1,
  deletions: 0,
  isBinary: false,
  truncated: false,
  hunks: [],
  ...extra,
});

const groups: GroupDefinition[] = [
  { key: 'feature', label: 'Feature', summary: 'The feature.', category: 'core' },
  { key: 'docs', label: 'Docs', summary: 'Docs.', category: 'docs' },
];

const confident = (choice: string): FileJudgment => ({
  group: { choice, confidence: 0.9, probabilities: { [choice]: 0.9, other: 0.1 } },
  fitsAnyGroup: 0.9,
});

describe('placeFiles', () => {
  it('treats the YES threshold as inclusive for generated and tests-only', () => {
    const files = [file('a'), file('b'), file('c')];
    const { placements } = placeFiles(files, groups, {
      a: { ...confident('feature'), generated: YES },
      b: { ...confident('feature'), generated: YES - 0.01, testsOnly: YES },
      c: { ...confident('feature'), testsOnly: YES - 0.01 },
    });
    expect(placements.a).toMatchObject({ groupKey: 'generated', reason: 'jev' });
    expect(placements.b).toMatchObject({ groupKey: 'tests', reason: 'jev' });
    expect(placements.c).toMatchObject({ groupKey: 'feature', reason: 'jev' });
  });

  it('lets .gitattributes win over any judgment', () => {
    const { placements } = placeFiles([file('a', { generated: 'gitattributes' })], groups, { a: confident('feature') });
    expect(placements.a).toEqual({ groupKey: 'generated', reason: 'gitattributes' });
  });

  it('routes docs and agent guidance to the docs group, whatever Jev chose', () => {
    const paths = {
      agents: 'AGENTS.md',
      claude: 'packages/app/CLAUDE.md',
      skill: '.claude/skills/review/SKILL.md',
      rules: '.cursor/rules/style.mdc',
      notes: '.agents/01-architecture.md',
      guide: 'docs/setup.md',
      readme: 'packages/core/README.md',
      generatedDocs: 'docs/api/reference.md',
      fixture: 'src/__fixtures__/example.md',
      changelog: 'CHANGELOG.md',
      requirements: 'requirements.txt',
    };
    const files = Object.entries(paths).map(([id, path]) => file(id, { path }));
    const judgments = Object.fromEntries(files.map((f) => [f.id, confident('feature')]));
    judgments.generatedDocs = { ...confident('feature'), generated: 0.9 };
    judgments.agents = { ...confident('feature'), generated: 0.9 };
    const groupOf = (defs: GroupDefinition[]) =>
      Object.fromEntries(
        Object.entries(placeFiles(files, defs, judgments).placements).map(([id, p]) => [id, p.groupKey]),
      );

    expect(groupOf(groups)).toEqual({
      agents: 'docs',
      claude: 'docs',
      skill: 'docs',
      rules: 'docs',
      notes: 'docs',
      guide: 'docs',
      readme: 'docs',
      generatedDocs: 'generated',
      fixture: 'feature',
      changelog: 'feature',
      requirements: 'feature',
    });
    // Without an LLM docs group they get the synthetic one.
    expect(groupOf(groups.filter((group) => group.category !== 'docs')).agents).toBe('guidance');
  });

  it('sends unsure, unfitting, unknown and unjudged files to the follow-up', () => {
    const files = [file('low'), file('close'), file('nofit'), file('unknown'), file('missing'), file('ok')];
    const outcome = placeFiles(files, groups, {
      low: { group: { choice: 'feature', confidence: 0.4, probabilities: { feature: 0.4, docs: 0.1 } } },
      close: { group: { choice: 'feature', confidence: 0.6, probabilities: { feature: 0.5, docs: 0.4 } } },
      nofit: { ...confident('feature'), fitsAnyGroup: 0.3 },
      unknown: confident('nope'),
      ok: confident('docs'),
    });
    expect(outcome.uncertain).toEqual(['low', 'close', 'nofit', 'unknown', 'missing']);
    expect(Object.keys(outcome.placements)).toEqual(['ok']);
  });
});

describe('placement never drops or duplicates a file', () => {
  it('holds through follow-up and resolution, whatever the model answers', () => {
    const files = Array.from({ length: 20 }, (_, i) => file(`f${i}`));
    const judgments = Object.fromEntries(files.map((f, i) => [f.id, i % 3 === 0 ? confident('feature') : {}]));
    const outcome = placeFiles(files, groups, judgments);
    const placements = applyFollowup(outcome, groups, [
      { fileId: 'f1', groupKey: 'docs' },
      { fileId: 'f2', groupKey: 'invented' },
      { fileId: 'nonexistent', groupKey: 'feature' },
      { fileId: 'f0', groupKey: 'docs' },
    ]);
    const resolved = resolveGroups(files, groups, { ...placements }, judgments);
    const placed = resolved.flatMap((group) => group.fileIds);
    expect(placed.toSorted()).toEqual(files.map((f) => f.id).toSorted());
    expect(new Set(placed).size).toBe(files.length);
    expect(placements.f0?.groupKey).toBe('feature');
    expect(placements.f1?.groupKey).toBe('docs');
    expect(placements.f2?.groupKey).toBe('uncategorized');
  });

  it('keeps the first claim when the LLM lists a file twice, and reports unknown ids', () => {
    const files = [file('a'), file('b')];
    const result = reconcileListedFiles(files, [
      { ...groups[0]!, fileIds: ['a', 'zzz'] },
      { ...groups[1]!, fileIds: ['a'] },
    ]);
    expect(result.placements.a?.groupKey).toBe('feature');
    expect(result.uncertain).toEqual(['b']);
    expect(result.unknownIds).toEqual(['zzz']);
  });
});

describe('resolveGroups', () => {
  it('leads with docs and guidance, then LLM order, then tests and synthetic groups; flags critical groups', () => {
    const files = [file('a'), file('b'), file('c'), file('d')];
    const resolved = resolveGroups(
      files,
      groups,
      {
        a: { groupKey: 'docs', reason: 'jev' },
        b: { groupKey: 'generated', reason: 'jev' },
        c: { groupKey: 'feature', reason: 'jev' },
        d: { groupKey: 'tests', reason: 'jev' },
      },
      { c: { authCheck: 0.8 } },
    );
    expect(resolved.map((group) => group.key)).toEqual(['docs', 'feature', 'tests', 'generated']);
    expect(resolved.find((group) => group.key === 'feature')?.critical).toBe(true);
    expect(resolved.find((group) => group.key === 'docs')?.critical).toBe(false);
  });

  it('puts the synthetic guidance group first when the LLM defined no docs group', () => {
    const files = [file('a'), file('b')];
    const resolved = resolveGroups(
      files,
      groups.filter((group) => group.category !== 'docs'),
      { a: { groupKey: 'feature', reason: 'jev' }, b: { groupKey: 'guidance', reason: 'guidance' } },
      {},
    );
    expect(resolved.map((group) => [group.key, group.synthetic ?? false])).toEqual([
      ['guidance', true],
      ['feature', false],
    ]);
  });
});
