import type { DiffMeta, FileChange, SourceRef } from '@gloss/protocol';

export interface FetchedDiff {
  meta: DiffMeta;
  files: FileChange[];
}

/** Where a diff comes from. Implementations run on the backend (they shell out to git/gh). */
export interface DiffSource {
  readonly ref: SourceRef;
  /** Cheap staleness probe: the head sha, or a hash of the diff for a working tree. */
  fingerprint(signal?: AbortSignal): Promise<string>;
  fetch(signal?: AbortSignal): Promise<FetchedDiff>;
}
