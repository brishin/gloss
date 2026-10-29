import type { Visual } from '@gloss/protocol';
import { describe, expect, it } from 'vitest';
import { visualPng, wrap } from './visual-image.ts';

const visuals: Visual[] = [
  { kind: 'before-after', caption: 'c', before: ['`a` row'], after: ['b row'] },
  {
    kind: 'timeline',
    markers: [{ at: 40, text: 'killed' }],
    lanes: [
      { label: 'Before', spans: [{ from: 0, to: 40, text: 'idle' }], outcome: { at: 40, text: 'lost', tone: 'bad' } },
    ],
  },
  { kind: 'mermaid', source: 'flowchart TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]' },
];

describe('visualPng', () => {
  it.each(visuals.map((visual) => [visual.kind, visual] as const))('draws a %s as a PNG for Jev', (_, visual) => {
    const png = visualPng(visual);
    expect(png && Buffer.from(png).subarray(0, 4).toString('hex')).toBe('89504e47');
    // Every side inside what Jev accepts (about 280-1568 px).
    for (const side of [Buffer.from(png!).readUInt32BE(16), Buffer.from(png!).readUInt32BE(20)]) {
      expect(side).toBeGreaterThanOrEqual(400);
      expect(side).toBeLessThanOrEqual(1200);
    }
  });
});

it('shrinks a tall flowchart to a height Jev accepts', () => {
  const steps = Array.from({ length: 25 }, (_, i) => `  S${i}[Step ${i}] --> S${i + 1}[Step ${i + 1}]`).join('\n');
  const png = Buffer.from(visualPng({ kind: 'mermaid', source: `flowchart TD\n${steps}` })!);
  expect(png.readUInt32BE(20)).toBe(1200);
  expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(400);
});

it('wraps a long before-after row inside its column instead of running into the next', () => {
  const row = 'The save now runs when the app is backgrounded instead of on an idle timer that never fires';
  const lines = wrap(row, 50);
  expect(lines.length).toBe(2);
  expect(lines.every((line) => line.length <= 50)).toBe(true);
  expect(lines.join(' ')).toBe(row);
});
