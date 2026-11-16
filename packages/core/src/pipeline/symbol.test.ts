import type { DiffPayload } from '@gloss/protocol';
import { expect, test } from 'vitest';
import { mayUse, normalizeSymbolCard, parseSymbolLines, symbolUses, type SymbolCardDraft } from './symbol.ts';

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
  expect(card.uses).toEqual({
    count: 3,
    files: 3,
    tests: 1,
    added: 1,
    calls: 0,
    skipped: 1,
    summary: 'Two call it.',
    lines: lines.slice(1),
  });
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

const grep = (sources: Record<string, string>, symbol: string) =>
  parseSymbolLines(
    Object.entries(sources).flatMap(([path, source]) =>
      source
        .split('\n')
        .flatMap((text, index) =>
          new RegExp(`(?<![\\w$])${symbol}(?![\\w$])`).test(text) ? [`${path}:${index + 1}:${text}`] : [],
        ),
    ),
  );
const kinds = async (sources: Record<string, string>, symbol: string, clicked: { path: string; line: number }) =>
  (await symbolUses(grep(sources, symbol), symbol, clicked, (path) => Promise.resolve(sources[path]))).lines.map(
    (use) => `${use.path}:${use.line} ${use.kind}`,
  );

test('the syntax tree tells a use from an import, a definition, a comment and a string', async () => {
  const sources = {
    'a.py': [
      'from b import s',
      'def f(s: int, *, t=s):',
      '    # s here',
      '    x = s(1)',
      '    g(s=3)',
      '    self.s = 4',
      '    return "s"',
      'class A:',
      '    s: int | None = None',
    ].join('\n'),
    'b.tsx': [
      "import { s } from './a';",
      'export function s() {}',
      'const y = s(1);',
      'const v = <Rail s={1} onSaved={s} />;',
      'f({ s: 1 });',
      'const o = { s: vi.fn() };',
      'type T = { s: string };',
      '// s',
    ].join('\n'),
    'c.txt': 'import s\ns()',
  };
  expect(await kinds(sources, 's', { path: 'b.tsx', line: 3 })).toEqual([
    'a.py:2 read',
    'a.py:4 call',
    'a.py:5 pass',
    'a.py:6 set',
    'b.tsx:3 call',
    'b.tsx:4 pass',
    'b.tsx:5 pass',
    'c.txt:2 undefined',
  ]);
  // Clicked as a member: only members count.
  expect(await kinds(sources, 's', { path: 'a.py', line: 6 })).toEqual([
    'a.py:5 pass',
    'a.py:6 set',
    'b.tsx:4 pass',
    'b.tsx:5 pass',
    'c.txt:2 undefined',
  ]);
});

test('a name defined inside a function, or not exported, is counted only where it can be seen', async () => {
  const sources = {
    'a.tsx': [
      'function Card() {',
      '  const { copy } = useCopy();',
      '  return <b onClick={copy} />;',
      '}',
      'function Other() {',
      '  const copy = 1;',
      '  return copy + 1;',
      '}',
      'const helper = () => 1;',
      'helper();',
    ].join('\n'),
    'b.ts': 'copy();\nhelper();',
  };
  expect(await kinds(sources, 'copy', { path: 'a.tsx', line: 3 })).toEqual(['a.tsx:3 read']);
  expect(await kinds(sources, 'helper', { path: 'a.tsx', line: 10 })).toEqual(['a.tsx:10 call']);
  // A name bound by a dynamic import is the module's export, not a local.
  const lazy = {
    'a.ts': "async function f() {\n  const { go } = await import('./go');\n  return go(1);\n}",
    'b.ts': "async function g() {\n  const { go } = await import('./go');\n  return go(2);\n}",
    // A file that neither imports nor defines it has some other `go`.
    'c.ts': 'function h(go: number) {\n  return go;\n}',
  };
  expect(await kinds(lazy, 'go', { path: 'a.ts', line: 3 })).toEqual(['a.ts:3 call', 'b.ts:3 call']);
});
