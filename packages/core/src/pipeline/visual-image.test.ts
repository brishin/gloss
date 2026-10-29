import type { Visual } from '@gloss/protocol';
import { describe, expect, it } from 'vitest';
import { fit, visualPng } from './visual-image.ts';

const visuals: Visual[] = [
  {
    kind: 'before-after',
    caption: 'c',
    before: 'flowchart TD\n  A[Idle timer] --> B[Save]',
    after: 'flowchart TD\n  A[Backgrounded] --> B[Save]',
  },
  {
    kind: 'timeline',
    markers: [{ at: 40, text: 'killed' }],
    lanes: [
      { label: 'Before', spans: [{ from: 0, to: 40, text: 'idle' }], outcome: { at: 40, text: 'lost', tone: 'bad' } },
    ],
  },
  {
    kind: 'svg',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 200"><rect x="20" y="20" width="200" height="60" fill="#cfc8f5"/><text x="30" y="55" font-size="14">Old path</text></svg>',
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

it('cuts a timeline label to its span with an ellipsis', () => {
  expect(fit('idle timer', 200)).toBe('idle timer');
  expect(fit('a long label that cannot fit', 62)).toBe('a long la…');
  expect(fit('anything', 8)).toBe('');
});
