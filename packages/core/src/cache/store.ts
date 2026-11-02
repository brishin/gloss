import { type RecentTour, type SourceRef, type Stack, serializeRef } from '@gloss/protocol';
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
  | 'tour'
  | 'trace';

/**
 * Content-addressed storage. Keys come from `cache/keys.ts`; values are JSON.
 * Only fetched diffs and model/Jev output are stored (a finished tour's trace is its prompts and
 * those outputs), never heuristics or errors.
 */
export interface CacheStore {
  get<T>(key: string): T | undefined;
  put(key: string, kind: CacheKind, value: unknown, model?: string): void;
  recordRecent(ref: SourceRef, sourceKey: string, title: string, author?: string): void;
  /**
   * Remembers the stack a PR was last seen in, for each of its members, so the recent list can
   * show stacks without walking them again. Not a cache: it never answers a stack request.
   */
  recordStack(stack: Stack): void;
  /** Fills in authors (keyed by `serializeRef`) for recent PRs recorded without one. */
  recordAuthors(authors: ReadonlyMap<string, string>): void;
  /** Recent tours, newest first, each PR with its author and last-seen stack. */
  listRecent(limit?: number): RecentTour[];
  /** Deletes entries older than `olderThanMs`; returns how many were removed. */
  prune(olderThanMs: number): number;
  close(): void;
}

export function createMemoryCacheStore(): CacheStore {
  const entries = new Map<string, { value: string; createdAt: number }>();
  const recent = new Map<string, RecentTour>();
  const stacks = new Map<string, Stack>();
  return {
    get: <T>(key: string) => {
      const entry = entries.get(key);
      return entry ? (JSON.parse(entry.value) as T) : undefined;
    },
    put: (key, _kind, value) => {
      entries.set(key, { value: JSON.stringify(value), createdAt: Date.now() });
    },
    recordRecent: (ref, sourceKey, title, author) => {
      recent.delete(sourceKey);
      recent.set(sourceKey, { ref, title, ...(author ? { author } : {}), updatedAt: new Date().toISOString() });
    },
    recordStack: (stack) => {
      for (const key of stackMemberKeys(stack)) {
        stacks.set(key, stack);
      }
    },
    recordAuthors: (authors) => {
      for (const [sourceKey, tour] of recent) {
        const author = authors.get(serializeRef(tour.ref));
        if (author && !tour.author) {
          recent.set(sourceKey, { ...tour, author });
        }
      }
    },
    listRecent: (limit = 20) =>
      [...recent.values()]
        .toReversed()
        .slice(0, limit)
        .map((tour) => withStack(tour, stacks.get(serializeRef(tour.ref)))),
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

/** The `serializeRef` key of each PR in a stack. */
export function stackMemberKeys(stack: Stack): string[] {
  return stack.members.map((member) =>
    serializeRef({ kind: 'github-pr', owner: stack.owner, repo: stack.repo, number: member.number }),
  );
}

export function withStack(tour: RecentTour, stack: Stack | undefined): RecentTour {
  return stack ? { ...tour, stack } : tour;
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
