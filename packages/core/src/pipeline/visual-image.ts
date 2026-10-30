import { callLocations, callParents, type Visual } from '@gloss/protocol';
import { Resvg } from '@resvg/resvg-js';
import { renderMermaidSVG } from 'beautiful-mermaid';

/**
 * Pictures of candidate visuals for Jev to look at. They are drawn close to how the web
 * app draws them (same layout, light theme) but only Jev sees them, so plain SVG with
 * literal colors is enough: resvg understands neither CSS variables nor `color-mix`.
 */
const INK = { bg: '#ffffff', fg: '#1f2328', muted: '#59636e', line: '#d1d9e0', accent: '#5b4cc4' };
const TINT = '#cfc8f5';
const WASH = '#f3f1fd';
const BAD = '#cf222e';
const GOOD = '#1a7f37';
const CHANGED = '#bf8700';
const WIDTH = 760;
const MIN_SIDE = 400;
const MAX_SIDE = 1200;
const FONT = 'font-family="sans-serif"';

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Inline code loses its backticks, as in the web app. */
const plain = (text: string) => escape(text.replace(/`([^`]+)`/g, '$1'));

/** Cuts text to about `width` px of 12px sans with an ellipsis, as the web app's span does. */
export function fit(text: string, width: number): string {
  const flat = text.replace(/`([^`]+)`/g, '$1');
  const max = Math.floor(width / 6.2);
  return flat.length <= max ? flat : max < 2 ? '' : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Wider than this, two diagrams side by side shrink past reading, so they stack (as in the web app). */
const SIDE_BY_SIDE = 340;

/** The old and new diagrams side by side, or stacked when either is too wide to halve. */
function beforeAfterSvg(visual: Extract<Visual, { kind: 'before-after' }>): string {
  const svgs = [visual.before, visual.after].map(mermaidSvg);
  const stacked = svgs.some((svg) => new Resvg(svg).width > SIDE_BY_SIDE);
  const cell = stacked ? WIDTH : WIDTH / 2;
  const diagrams = svgs.map((svg, side) => {
    // Drawn to PNG first: resvg loads no fonts for an SVG nested as an image.
    const width = Math.round(Math.min(cell - 28, new Resvg(svg).width));
    const png = new Resvg(svg, { background: side ? WASH : INK.bg, fitTo: { mode: 'width', value: width } }).render();
    return { png: Buffer.from(png.asPng()).toString('base64'), width, height: png.height + 52 };
  });
  const [first, second] = diagrams as [(typeof diagrams)[number], (typeof diagrams)[number]];
  const height = stacked ? first.height + second.height : Math.max(first.height, second.height);
  const box = (x: number, y: number, h: number, label: string, diagram: typeof first, wash: boolean) =>
    (wash ? `<rect x="${x}" y="${y}" width="${cell}" height="${h}" fill="${WASH}"/>` : '') +
    `<text x="${x + 14}" y="${y + 26}" font-size="11" font-weight="600" fill="${INK.muted}" ${FONT}>${label}</text>` +
    `<image x="${x + (cell - diagram.width) / 2}" y="${y + 40}" width="${diagram.width}" height="${diagram.height - 52}" href="data:image/png;base64,${diagram.png}"/>`;
  return svg(
    height,
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" fill="${INK.bg}" stroke="${INK.line}"/>` +
      box(0, 0, stacked ? first.height : height, 'BEFORE', first, false) +
      (stacked
        ? box(0, first.height, second.height, 'AFTER', second, true) +
          `<line x1="0" x2="${WIDTH}" y1="${first.height}" y2="${first.height}" stroke="${INK.line}"/>`
        : box(cell, 0, height, 'AFTER', second, true) +
          `<line x1="${cell}" x2="${cell}" y1="0" y2="${height}" stroke="${INK.line}"/>`),
  );
}

function timelineSvg(visual: Extract<Visual, { kind: 'timeline' }>): string {
  const labelWidth = 110;
  const track = WIDTH - labelWidth - 28;
  const x = (at: number) => labelWidth + 14 + (at / 100) * track;
  const top = visual.markers.length ? 36 : 12;
  const laneHeight = 34;
  const height = top + visual.lanes.length * laneHeight + 10;
  const anchor = (at: number) => (at > 60 ? 'end' : 'start');
  const markers = visual.markers
    .map(
      (marker) =>
        `<text x="${x(marker.at)}" y="20" font-size="12" text-anchor="${anchor(marker.at)}" fill="${INK.muted}" ${FONT}>${plain(marker.text)}</text>` +
        `<line x1="${x(marker.at)}" x2="${x(marker.at)}" y1="26" y2="${height - 8}" stroke="${INK.line}"/>`,
    )
    .join('');
  const lanes = visual.lanes
    .map((lane, index) => {
      const y = top + index * laneHeight;
      const spans = lane.spans
        .map((span) => {
          const fill = span.tone === 'bad' ? '#ffd7d5' : span.tone === 'muted' ? '#eef1f4' : TINT;
          const color = span.tone === 'bad' ? BAD : span.tone === 'muted' ? INK.muted : INK.fg;
          return (
            `<rect x="${x(span.from)}" y="${y + 6}" width="${x(span.to) - x(span.from)}" height="20" rx="3" fill="${fill}"/>` +
            `<text x="${x(span.from) + 6}" y="${y + 20}" font-size="12" fill="${color}" ${FONT}>${escape(fit(span.text, x(span.to) - x(span.from) - 12))}</text>`
          );
        })
        .join('');
      const outcome = lane.outcome
        ? `<text x="${x(lane.outcome.at)}" y="${y + 20}" font-size="12" font-weight="600" text-anchor="${anchor(lane.outcome.at)}" fill="${lane.outcome.tone === 'good' ? GOOD : BAD}" ${FONT}>${plain(lane.outcome.text)}</text>`
        : '';
      return (
        `<text x="14" y="${y + 20}" font-size="11" font-weight="600" fill="${INK.muted}" ${FONT}>${plain(lane.label.toUpperCase())}</text>` +
        `<line x1="${labelWidth + 14}" x2="${WIDTH - 14}" y1="${y + 30}" y2="${y + 30}" stroke="${INK.line}" stroke-dasharray="3 3"/>` +
        spans +
        outcome
      );
    })
    .join('');
  return svg(
    height,
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" fill="${INK.bg}" stroke="${INK.line}"/>` +
      markers +
      lanes,
  );
}

const MONO = 'font-family="monospace"';
/** Call tree geometry, shared with the web app's `.visual-callstack`: px per row, per level, per character. */
const ROW = 28;
const INDENT = 22;
const CHAR = 7.8;
const MARK = 9;
const ROOT_GAP = 10;

/** The call tree: rows of receiver.name(args), connectors from each caller, file:line on the right. */
function callstackSvg(visual: Extract<Visual, { kind: 'callstack' }>): string {
  const { frames } = visual;
  const parents = callParents(frames);
  const locations = callLocations(frames);
  // Entry points after the first sit a little apart, as in the web app.
  let roots = 0;
  const tops = frames.map((frame, index) => 8 + index * ROW + ROOT_GAP * (index && !frame.depth ? ++roots : roots));
  const height = tops.at(-1)! + ROW + 8;
  const left = 14;
  const markX = (depth: number) => left + depth * INDENT;
  const midY = (index: number) => tops[index]! + ROW / 2;
  const rows = frames
    .map((frame, index) => {
      const y = midY(index);
      const x = markX(frame.depth);
      const mark =
        frame.status === 'same'
          ? `<rect x="${x + 0.5}" y="${y - MARK / 2 + 0.5}" width="${MARK - 1}" height="${MARK - 1}" rx="2" fill="none" stroke="${INK.muted}"/>`
          : `<rect x="${x}" y="${y - MARK / 2}" width="${MARK}" height="${MARK}" rx="2" fill="${frame.status === 'new' ? GOOD : CHANGED}"/>`;
      const location = locations[index]!;
      const room = WIDTH - 14 - location.length * CHAR - 16 - (x + MARK + 8);
      const receiver = frame.receiver ? `${frame.receiver}.` : '';
      const args = `(${frame.args ?? ''})`;
      const budget = Math.max(0, Math.floor(room / CHAR));
      const full = receiver + frame.name + args;
      const cut = full.length > budget ? `${full.slice(0, Math.max(0, budget - 1))}…` : full;
      // The cut text, split back into its dim receiver, bold name and dim arguments.
      const parts = [
        [cut.slice(0, receiver.length), INK.muted, ''],
        [cut.slice(receiver.length, receiver.length + frame.name.length), INK.fg, ' font-weight="600"'],
        [cut.slice(receiver.length + frame.name.length), INK.muted, ''],
      ]
        .filter(([text]) => text)
        .map(([text, fill, weight]) => `<tspan fill="${fill}"${weight}>${escape(text!)}</tspan>`)
        .join('');
      const file = location.startsWith(':') ? '' : location.replace(/:\d+$/, '');
      const at = location.slice(file.length);
      return (
        mark +
        `<text x="${x + MARK + 8}" y="${y + 4.5}" font-size="13" ${MONO} xml:space="preserve">${parts}</text>` +
        `<text x="${WIDTH - 14}" y="${y + 4.5}" font-size="13" text-anchor="end" ${MONO}><tspan fill="${INK.fg}">${escape(file)}</tspan><tspan fill="${INK.muted}">${escape(at)}</tspan></text>`
      );
    })
    .join('');
  const connectors = frames
    .map((frame, index) => {
      const parent = parents[index]!;
      if (parent < 0) {
        return '';
      }
      const x = markX(frames[parent]!.depth) + MARK / 2;
      const y = midY(index);
      return `<path d="M${x} ${midY(parent) + MARK / 2 + 2}V${y - 6}Q${x} ${y} ${x + 6} ${y}H${markX(frame.depth) - 3}" fill="none" stroke="${INK.line}" stroke-width="1.5"/>`;
    })
    .join('');
  return svg(
    height,
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" fill="${INK.bg}" stroke="${INK.line}"/>` +
      connectors +
      rows,
  );
}

const svg = (height: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">${body}</svg>`;

/** `#rrggbb` mixed like `color-mix(in srgb, a p%, b)`. */
function mix(a: string, percent: number, b: string): string {
  const channel = (hex: string, at: number) => Number.parseInt(hex.slice(1 + at * 2, 3 + at * 2), 16);
  const out = [0, 1, 2].map((at) =>
    Math.round((channel(a, at) * percent + channel(b, at) * (100 - percent)) / 100)
      .toString(16)
      .padStart(2, '0'),
  );
  return `#${out.join('')}`;
}

/**
 * beautiful-mermaid's SVG with its custom properties resolved to literal colors, its
 * web-font import removed and a generic font, so resvg draws it as a browser would.
 */
function mermaidSvg(source: string): string {
  const raw = renderMermaidSVG(source, { ...INK, surface: '#f6f8fa', border: '#d1d9e0' });
  const declarations = new Map<string, string>();
  for (const [, name, value] of raw.matchAll(/(--[\w-]+)\s*:\s*([^;}"]+)/g)) {
    declarations.set(name!, value!.trim());
  }
  // Innermost first: a `var()` or `color-mix()` with no parentheses left inside it.
  const resolve = (value: string): string => {
    let current = value;
    for (let pass = 0; pass < 16; pass++) {
      const next = current
        .replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g, (_, name: string, fallback?: string) =>
          declarations.has(name) ? resolve(declarations.get(name)!) : (fallback?.trim() ?? INK.fg),
        )
        .replace(
          /color-mix\(in srgb,\s*(#[0-9a-f]{6})\s+(\d+)%,\s*(#[0-9a-f]{6})\)/gi,
          (_, a: string, p: string, b: string) => mix(a, Number(p), b),
        );
      if (next === current) {
        break;
      }
      current = next;
    }
    return current;
  };
  return raw
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(
      /(fill|stroke|style)="([^"]*var\([^"]*)"/g,
      (_, attribute: string, value: string) => `${attribute}="${resolve(value)}"`,
    )
    .replace(/<text /g, `<text ${FONT} `);
}

/** A PNG of `visual`, or `undefined` when it cannot be drawn (Jev then judges it as text). */
export function visualPng(visual: Visual): Uint8Array | undefined {
  try {
    const source =
      visual.kind === 'before-after'
        ? beforeAfterSvg(visual)
        : visual.kind === 'timeline'
          ? timelineSvg(visual)
          : visual.kind === 'callstack'
            ? callstackSvg(visual)
            : visual.kind === 'svg'
              ? visual.svg.replace(/^<svg(?![^>]*\sfont-family=)/, `<svg ${FONT}`)
              : mermaidSvg(visual.source);
    const natural = new Resvg(source);
    // The web app never draws a diagram wider than its natural size.
    const width = visual.kind === 'mermaid' ? Math.min(WIDTH, natural.width) : WIDTH;
    const height = (natural.height * width) / natural.width;
    // Jev refuses a side outside about 280-1568 px: shrink tall pictures, pad small ones.
    const scale = Math.min(1, MAX_SIDE / height);
    const [w, h] = [Math.round(width * scale), Math.round(height * scale)];
    const picture = new Resvg(source, { background: INK.bg, fitTo: { mode: 'width', value: w } }).render().asPng();
    const [frameW, frameH] = [Math.max(w, MIN_SIDE), Math.max(h, MIN_SIDE)];
    const frame = `<svg xmlns="http://www.w3.org/2000/svg" width="${frameW}" height="${frameH}"><image x="${(frameW - w) / 2}" y="${(frameH - h) / 2}" width="${w}" height="${h}" href="data:image/png;base64,${Buffer.from(picture).toString('base64')}"/></svg>`;
    return new Resvg(frame, { background: INK.bg }).render().asPng();
  } catch {
    return undefined;
  }
}
