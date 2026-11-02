import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { makeLfsCache, RepoError } from './repos.ts';

const temp = Effect.promise(() => mkdtemp(join(tmpdir(), 'gloss-lfs-test-')));

describe('LFS cache', () => {
  it.effect('shares one download between requests, and saves it for the next', () =>
    Effect.gen(function* () {
      const dir = yield* temp;
      const get = yield* makeLfsCache(dir);
      let downloads = 0;
      const download = Effect.sync(() => {
        downloads++;
        return new Uint8Array([1, 2, 3]);
      });
      yield* Effect.all([get('a', download), get('a', download)], { concurrency: 'unbounded' });
      expect(downloads).toBe(1);
      expect([...(yield* Effect.promise(() => readFile(join(dir, 'a'))))]).toEqual([1, 2, 3]);
      // A new service (a restarted server) reads it from disk.
      const again = yield* makeLfsCache(dir);
      expect([...(yield* again('a', download))]).toEqual([1, 2, 3]);
      expect(downloads).toBe(1);
    }),
  );

  it.effect('does not save a failed download', () =>
    Effect.gen(function* () {
      const get = yield* makeLfsCache(yield* temp);
      const failed = yield* get('a', Effect.fail(new RepoError({ message: 'offline' }))).pipe(Effect.flip);
      expect(failed.message).toBe('offline');
      expect([...(yield* get('a', Effect.succeed(new Uint8Array([7]))))]).toEqual([7]);
    }),
  );
});
