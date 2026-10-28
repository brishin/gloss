import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RecentTour, SourceRef } from '@gloss/protocol';
import type { CacheStore } from './store.ts';

/** One sqlite file (WAL) holds every cache kind: many small per-file rows write atomically and prune cheaply. */
export function createSqliteCacheStore(path: string): CacheStore {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
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
  `);
  const getStmt = db.prepare('SELECT value FROM entries WHERE key = ?');
  const putStmt = db.prepare(
    'INSERT OR REPLACE INTO entries (key, kind, value, model, created_at, bytes) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const recentPut = db.prepare(
    'INSERT OR REPLACE INTO recent (source_key, ref, title, updated_at) VALUES (?, ?, ?, ?)',
  );
  const recentList = db.prepare('SELECT ref, title, updated_at FROM recent ORDER BY updated_at DESC LIMIT ?');
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
    recordRecent(ref: SourceRef, sourceKey: string, title: string) {
      recentPut.run(sourceKey, JSON.stringify(ref), title, Date.now());
    },
    listRecent(limit = 20): RecentTour[] {
      return (recentList.all(limit) as { ref: string; title: string; updated_at: number }[]).map((row) => ({
        ref: JSON.parse(row.ref) as SourceRef,
        title: row.title,
        updatedAt: new Date(row.updated_at).toISOString(),
      }));
    },
    prune(olderThanMs) {
      return Number(pruneStmt.run(Date.now() - olderThanMs).changes);
    },
    close() {
      db.close();
    },
  };
}
