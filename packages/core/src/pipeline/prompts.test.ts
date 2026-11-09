import { describe, expect, it } from 'vitest';
import { quotedGaps } from './prompts.ts';

describe('quotedGaps', () => {
  const meta = {
    title: 'Admin tools: bulk email',
    description: 'Adds a **bulk send** to the\n  admin Comms page.\n\nOnly staff see it.',
    baseRef: 'a',
    headRef: 'b',
    commits: [{ sha: 's', subject: 'Keep the “old composer” for now' }],
  };

  it('keeps gaps that quote the title, description or commits, loosely', () => {
    const gaps = [
      { quote: 'bulk send to the admin Comms page', text: 'a' },
      { quote: '"Only staff see it."', text: 'b' },
      { quote: 'keep the "old composer"', text: 'c' },
      { quote: 'admin only, behind a flag', text: 'd' },
      { quote: '', text: 'e' },
    ];
    expect(quotedGaps(meta, gaps).map((gap) => gap.text)).toEqual(['a', 'b', 'c']);
  });
});
