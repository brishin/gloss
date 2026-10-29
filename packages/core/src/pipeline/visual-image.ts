import type { Visual } from '@gloss/protocol';
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
const WIDTH = 760;
const FONT = 'font-family="sans-serif"';

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Inline code loses its backticks, as in the web app. */
const plain = (text: string) => escape(text.replace(/`([^`]+)`/g, '$1'));

function beforeAfterSvg(visual: Extract<Visual, { kind: 'before-after' }>): string {
  const rowHeight = 22;
  const height = 44 + Math.max(visual.before.length, visual.after.length) * rowHeight + 12;
  const column = (x: number, label: string, rows: readonly string[]) =>
    `<text x="${x + 14}" y="26" font-size="11" font-weight="600" fill="${INK.muted}" ${FONT}>${label}</text>` +
    rows
      .map(
        (row, index) =>
          `<text x="${x + 14}" y="${52 + index * rowHeight}" font-size="13" fill="${INK.fg}" ${FONT}>${plain(row)}</text>`,
      )
      .join('');
  const half = WIDTH / 2;
  return svg(
    height,
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" fill="${INK.bg}" stroke="${INK.line}"/>` +
      `<rect x="${half}" y="1" width="${half - 1.5}" height="${height - 2}" fill="${WASH}"/>` +
      `<line x1="${half}" x2="${half}" y1="0" y2="${height}" stroke="${INK.line}"/>` +
      column(0, 'BEFORE', visual.before) +
      column(half, 'AFTER', visual.after),
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
            `<text x="${x(span.from) + 6}" y="${y + 20}" font-size="12" fill="${color}" ${FONT}>${plain(span.text)}</text>`
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
          : mermaidSvg(visual.source);
    return new Resvg(source, { background: INK.bg, fitTo: { mode: 'width', value: WIDTH } }).render().asPng();
  } catch {
    return undefined;
  }
}
