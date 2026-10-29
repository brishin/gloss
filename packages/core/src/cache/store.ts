import type { RecentTour, SourceRef } from '@gloss/protocol';
import { Context, Effect, Layer } from 'effect';
import { createSqliteCacheStore } from './sqlite.ts';

export type CacheKind =
  | 'diff'
  | 'define'
  | 'judge-file'
  | 'judge-group'
  | 'judge-visual'
  | 'sketch'
  | 'followup'
  | 'notes'
  | 'tour';

/**
 * Content-addressed storage. Keys come from `cache/keys.ts`; values are JSON.
 * Only fetched diffs and model/Jev output are stored, never heuristics or errors.
 */
export interface CacheStore {
  get<T>(key: string): T | undefined;
  put(key: string, kind: CacheKind, value: unknown, model?: string): void;
  recordRecent(ref: SourceRef, sourceKey: string, title: string): void;
  listRecent(limit?: number): RecentTour[];
  /** Deletes entries older than `olderThanMs`; returns how many were removed. */
  prune(olderThanMs: number): number;
  close(): void;
}

export function createMemoryCacheStore(): CacheStore {
  const entries = new Map<string, { value: string; createdAt: number }>();
  const recent = new Map<string, RecentTour>();
  return {
    get: <T>(key: string) => {
      const entry = entries.get(key);
      return entry ? (JSON.parse(entry.value) as T) : undefined;
    },
    put: (key, _kind, value) => {
      entries.set(key, { value: JSON.stringify(value), createdAt: Date.now() });
    },
    recordRecent: (ref, sourceKey, title) => {
      recent.delete(sourceKey);
      recent.set(sourceKey, { ref, title, updatedAt: new Date().toISOString() });
    },
    listRecent: (limit = 20) => [...recent.values()].toReversed().slice(0, limit),
    prune: (olderThanMs) => {
      let removed = 0;
      for (const [key, entry] of entries) {
        if (Date.now() - entry.createdAt > olderThanMs) {
          entries.delete(key);
          removed++;
        }
      }
      return removed;
    },
    close: () => {},
  };
}

/** The cache as a service. Its methods stay synchronous: `node:sqlite` is, and so is the memory store. */
export class TourCache extends Context.Service<TourCache, CacheStore>()('@gloss/core/TourCache') {
  static readonly memory = Layer.sync(TourCache, createMemoryCacheStore);

  /** One sqlite file, closed when the layer's scope closes. */
  static sqlite(path: string) {
    return Layer.effect(
      TourCache,
      Effect.acquireRelease(
        Effect.sync(() => createSqliteCacheStore(path)),
        (store) => Effect.sync(() => store.close()),
      ),
    );
  }
}
