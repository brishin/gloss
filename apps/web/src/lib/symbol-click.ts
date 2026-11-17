import type { SymbolClick } from './symbol-model.ts';

const WORD = /[A-Za-z_$][\w$]*/g;

/** The identifier at `offset` in `text`, with where it starts. */
export function wordAt(text: string, offset: number): { word: string; start: number } | undefined {
  for (const match of text.matchAll(WORD)) {
    if (match.index <= offset && offset <= match.index + match[0].length) {
      return { word: match[0], start: match.index };
    }
  }
  return undefined;
}

/**
 * What a cmd-click in a diff points at: the identifier under the pointer, its file and its
 * new-side line. Pierre draws each diff in a shadow root, so the click's composed path is read.
 * Undefined for a removed line, a click outside a diff, or a click on no identifier.
 */
export function symbolClick(event: MouseEvent): SymbolClick | undefined {
  const path = event.composedPath().filter((node): node is HTMLElement => node instanceof HTMLElement);
  const row = path.find((node) => node.hasAttribute('data-line'));
  const file = path.find((node) => node.hasAttribute('data-file-id'));
  const root = path[0]?.getRootNode();
  if (!row || !file || !(root instanceof ShadowRoot) || row.getAttribute('data-line-type') === 'change-deletion') {
    return undefined;
  }
  const line = Number(row.getAttribute('data-line'));
  // Chrome and Safari: the caret under the pointer, inside the diff's shadow root.
  const caret = (
    document as Document & {
      caretPositionFromPoint?: (
        x: number,
        y: number,
        options?: { shadowRoots: ShadowRoot[] },
      ) => { offsetNode: Node; offset: number } | null;
    }
  ).caretPositionFromPoint?.(event.clientX, event.clientY, { shadowRoots: [root] });
  const node = caret?.offsetNode;
  if (!Number.isFinite(line) || !node || node.nodeType !== Node.TEXT_NODE || !row.contains(node)) {
    return undefined;
  }
  const text = node.textContent ?? '';
  const found = wordAt(text, caret.offset);
  if (!found) {
    return undefined;
  }
  const range = document.createRange();
  range.setStart(node, found.start);
  range.setEnd(node, found.start + found.word.length);
  const rect = range.getBoundingClientRect();
  return {
    fileId: file.dataset.fileId!,
    line,
    symbol: found.word,
    left: Math.max(12, Math.min(rect.left - 14, window.innerWidth - 540 - 24)) + window.scrollX,
    top: rect.bottom + window.scrollY + 8,
  };
}
