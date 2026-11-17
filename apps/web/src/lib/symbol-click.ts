import type { DiffPayload } from '@gloss/protocol';
import type { SymbolClick } from './symbol-model.ts';

const WORD = /[A-Za-z_$][\w$]*/g;

/** Words of the languages gloss reads most that are never a symbol to look up. */
const KEYWORDS = new Set(
  `and as assert async await break case catch class const continue def default del do elif else enum except export
  extends false finally for from func function global if implements import in interface is lambda let new nil none
  nonlocal not null of or pass private protected public raise return self static struct super switch this throw true
  try type typeof undefined var void while with yield`.split(/\s+/),
);

/** A name worth a card: an identifier of three characters or more that is not a keyword. */
export const isSymbol = (word: string): boolean =>
  /^[A-Za-z_$][\w$]{2,}$/.test(word) && !KEYWORDS.has(word.toLowerCase());

/** The identifier at `offset` in `text`, with where it starts. */
export function wordAt(text: string, offset: number): { word: string; start: number } | undefined {
  for (const match of text.matchAll(WORD)) {
    if (match.index <= offset && offset <= match.index + match[0].length) {
      return { word: match[0], start: match.index };
    }
  }
  return undefined;
}

/** The name a piece of inline code in prose stands for: `self._x`, `Foo.bar()` and `bar` all give their last name. */
export function proseSymbol(text: string): string | undefined {
  const match = /^[\w$.]*?([A-Za-z_$][\w$]*)(\(\))?$/.exec(text.trim());
  return match && isSymbol(match[1]!) ? match[1] : undefined;
}

/** Where a name first appears on the new side of the diff, in `prefer` (a file id) when it is there. */
export function findInDiff(
  diff: DiffPayload,
  name: string,
  prefer?: string,
): { fileId: string; line: number } | undefined {
  const word = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
  const files = [...diff.files].sort((a, b) => Number(b.id === prefer) - Number(a.id === prefer));
  for (const file of files) {
    for (const hunk of file.hunks) {
      let line = hunk.newStart;
      for (const row of hunk.patch.split('\n')) {
        if (row.startsWith('-')) {
          continue;
        }
        if (word.test(row.slice(1))) {
          return { fileId: file.id, line };
        }
        line++;
      }
    }
  }
  return undefined;
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (
    x: number,
    y: number,
    options?: { shadowRoots: ShadowRoot[] },
  ) => { offsetNode: Node; offset: number } | null;
};

/** Where the card goes for a name drawn at `rect`: under it, kept inside the window. */
function under(rect: DOMRect): { left: number; top: number } {
  return {
    left: Math.max(12, Math.min(rect.left - 14, window.innerWidth - 540 - 24)) + window.scrollX,
    top: rect.bottom + window.scrollY + 8,
  };
}

/**
 * The name under the pointer in a diff: its text range, its file and its new-side line. Pierre
 * draws each diff in a shadow root, so the event's composed path is read. Undefined on a removed
 * line, outside a diff, or on no name.
 */
export function symbolUnder(
  event: MouseEvent,
): { symbol: string; fileId: string; line: number; range: Range; root: ShadowRoot } | undefined {
  const path = event.composedPath().filter((node): node is HTMLElement => node instanceof HTMLElement);
  const row = path.find((node) => node.hasAttribute('data-line'));
  const file = path.find((node) => node.hasAttribute('data-file-id'));
  const root = path[0]?.getRootNode();
  if (!row || !file || !(root instanceof ShadowRoot) || row.getAttribute('data-line-type') === 'change-deletion') {
    return undefined;
  }
  const line = Number(row.getAttribute('data-line'));
  let caret: { offsetNode: Node; offset: number } | null | undefined;
  try {
    caret = (document as CaretDocument).caretPositionFromPoint?.(event.clientX, event.clientY, {
      shadowRoots: [root],
    });
  } catch {
    return undefined;
  }
  const node = caret?.offsetNode;
  if (!Number.isFinite(line) || !caret || !node || node.nodeType !== Node.TEXT_NODE || !row.contains(node)) {
    return undefined;
  }
  const found = wordAt(node.textContent ?? '', caret.offset);
  if (!found || !isSymbol(found.word)) {
    return undefined;
  }
  const range = document.createRange();
  range.setStart(node, found.start);
  range.setEnd(node, found.start + found.word.length);
  // The caret snaps to the nearest text, so a click in the empty part of a line is not on the name.
  const rect = range.getBoundingClientRect();
  if (event.clientX < rect.left - 1 || event.clientX > rect.right + 1) {
    return undefined;
  }
  return { symbol: found.word, fileId: file.dataset.fileId!, line, range, root };
}

/**
 * What a click asks a card for: a name in a diff, or a code name in the tour's prose that the
 * diff shows (marked `data-symbol` by `symbol-marks.ts`). Undefined for any other click.
 */
export function symbolClick(event: MouseEvent, diff: DiffPayload | undefined): SymbolClick | undefined {
  const inDiff = symbolUnder(event);
  if (inDiff) {
    return {
      fileId: inDiff.fileId,
      line: inDiff.line,
      symbol: inDiff.symbol,
      ...under(inDiff.range.getBoundingClientRect()),
    };
  }
  const code = (event.target as HTMLElement).closest?.<HTMLElement>('code[data-symbol]');
  const name = code?.dataset.symbol;
  if (!code || !name || !diff) {
    return undefined;
  }
  const at = findInDiff(diff, name, code.closest<HTMLElement>('[data-file-id]')?.dataset.fileId);
  return at ? { ...at, symbol: name, ...under(code.getBoundingClientRect()) } : undefined;
}
