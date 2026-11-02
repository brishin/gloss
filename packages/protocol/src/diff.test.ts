import { describe, expect, test } from 'vitest';
import { lfsPointer } from './diff.ts';

const V = 'version https://git-lfs.github.com/spec/v1';
const sha = (c: string) => c.repeat(64);
const oid = (c: string) => `oid sha256:${sha(c)}`;
const file = (...patch: string[]) => ({ hunks: [{ patch: patch.join('\n') }] });

describe('lfsPointer', () => {
  test.each<[string, { hunks: { patch: string }[] }, ReturnType<typeof lfsPointer>]>([
    ['added', file(`+${V}`, `+${oid('a')}`, '+size 82070'), { new: { oid: sha('a'), size: 82070 } }],
    ['removed', file(`-${V}`, `-${oid('a')}`, '-size 86536'), { old: { oid: sha('a'), size: 86536 } }],
    [
      'modified',
      file(` ${V}`, `-${oid('a')}`, `+${oid('b')}`, '-size 100', '+size 200'),
      { old: { oid: sha('a'), size: 100 }, new: { oid: sha('b'), size: 200 } },
    ],
    [
      'same size',
      file(` ${V}`, `-${oid('a')}`, `+${oid('b')}`, ' size 7'),
      { old: { oid: sha('a'), size: 7 }, new: { oid: sha('b'), size: 7 } },
    ],
    ['oid removed', file(` ${V}`, `-${oid('a')}`, ' size 7'), undefined],
    ['size missing on one side', file(` ${V}`, `-${oid('a')}`, `+${oid('b')}`, '-size 7'), undefined],
    ['no version line', file(`-${oid('a')}`, `+${oid('b')}`), undefined],
    ['other lines', file(`+${V}`, `+${oid('a')}`, '+size 1', '+hello'), undefined],
    ['source code', file('+const size = 1;'), undefined],
    ['no hunks', { hunks: [] }, undefined],
  ])('%s', (_, input, expected) => {
    expect(lfsPointer(input)).toEqual(expected);
  });
});
