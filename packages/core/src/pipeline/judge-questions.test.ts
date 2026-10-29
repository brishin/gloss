import { describe, expect, it } from 'vitest';
import type { JudgeAnswer } from '../adapters/types.ts';
import { pickVisual, visualQuestions } from './judge-questions.ts';

const yes = (probability: number): JudgeAnswer => ({ type: 'bool', probability });

describe('pickVisual', () => {
  // Rows: per candidate [accurate, whole, easy, beyond_text = 0.9] -> the candidate shown.
  it.each([
    [
      'the one that shows the whole change',
      [
        [0.9, 0.4, 0.9],
        [0.9, 0.9, 0.9],
      ],
      1,
    ],
    [
      'a diagram over a list that sums up more',
      [
        [0.9, 0.9, 0.9, 0.1],
        [0.9, 0.6, 0.9, 0.9],
      ],
      1,
    ],
    [
      'the easier one to follow',
      [
        [0.9, 0.9, 0.2],
        [0.9, 0.9, 0.8],
      ],
      1,
    ],
    [
      'an accurate one over a better-looking wrong one',
      [
        [0.9, 0.5, 0.5],
        [0.1, 0.9, 0.9],
      ],
      0,
    ],
    [
      'none when no candidate is accurate',
      [
        [0.2, 0.9, 0.9],
        [0.25, 0.9, 0.9],
      ],
      undefined,
    ],
    [
      'the model order on a tie',
      [
        [0.9, 0.8, 0.8],
        [0.9, 0.8, 0.8],
      ],
      0,
    ],
  ] as const)('picks %s', (_, scores, expected) => {
    const answers = Object.fromEntries(
      scores.flatMap(([accurate, whole, easy, beyond = 0.9], i) => [
        [`c${i + 1}_accurate`, yes(accurate)],
        [`c${i + 1}_whole`, yes(whole)],
        [`c${i + 1}_easy`, yes(easy)],
        [`c${i + 1}_beyond_text`, yes(beyond)],
      ]),
    );
    expect(pickVisual(scores.length, answers)).toBe(expected);
  });

  it('ranks text-only answers without the picture question', () => {
    expect(Object.keys(visualQuestions(1, false))).toEqual(['c1_accurate', 'c1_beyond_text', 'c1_whole']);
    expect(
      pickVisual(2, { c1_accurate: yes(0.9), c1_whole: yes(0.3), c2_accurate: yes(0.9), c2_whole: yes(0.7) }),
    ).toBe(1);
  });

  it('names each picture as the image Jev is sent', () => {
    const questions = visualQuestions(2, true);
    expect(questions.c2_easy?.instructions).toContain('<image-2>');
    expect(JSON.stringify(visualQuestions(2, false))).not.toContain('<image-');
  });
});
