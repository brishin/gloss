import { expect, test } from 'vitest';
import { symbolSites, synthSystem } from './symbol-fanout.ts';
import { SYMBOL_SYSTEM } from './symbol.ts';

const files: Record<string, string> = {
  'app/a.py': [
    'def gate(self):',
    '    return self.flag',
    '',
    'def run(self):',
    '    if gate():',
    '        go()',
    '    gate()',
  ].join('\n'),
  'tests/test_a.py': ['def test_one():', '    gate()', '', 'def test_two():', '    gate()'].join('\n'),
};
const read = async (path: string) => files[path];

test('one reader per block: the click, the definition, then uses outside tests, one test at most', async () => {
  const sites = await symbolSites(
    [{ path: 'app/a.py', line: 1 }],
    [
      { path: 'tests/test_a.py', line: 2, kind: 'call' },
      { path: 'tests/test_a.py', line: 5, kind: 'call' },
      { path: 'app/a.py', line: 7, kind: 'call' },
    ],
    { path: 'app/a.py', line: 5 },
    read,
  );
  expect(sites.map((site) => [site.role, site.path, site.from, site.to, site.marks])).toEqual([
    ['clicked', 'app/a.py', 4, 7, [5, 7]],
    ['definition', 'app/a.py', 1, 2, [1]],
    ['use', 'tests/test_a.py', 1, 2, [2]],
  ]);
  expect(sites[0]!.code.split('\n')[1]).toBe('>    5     if gate():');
});

test('the card call keeps the card rules and drops the reading and checked', () => {
  const system = synthSystem(SYMBOL_SYSTEM);
  expect(system).toContain('lead: ONE sentence');
  expect(system).toContain('## Leave out');
  expect(system).not.toContain('checked:');
  expect(system).not.toContain('## Look first');
});
