import { describe, expect, it } from 'vitest';
import type { JudgeAnswer } from '../adapters/types.ts';
import { pickVisual, visualQuestions } from './judge-questions.ts';

const best = (probabilities: Record<string, number>): JudgeAnswer => ({
  type: 'choice',
  choice: Object.entries(probabilities).toSorted((a, b) => b[1] - a[1])[0]![0],
  confidence: 0,
  probabilities,
});
const explains = (probability: number): JudgeAnswer => ({ type: 'bool', probability });

describe('pickVisual', () => {
  // Rows: Jev's ranking and per-candidate "explains" -> the candidate shown.
  it.each([
    ['the top-ranked one that explains', { c1: 0.2, c2: 0.8 }, [0.9, 0.9], 1],
    ['the next one when the top one misleads', { c1: 0.2, c2: 0.8 }, [0.9, 0.1], 0],
    ['none when no candidate explains', { c1: 0.5, c2: 0.5 }, [0.4, 0.2], undefined],
    ['the model order on a tie', { c1: 0.5, c2: 0.5 }, [0.9, 0.9], 0],
  ] as const)('picks %s', (_, ranking, explained, expected) => {
    const answers = {
      best: best(ranking),
      ...Object.fromEntries(explained.map((p, i) => [`c${i + 1}_explains`, explains(p)])),
    };
    expect(pickVisual(explained.length, answers)).toBe(expected);
  });

  it('filters a single candidate without ranking it', () => {
    expect(Object.keys(visualQuestions(1, true))).toEqual(['c1_explains']);
    expect(pickVisual(1, { c1_explains: explains(0.7) })).toBe(0);
    expect(pickVisual(1, { c1_explains: explains(0.3) })).toBe(undefined);
  });

  it('names each picture as the image Jev is sent', () => {
    const questions = visualQuestions(2, true);
    expect(questions.c2_explains?.instructions).toContain('<image-2>');
    expect(JSON.stringify(visualQuestions(2, false))).not.toContain('<image-');
  });
});
