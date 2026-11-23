/**
 * A line's row in a file's diff on the page. pierre renders into an open shadow root. In a
 * unified diff a removed row carries its old line number, so a new-side line never matches one.
 * `old` asks for a line by its old-side number instead: a removed row, or an unchanged row,
 * which carries its old number beside its new one.
 */
export function lineRow(fileId: string, line: number, old = false): HTMLElement | undefined {
  const hosts = document.getElementById(`file-${fileId}`)?.querySelectorAll('*') ?? [];
  const selector = old
    ? `[data-line="${line}"][data-line-type="change-deletion"], [data-alt-line="${line}"]:not([data-line-type^="change"])`
    : `[data-line="${line}"]:not([data-line-type="change-deletion"])`;
  for (const host of hosts) {
    const row = host.shadowRoot?.querySelector<HTMLElement>(selector);
    if (row) {
      return row;
    }
  }
  return undefined;
}

/** Where a note's lines are on the page: an element the note column keeps over them (`NoteLane.tsx`). */
export const noteAnchor = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-note-anchor="${CSS.escape(id)}"]`);
