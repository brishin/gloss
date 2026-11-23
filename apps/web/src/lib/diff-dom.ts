/**
 * A line's row in a file's diff on the page. pierre renders into an open shadow root; in a
 * unified diff a removed row carries its old line number, so a new-side line never matches one
 * (`deleted` asks for the removed row instead).
 */
export function lineRow(fileId: string, line: number, deleted = false): HTMLElement | undefined {
  const hosts = document.getElementById(`file-${fileId}`)?.querySelectorAll('*') ?? [];
  const kind = deleted ? '[data-line-type="change-deletion"]' : ':not([data-line-type="change-deletion"])';
  for (const host of hosts) {
    const row = host.shadowRoot?.querySelector<HTMLElement>(`[data-line="${line}"]${kind}`);
    if (row) {
      return row;
    }
  }
  return undefined;
}

/** Where a note's lines are on the page: an element the note column keeps over them (`NoteLane.tsx`). */
export const noteAnchor = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-note-anchor="${CSS.escape(id)}"]`);
