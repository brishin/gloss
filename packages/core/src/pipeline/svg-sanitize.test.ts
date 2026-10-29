import { describe, expect, it } from 'vitest';
import { sanitizeSvg } from './svg-sanitize.ts';

const wrap = (body: string) => `<svg viewBox="0 0 100 40">${body}</svg>`;

describe('sanitizeSvg', () => {
  it('keeps shapes, text and in-document markers, and adds the namespace', () => {
    const svg = wrap(
      '<defs><marker id="a" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#59636e"/></marker></defs>' +
        '<rect x="1" y="1" width="40" height="20" rx="3" fill="#cfc8f5"/><line x1="41" y1="11" x2="60" y2="11" stroke="#59636e" marker-end="url(#a)"/>' +
        '<text x="4" y="14" font-size="12">Old &amp; new</text>',
    );
    expect(sanitizeSvg(svg)).toBe(svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '));
  });

  it('drops attributes outside the list: handlers, styles, links and external urls', () => {
    expect(
      sanitizeSvg(
        wrap('<rect onclick="alert(1)" style="fill:red" href="https://x" fill="url(https://x/y)" width="4"/>'),
      ),
    ).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><rect width="4"/></svg>');
  });

  it('keeps a bare > in a label, escaped', () => {
    expect(sanitizeSvg(wrap('<text x="4" y="14">a -> b</text>'))).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><text x="4" y="14">a -&gt; b</text></svg>',
    );
  });

  // Each is rejected whole rather than repaired.
  it.each([
    ['a script', wrap('<script>alert(1)</script>')],
    ['a foreignObject', wrap('<foreignObject><div>x</div></foreignObject>')],
    ['a link', wrap('<a href="https://x"><text>x</text></a>')],
    ['an image', wrap('<image href="https://x/y.png"/>')],
    ['a style element', wrap('<style>rect{fill:red}</style>')],
    ['a comment', wrap('<!-- x -->')],
    ['a doctype', `<!DOCTYPE svg>${wrap('')}`],
    ['an entity', wrap('<text>&xxe;</text>')],
    ['single-quoted attributes', wrap("<rect width='4'/>")],
    ['stray text', wrap('hello')],
    ['two roots', `${wrap('')}${wrap('')}`],
    ['no viewBox', '<svg><rect/></svg>'],
    ['an unclosed tag', '<svg viewBox="0 0 1 1"><g>'],
  ])('rejects %s', (_, svg) => {
    expect(typeof sanitizeSvg(svg)).toBe('object');
  });
});
