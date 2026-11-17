import type { DiffPayload } from '@gloss/protocol';
import { findInDiff, proseSymbol, symbolUnder } from './symbol-click.ts';

/**
 * Experiment: what shows that names can be clicked. Three cues, all drawn outside React because
 * pierre owns the diff's DOM (a shadow root per diff):
 * - the name under the pointer in a diff is underlined, with a pointer cursor;
 * - names the tour's prose mentions carry a dotted underline wherever a diff shows them;
 * - those code names in the prose itself are marked `data-symbol`, which styles.css underlines.
 * Names in diffs are painted with the CSS Custom Highlight API, so no diff node is changed.
 */

const SHEET = `
  ::highlight(sym-hover) { text-decoration: underline; text-underline-offset: 3px; }
  ::highlight(sym-known) {
    text-decoration: underline dotted;
    text-decoration-color: light-dark(oklch(45% 0.02 285 / 0.32), oklch(85% 0.02 285 / 0.32));
    text-underline-offset: 3px;
  }
`;

/** Prose the tour wrote: its code names are the ones worth marking. Diffs, the card and code blocks are not prose. */
const PROSE_CODE = '.app main code';
const NOT_PROSE = 'pre, a, button, .sym-peek, .sym-code';

type Highlights = Map<string, unknown> & { set(name: string, value: unknown): unknown };
declare const Highlight: new (...ranges: Range[]) => unknown;

function shadowRoots(root: ParentNode): ShadowRoot[] {
  return [...root.querySelectorAll('diffs-container')].flatMap((host) => (host.shadowRoot ? [host.shadowRoot] : []));
}

/** Installs the cues under `app` and returns what removes them. `getDiff` is read on every pass. */
export function installSymbolMarks(app: HTMLElement, getDiff: () => DiffPayload | undefined): () => void {
  const highlights = (CSS as unknown as { highlights?: Highlights }).highlights;
  if (!highlights || typeof Highlight === 'undefined') {
    return () => {};
  }
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(SHEET);
  const adopt = (root: ShadowRoot) => {
    if (!root.adoptedStyleSheets.includes(sheet)) {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    }
  };

  // The name under the pointer.
  let hovered: HTMLElement | undefined;
  const clearHover = () => {
    highlights.delete('sym-hover');
    hovered?.style.removeProperty('cursor');
    hovered = undefined;
  };
  const onMove = (event: MouseEvent) => {
    // Read now: an event's composed path is gone once it has been dispatched.
    const found = event.buttons === 0 ? symbolUnder(event) : undefined;
    const at = found?.range.startContainer.parentElement ?? undefined;
    if (!found) {
      if (hovered) {
        clearHover();
      }
      return;
    }
    clearHover();
    adopt(found.root);
    highlights.set('sym-hover', new Highlight(found.range));
    hovered = at;
    hovered?.style.setProperty('cursor', 'pointer');
  };

  // The names the prose mentions, in the prose and in the diffs.
  let timer = 0;
  const mark = () => {
    const diff = getDiff();
    const names = new Set<string>();
    for (const code of app.querySelectorAll<HTMLElement>(PROSE_CODE)) {
      if (code.closest(NOT_PROSE)) {
        continue;
      }
      const name = proseSymbol(code.textContent ?? '');
      const shown = name && diff && findInDiff(diff, name, code.closest<HTMLElement>('[data-file-id]')?.dataset.fileId);
      if (name && shown) {
        // A plain word (`source`) would be marked all over the code: only names that read as code are.
        if (/[_$]|[a-z][A-Z]|^[A-Z]/.test(name)) {
          names.add(name);
        }
        if (code.dataset.symbol !== name) {
          code.dataset.symbol = name;
        }
      } else if (code.dataset.symbol) {
        delete code.dataset.symbol;
      }
    }
    const ranges: Range[] = [];
    if (names.size) {
      const word = new RegExp(
        `(?<![\\w$])(?:${[...names].map((name) => name.replace(/\$/g, '\\$')).join('|')})(?![\\w$])`,
        'g',
      );
      for (const root of shadowRoots(app)) {
        adopt(root);
        for (const row of root.querySelectorAll('[data-line]:not([data-line-type="change-deletion"])')) {
          const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            for (const match of (node.textContent ?? '').matchAll(word)) {
              const range = document.createRange();
              range.setStart(node, match.index);
              range.setEnd(node, match.index + match[0].length);
              ranges.push(range);
            }
          }
        }
      }
    }
    if (ranges.length) {
      highlights.set('sym-known', new Highlight(...ranges));
    } else {
      highlights.delete('sym-known');
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(mark, 150);
  };
  // Diffs render late and in their own shadow roots: watch the page, and each root as it appears.
  const watched = new WeakSet<ShadowRoot>();
  const watch = () => {
    for (const root of shadowRoots(app)) {
      if (!watched.has(root)) {
        watched.add(root);
        observer.observe(root, { childList: true, subtree: true });
      }
    }
    schedule();
  };
  const observer = new MutationObserver(watch);
  observer.observe(app, { childList: true, subtree: true });
  document.addEventListener('mousemove', onMove, { passive: true });
  watch();

  return () => {
    observer.disconnect();
    document.removeEventListener('mousemove', onMove);
    clearTimeout(timer);
    clearHover();
    highlights.delete('sym-known');
  };
}
