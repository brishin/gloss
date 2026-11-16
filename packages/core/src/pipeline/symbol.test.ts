import type { DiffPayload } from '@gloss/protocol';
import { expect, test } from 'vitest';
import { mayUse, normalizeSymbolCard, parseSymbolLines, type SymbolCardDraft } from './symbol.ts';

const diff = {
  files: [
    {
      id: 'f1',
      path: 'src/a.ts',
      status: 'modified',
      hunks: [{ id: 'h1', header: '', oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, patch: '' }],
    },
  ],
} as unknown as DiffPayload;
const files: Record<string, string> = {
  'src/a.ts': Array.from({ length: 40 }, (_, index) => `a${index + 1}`).join('\n'),
  'src/b.ts': Array.from({ length: 40 }, (_, index) => `b${index + 1}`).join('\n'),
};
const read = (path: string) => Promise.resolve(files[path]);
const draft = (over: Partial<SymbolCardDraft>): SymbolCardDraft => ({
  checked: [],
  lead: ' Lead. Second sentence. ',
  rows: { label: '', items: [] },
  excerpt: { path: '', from: 0, to: 0 },
  uses: { skip: [], summary: '' },
  effect: '',
  definition: { path: '', line: 0 },
  ...over,
});

test('the excerpt is read from the repository and capped, never taken from the model', async () => {
  const card = await normalizeSymbolCard(draft({ excerpt: { path: 'src/b.ts', from: 3, to: 30 } }), 's', diff, read);
  expect(card.lead).toBe('Lead.');
  expect(card.excerpt).toEqual({ path: 'src/b.ts', from: 3, lines: ['b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10'] });
});

test('an excerpt the diff already shows, a missing file and a range past the end are dropped', async () => {
  for (const excerpt of [
    { path: 'src/a.ts', from: 10, to: 13 },
    { path: 'src/none.ts', from: 1, to: 2 },
    { path: 'src/b.ts', from: 39, to: 44 },
    { path: '../etc/passwd', from: 1, to: 2 },
  ]) {
    expect((await normalizeSymbolCard(draft({ excerpt }), 's', diff, read)).excerpt).toBeUndefined();
  }
});

test('rows need a label and two items; the definition says whether the diff shows it', async () => {
  const item = { value: 'x', where: 'threads', code: true };
  const one = await normalizeSymbolCard(draft({ rows: { label: 'callers pass', items: [item] } }), 's', diff, read);
  expect(one.rows).toBeUndefined();
  const five = await normalizeSymbolCard(
    draft({
      rows: { label: 'callers pass', items: [item, item, item, item, item] },
      definition: { path: 'src/a.ts', line: 11 },
    }),
    's',
    diff,
    read,
  );
  expect(five.rows?.items).toHaveLength(4);
  expect(five.definition).toEqual({ path: 'src/a.ts', line: 11, inDiff: true });
});

test('uses are counted from the grep lines, less the ones the model skips', async () => {
  const lines = parseSymbolLines([
    'src/a.ts:11:export function s() {',
    'src/a.ts:12:  s();',
    'src/b.ts:4:s()',
    'src/b.test.ts:9:  expect(s()).toBe(1);',
    'not a grep row',
  ]);
  const added = {
    files: [{ ...diff.files[0]!, hunks: [{ ...diff.files[0]!.hunks[0]!, patch: ' a10\n a11\n+a12\n a13' }] }],
  } as unknown as DiffPayload;
  const card = await normalizeSymbolCard(
    draft({ uses: { skip: [0, 9], summary: 'Two call it. More.' } }),
    's',
    added,
    read,
    lines,
  );
  expect(card.uses).toEqual({ count: 3, files: 3, tests: 1, added: 1, summary: 'Two call it.', lines: lines.slice(1) });
});

test('imports, comments and the defining line are not uses', () => {
  const uses = [
    'import { s } from "./a"',
    'from a import s',
    'const { s } = await import("./a");',
    '// s does this',
    'export async function s() {',
    'def s(self):',
    'const s = 1;',
    'return s(1);',
    'const t = s();',
    's,',
  ].filter((text) => mayUse(text, 's'));
  expect(uses).toEqual(['return s(1);', 'const t = s();', 's,']);
});
