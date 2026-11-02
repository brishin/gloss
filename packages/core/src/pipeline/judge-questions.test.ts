import { describe, expect, it } from 'vitest';
import type { JudgeAnswer } from '../adapters/types.ts';
import { pickVisuals, visualQuestions } from './judge-questions.ts';

const yes = (probability: number): JudgeAnswer => ({ type: 'bool', probability });

const pickVisual = (...args: Parameters<typeof pickVisuals>) => pickVisuals(...args)[0];

describe('pickVisuals', () => {
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
    expect(pickVisual(Array(scores.length).fill('mermaid'), answers)).toBe(expected);
  });

  // Candidates: a sketch rated lower than a flowchart, as in the evals.
  const sketchAndFlow = (workflow: number, sketchAccurate = 0.9) => ({
    workflow: yes(workflow),
    c1_accurate: yes(sketchAccurate),
    c1_whole: yes(0.6),
    c1_easy: yes(0.6),
    c2_accurate: yes(0.9),
    c2_whole: yes(0.9),
    c2_easy: yes(0.9),
  });
  it.each([
    ['the sketch when the change is no workflow', sketchAndFlow(0.1), 0],
    ['the sketch when Jev is unsure it is a workflow', sketchAndFlow(0.88), 0],
    ['the higher-rated flowchart for a workflow', sketchAndFlow(0.95), 1],
    ['the flowchart when the sketch is wrong', sketchAndFlow(0.1, 0.1), 1],
  ] as const)('shows %s', (_, answers, expected) => {
    expect(pickVisual(['svg', 'mermaid'], answers)).toBe(expected);
  });

  it('ranks text-only answers without the picture question', () => {
    expect(Object.keys(visualQuestions(1, false))).toEqual(['workflow', 'c1_accurate', 'c1_beyond_text', 'c1_whole']);
    expect(
      pickVisual(['mermaid', 'mermaid'], {
        c1_accurate: yes(0.9),
        c1_whole: yes(0.3),
        c2_accurate: yes(0.9),
        c2_whole: yes(0.7),
      }),
    ).toBe(1);
  });

  // Two pictures only when both are strong and differ in kind; one stays the norm.
  const strong = (i: number, score = 0.9) =>
    Object.fromEntries(['accurate', 'beyond_text', 'whole', 'easy'].map((q) => [`c${i}_${q}`, yes(score)]));
  it.each([
    ['a strong sketch and a strong flowchart', ['svg', 'mermaid'], { ...strong(1), ...strong(2) }, [0, 1]],
    [
      'the flowchart first for a workflow',
      ['svg', 'mermaid'],
      { workflow: yes(0.95), ...strong(1), ...strong(2, 0.95) },
      [1, 0],
    ],
    ['one when the second is only fair', ['svg', 'mermaid'], { ...strong(1), ...strong(2, 0.7) }, [0]],
    ['one when the first is only fair', ['svg', 'mermaid'], { ...strong(1, 0.7), ...strong(2) }, [0]],
    ['one of two strong flowcharts', ['mermaid', 'mermaid'], { ...strong(1), ...strong(2) }, [0]],
    [
      'the best two of three kinds',
      ['svg', 'mermaid', 'timeline'],
      { ...strong(1), ...strong(2, 0.85), ...strong(3) },
      [0, 2],
    ],
  ] as const)('shows %s', (_, kinds, answers, expected) => {
    expect(pickVisuals(kinds, answers)).toEqual(expected);
  });

  it('names each picture as the image Jev is sent', () => {
    const questions = visualQuestions(2, true);
    expect(questions.c2_easy?.instructions).toContain('<image-2>');
    expect(JSON.stringify(visualQuestions(2, false))).not.toContain('<image-');
  });
});
