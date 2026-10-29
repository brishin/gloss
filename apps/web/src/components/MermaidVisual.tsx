import { renderMermaidSVG } from 'beautiful-mermaid';
import { useMemo } from 'react';

/** gloss's own tokens (and a tight margin), so the diagram follows the theme without re-rendering. */
const COLORS = {
  bg: 'var(--color-background-body)',
  fg: 'var(--color-text-primary)',
  muted: 'var(--color-text-secondary)',
  line: 'var(--color-border-emphasized)',
  border: 'var(--color-border-emphasized)',
  surface: 'var(--color-background-surface)',
  accent: 'var(--gloss-ink)',
  transparent: true,
  padding: 8,
};

/**
 * Renders a flowchart or state diagram the normalizer accepted. beautiful-mermaid
 * escapes labels; its stylesheet is scoped here and its web-font import removed, so it
 * neither restyles other SVGs on the page nor fetches anything.
 */
export default function MermaidVisual({ source }: { source: string }) {
  const svg = useMemo(() => mermaidSvg(source), [source]);
  return svg ? <Diagram svg={svg} /> : null;
}

/** The SVG markup and its natural width, or `undefined` when the source does not render. */
export function mermaidSvg(source: string): { html: string; width: number } | undefined {
  try {
    const raw = renderMermaidSVG(source, COLORS);
    return {
      width: Number(/ width="([\d.]+)"/.exec(raw)?.[1] ?? 0),
      html: raw
        .replace(/@import url\([^)]*\);?/g, '')
        .replace(/(^|\n)\s*text \{[^}]*\}/, '$1.visual-mermaid text { font-family: var(--font-family-body); }')
        .replace(/(^|\n)(\s*)svg \{/, '$1$2.visual-mermaid svg {')
        .replace(/ width="([\d.]+)" height="[\d.]+" style="/, ' style="max-width: min(100%, $1px);'),
    };
  } catch {
    return undefined;
  }
}

export function Diagram({ svg }: { svg: { html: string } }) {
  return <div className="visual-mermaid" dangerouslySetInnerHTML={{ __html: svg.html }} />;
}
