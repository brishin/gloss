import type { FileSummary, GroupView, RiskKey, RiskNote } from '@gloss/protocol';
import { useCallback, useEffect, useState } from 'react';

/** Sidebar/selection key of the tour overview (never a group key: those come from the model or are synthetic). */
export const OVERVIEW = '__overview';

/** Matches `--sticky-h` in styles.css (top bar + sub-bar): content scrolled under it is hidden. */
export const STICKY_OFFSET = 72;

export const RISK_SHORT: Record<RiskKey, string> = {
  authCheck: 'auth',
  storedData: 'stored data',
  secretsSigning: 'secrets',
  personalData: 'personal data',
};

/** Confirmed risk notes per file in a group. */
export function risksByFile(group: GroupView | undefined): Map<string, RiskNote[]> {
  const byFile = new Map<string, RiskNote[]>();
  for (const note of group?.notes?.riskNotes ?? []) {
    byFile.set(note.fileId, [...(byFile.get(note.fileId) ?? []), note]);
  }
  return byFile;
}

/** Files with a confirmed risk first, so the riskiest code is the first thing a reviewer reads. */
export function orderedFileIds(group: GroupView | undefined): string[] {
  if (!group) {
    return [];
  }
  const risky = risksByFile(group);
  return [...group.fileIds.filter((id) => risky.has(id)), ...group.fileIds.filter((id) => !risky.has(id))];
}

export function notedFileIds(group: GroupView | undefined): Set<string> {
  const notes = group?.notes;
  return new Set([...(notes?.fileNotes ?? []), ...(notes?.lineNotes ?? [])].map((note) => note.fileId));
}

export function isGeneratedFile(group: GroupView | undefined, file: FileSummary): boolean {
  return group?.key === 'generated' || file.generated === 'gitattributes';
}

/** Generated, binary, oversized and already-viewed files start collapsed. */
export function defaultExpanded(file: FileSummary, generated: boolean, viewed: boolean): boolean {
  return !(viewed || generated || file.isBinary || file.truncated || file.additions + file.deletions > 800);
}

export function splitPath(path: string): { dir: string; base: string } {
  const at = path.lastIndexOf('/');
  return at === -1 ? { dir: '', base: path } : { dir: path.slice(0, at + 1), base: path.slice(at + 1) };
}

/** Files the reviewer marked viewed, per diff, kept in this browser only. */
export function useViewed(diffId: string | undefined) {
  const key = diffId ? `gloss.viewed.${diffId}` : undefined;
  const [viewed, setViewed] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!key) {
      return;
    }
    try {
      setViewed(new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]));
    } catch {
      setViewed(new Set());
    }
  }, [key]);

  const toggle = useCallback(
    (fileId: string) => {
      setViewed((previous) => {
        const next = new Set(previous);
        if (!next.delete(fileId)) {
          next.add(fileId);
        }
        if (key) {
          try {
            localStorage.setItem(key, JSON.stringify([...next]));
          } catch {
            // Storage unavailable (private window): viewed state lasts for this page only.
          }
        }
        return next;
      });
    },
    [key],
  );

  return { viewed, toggle };
}
