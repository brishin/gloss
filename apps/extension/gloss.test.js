import { describe, expect, it } from 'vitest';
import { findServer, tourPath } from './gloss.js';

describe('tourPath', () => {
  it.each([
    ['https://github.com/o/r/pull/12', '/gh/o/r/pull/12'],
    ['https://github.com/o/r/pull/12/files', '/gh/o/r/pull/12'],
    ['https://github.com/o/r/pull/12#discussion_r1', '/gh/o/r/pull/12'],
    ['https://github.com/o/r/pull/12?w=1', '/gh/o/r/pull/12'],
    ['https://github.com/o/r/pull/12abc', undefined],
    ['https://github.com/o/r/pulls', undefined],
    ['https://github.com/o/r/issues/12', undefined],
    ['https://gitlab.com/o/r/pull/12', undefined],
    [undefined, undefined],
  ])('%s → %s', (url, path) => {
    expect(tourPath(url)).toBe(path);
  });
});

describe('findServer', () => {
  const health = { version: '0', pipelineVersion: '1' };
  const fake = (ports) => async (url) => {
    const port = Number(new URL(url).port);
    if (!(port in ports)) throw new TypeError('connection refused');
    return Response.json(ports[port]);
  };

  it('prefers the lowest port that answers as gloss', async () => {
    expect(await findServer(fake({ 4777: { other: true }, 4779: health, 4781: health }))).toBe('http://127.0.0.1:4779');
  });

  it('is undefined when nothing answers', async () => {
    expect(await findServer(fake({}))).toBeUndefined();
  });
});
