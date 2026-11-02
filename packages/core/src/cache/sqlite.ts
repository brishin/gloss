import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type RecentTour, type SourceRef, type Stack, serializeRef } from '@gloss/protocol';
import { type CacheStore, stackMemberKeys, withStack } from './store.ts';

/** How long a write waits on another gloss process holding the lock before failing with SQLITE_BUSY. */
const BUSY_TIMEOUT_MS = 10_000;

/** One sqlite file (WAL) holds every cache kind: many small per-file rows write atomically and prune cheaply. */
export function createSqliteCacheStore(path: string): CacheStore {
  mkdirSync(dirname(path), { recursive: true });
  // Several gloss processes share one cache file. The timeout is set at open so it also covers the WAL switch below.
  const db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS entries (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      model TEXT,
      created_at INTEGER NOT NULL,
      bytes INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS entries_created ON entries (created_at);
    CREATE TABLE IF NOT EXISTS recent (
      source_key TEXT PRIMARY KEY,
      ref TEXT NOT NULL,
      title TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recent_stack (
      ref_key TEXT PRIMARY KEY,
      stack TEXT NOT NULL
    );
  `);
  // Files from before PR authors were kept get the column added; their rows have no author.
  // Another gloss process may add it between the check and the ALTER, so that error is fine.
  const recentColumns = db.prepare('PRAGMA table_info(recent)').all() as { name: string }[];
  if (!recentColumns.some((column) => column.name === 'author')) {
    try {
      db.exec('ALTER TABLE recent ADD COLUMN author TEXT');
    } catch (error) {
      if (!String(error).includes('duplicate column name')) {
        throw error;
      }
    }
  }
  const getStmt = db.prepare('SELECT value FROM entries WHERE key = ?');
  const putStmt = db.prepare(
    'INSERT OR REPLACE INTO entries (key, kind, value, model, created_at, bytes) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const recentPut = db.prepare(
    'INSERT OR REPLACE INTO recent (source_key, ref, title, author, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  const recentList = db.prepare('SELECT ref, title, author, updated_at FROM recent ORDER BY updated_at DESC LIMIT ?');
  const stackPut = db.prepare('INSERT OR REPLACE INTO recent_stack (ref_key, stack) VALUES (?, ?)');
  const stackGet = db.prepare('SELECT stack FROM recent_stack WHERE ref_key = ?');
  const pruneStmt = db.prepare('DELETE FROM entries WHERE created_at < ?');

  return {
    get<T>(key: string) {
      const row = getStmt.get(key) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as T) : undefined;
    },
    put(key, kind, value, model) {
      const json = JSON.stringify(value);
      putStmt.run(key, kind, json, model ?? null, Date.now(), json.length);
    },
    recordRecent(ref: SourceRef, sourceKey: string, title: string, author?: string) {
      recentPut.run(sourceKey, JSON.stringify(ref), title, author ?? null, Date.now());
    },
    recordStack(stack: Stack) {
      const json = JSON.stringify(stack);
      for (const key of stackMemberKeys(stack)) {
        stackPut.run(key, json);
      }
    },
    listRecent(limit = 20): RecentTour[] {
      const rows = recentList.all(limit) as { ref: string; title: string; author: string | null; updated_at: number }[];
      return rows.map((row) => {
        const ref = JSON.parse(row.ref) as SourceRef;
        const stack = stackGet.get(serializeRef(ref)) as { stack: string } | undefined;
        return withStack(
          {
            ref,
            title: row.title,
            ...(row.author ? { author: row.author } : {}),
            updatedAt: new Date(row.updated_at).toISOString(),
          },
          stack && (JSON.parse(stack.stack) as Stack),
        );
      });
    },
    prune(olderThanMs) {
      return Number(pruneStmt.run(Date.now() - olderThanMs).changes);
    },
    close() {
      db.close();
    },
  };
}
