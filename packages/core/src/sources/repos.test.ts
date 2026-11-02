import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { makeLfsCache, RepoError } from './repos.ts';

const bytes = (n: number) => new Uint8Array(n);

describe('LFS cache', () => {
  it.effect('shares one download between requests for an oid', () =>
    Effect.gen(function* () {
      const get = yield* makeLfsCache(100);
      let downloads = 0;
      const download = Effect.sync(() => {
        downloads++;
        return bytes(1);
      });
      yield* Effect.all([get('a', download), get('a', download)], { concurrency: 'unbounded' });
      yield* get('a', download);
      expect(downloads).toBe(1);
    }),
  );

  it.effect('does not keep a failed download', () =>
    Effect.gen(function* () {
      const get = yield* makeLfsCache(100);
      const failed = yield* get('a', Effect.fail(new RepoError({ message: 'offline' }))).pipe(Effect.flip);
      expect(failed.message).toBe('offline');
      expect((yield* get('a', Effect.succeed(bytes(1)))).length).toBe(1);
    }),
  );

  it.effect('evicts the least recently used objects over the budget, whatever order downloads finish in', () =>
    Effect.gen(function* () {
      const get = yield* makeLfsCache(10);
      const first = yield* Deferred.make<Uint8Array>();
      const second = yield* Deferred.make<Uint8Array>();
      const a = yield* Effect.forkChild(get('a', Deferred.await(first)));
      const b = yield* Effect.forkChild(get('b', Deferred.await(second)));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(second, bytes(6));
      yield* Fiber.join(b);
      yield* Deferred.succeed(first, bytes(6));
      yield* Fiber.join(a);
      let downloads = 0;
      const again = Effect.sync(() => {
        downloads++;
        return bytes(6);
      });
      yield* get('a', again);
      expect(downloads).toBe(0);
      yield* get('b', again);
      expect(downloads).toBe(1);
    }),
  );
});
