/**
 * The trust boundary for model-drawn SVG. An allowlist, not a filter: the markup is parsed
 * into tags and text, any element outside the list rejects the whole picture, attributes
 * outside the list are dropped, and the picture is written back out from what survived.
 * The client also shows it only as an `<img>`, where no script or link can run.
 */
const ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'marker',
  'linearGradient',
  'stop',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'path',
  'text',
  'tspan',
  'title',
]);
const ATTRIBUTES = new Set([
  'xmlns',
  'viewBox',
  'preserveAspectRatio',
  'id',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'dx',
  'dy',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'd',
  'points',
  'transform',
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'font-size',
  'font-weight',
  'font-family',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'letter-spacing',
  'marker-start',
  'marker-end',
  'markerWidth',
  'markerHeight',
  'markerUnits',
  'refX',
  'refY',
  'orient',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientUnits',
]);
/** Long enough for a careful sketch, short enough to stay a sketch. */
export const SVG_CHAR_CAP = 16_000;

const SAFE_VALUE = /^[^<>"`\\]*$/;
const ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d{1,6}|#x[0-9a-f]{1,6});)/i;

export function sanitizeSvg(raw: string): string | { why: string } {
  const source = raw.replace(/^\s*```(?:svg|xml)?\s*\n?|\n?\s*```\s*$/g, '').trim();
  if (source.length > SVG_CHAR_CAP) {
    return { why: 'it is too large' };
  }
  if (/<[!?]/.test(source) || ENTITY.test(source)) {
    return { why: 'it has comments, a doctype or entities' };
  }
  const out: string[] = [];
  const open: string[] = [];
  let last = 0;
  for (const match of source.matchAll(/<(\/?)([A-Za-z][\w-]*)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g)) {
    const text = source.slice(last, match.index);
    if (
      text.includes('<') ||
      text.includes('>') ||
      (text.trim() && !['text', 'tspan', 'title'].includes(open.at(-1)!))
    ) {
      return { why: 'it has text or markup outside its elements' };
    }
    out.push(text);
    last = match.index + match[0].length;
    const [, closing, name, attributes, selfClosing] = match as unknown as [string, string, string, string, string];
    if (!ELEMENTS.has(name)) {
      return { why: `it uses <${name}>` };
    }
    if (closing) {
      if (open.pop() !== name) {
        return { why: 'its tags do not nest' };
      }
      out.push(`</${name}>`);
      continue;
    }
    if (!open.length && (name !== 'svg' || out.some((part) => part.trim()))) {
      return { why: 'it is not a single <svg>' };
    }
    const kept = [...attributes.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].flatMap(([, key, value]) => {
      const allowed =
        ATTRIBUTES.has(key!) &&
        SAFE_VALUE.test(value!) &&
        !/javascript:|data:/i.test(value!) &&
        [...value!.matchAll(/url\(([^)]*)\)/gi)].every(([, target]) => /^#[\w-]+$/.test(target!.trim()));
      return allowed ? [` ${key}="${value}"`] : [];
    });
    if (!open.length && !kept.some((attribute) => attribute.startsWith(' viewBox='))) {
      return { why: 'it has no viewBox' };
    }
    out.push(`<${name}${kept.join('')}${selfClosing ? '/' : ''}>`);
    if (!selfClosing) {
      open.push(name);
    }
  }
  if (open.length || source.slice(last).trim() || !out.length) {
    return { why: 'it is not a single complete <svg>' };
  }
  return out.join('').replace(/^<svg(?![^>]*\sxmlns=)/, '<svg xmlns="http://www.w3.org/2000/svg"');
}
