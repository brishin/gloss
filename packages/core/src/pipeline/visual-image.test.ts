import type { Visual } from '@gloss/protocol';
import { describe, expect, it } from 'vitest';
import { visualPng } from './visual-image.ts';

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
    // The tour's width, so Jev sees what the reader sees.
    expect(png && Buffer.from(png).readUInt32BE(16)).toBe(760);
  });
});
