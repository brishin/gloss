import type { DiffPayload } from '@gloss/protocol';
import { findInDiff, proseSymbol, symbolUnder } from './symbol-click.ts';

/**
 * Experiment: what shows that names can be clicked, drawn outside React because pierre owns the
 * diff's DOM (a shadow root per diff):
 * - the name under the pointer in a diff is underlined, with a pointer cursor;
 * - code names in the tour's prose that the diff shows are marked `data-symbol`, which
 *   styles.css underlines on hover and `symbolClick` opens.
 * The name in a diff is painted with the CSS Custom Highlight API, so no diff node is changed.
 */

const SHEET = `
  ::highlight(sym-hover) {
    text-decoration: underline;
    text-decoration-color: color-mix(in oklch, currentColor 60%, transparent);
    text-underline-offset: 3px;
  }
`;

/** Prose the tour wrote. Diffs, the card, code blocks and controls are not prose. */
const PROSE_CODE = '.app main code';
const NOT_PROSE = 'pre, a, button, .sym-peek, .sym-code';

type Highlights = Map<string, unknown> & { set(name: string, value: unknown): unknown };
declare const Highlight: new (...ranges: Range[]) => unknown;

/** Installs the cues under `app` and returns what removes them. `getDiff` is read on every pass. */
export function installSymbolMarks(app: HTMLElement, getDiff: () => DiffPayload | undefined): () => void {
  const highlights = (CSS as unknown as { highlights?: Highlights }).highlights;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(SHEET);

  // The name under the pointer.
  let hovered: HTMLElement | undefined;
  const clearHover = () => {
    highlights?.delete('sym-hover');
    hovered?.style.removeProperty('cursor');
    hovered = undefined;
  };
  const onMove = (event: MouseEvent) => {
    // Read now: an event's composed path is gone once it has been dispatched.
    const found = event.buttons === 0 ? symbolUnder(event) : undefined;
    if (!found) {
      if (hovered) {
        clearHover();
      }
      return;
    }
    clearHover();
    if (highlights && typeof Highlight !== 'undefined') {
      if (!found.root.adoptedStyleSheets.includes(sheet)) {
        found.root.adoptedStyleSheets = [...found.root.adoptedStyleSheets, sheet];
      }
      highlights.set('sym-hover', new Highlight(found.range));
    }
    hovered = found.range.startContainer.parentElement ?? undefined;
    hovered?.style.setProperty('cursor', 'pointer');
  };

  // The code names in the prose that the diff shows.
  let timer = 0;
  const mark = () => {
    const diff = getDiff();
    for (const code of app.querySelectorAll<HTMLElement>(PROSE_CODE)) {
      if (code.closest(NOT_PROSE)) {
        continue;
      }
      const name = proseSymbol(code.textContent ?? '');
      const shown = name && diff && findInDiff(diff, name, code.closest<HTMLElement>('[data-file-id]')?.dataset.fileId);
      if (name && shown) {
        if (code.dataset.symbol !== name) {
          code.dataset.symbol = name;
        }
      } else if (code.dataset.symbol) {
        delete code.dataset.symbol;
      }
    }
  };
  // The prose arrives as the page renders; attributes are not watched, so marking does not loop.
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = window.setTimeout(mark, 150);
  });
  observer.observe(app, { childList: true, subtree: true });
  document.addEventListener('mousemove', onMove, { passive: true });
  timer = window.setTimeout(mark, 150);

  return () => {
    observer.disconnect();
    document.removeEventListener('mousemove', onMove);
    clearTimeout(timer);
    clearHover();
  };
}
