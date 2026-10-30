import type { TraceStep } from '@gloss/protocol';
import { describe, expect, it } from 'vitest';
import { layoutGraph, NODE, promptLines, selectedStep, stepFacts } from './trace-view.ts';

const step = (id: string, kind: TraceStep['kind'], inputs: string[], extra: Partial<TraceStep> = {}): TraceStep => ({
  id,
  kind,
  inputs,
  state: 'done',
  startMs: 0,
  endMs: 10,
  ...extra,
});

const steps = [
  step('fetch', 'fetch', []),
  step('define', 'define', ['fetch']),
  step('judge-files', 'judge-files', ['fetch']),
  step('place', 'place', ['judge-files', 'define']),
  ...['a', 'b', 'c', 'd'].map((key) => step(`notes:${key}`, 'notes', ['place', 'define'])),
];

describe('layoutGraph', () => {
  it('puts each step a layer below its deepest input and wraps wide layers', () => {
    const { nodes } = layoutGraph(steps, 420);
    const rowOf = (id: string) => nodes.find((node) => node.step.id === id)!.y / (NODE.height + NODE.gapY);
    expect(['fetch', 'define', 'judge-files', 'place'].map(rowOf)).toEqual([0, 1, 1, 2]);
    // Four notes calls at three per row take two rows.
    expect(['notes:a', 'notes:c', 'notes:d'].map(rowOf)).toEqual([3, 3, 4]);
  });

  it('survives an input that is missing or loops back', () => {
    const { nodes } = layoutGraph([step('x', 'place', ['y', 'gone']), step('y', 'define', ['x'])], 420);
    expect(nodes).toHaveLength(2);
  });
});

describe('selectedStep', () => {
  it('opens on the asked-for step, else the first notes call', () => {
    expect(selectedStep(steps, 'define')?.id).toBe('define');
    expect(selectedStep(steps, 'missing')?.id).toBe('notes:a');
    expect(selectedStep(steps.slice(0, 2), undefined)?.id).toBe('define');
  });
});

describe('promptLines', () => {
  it('marks each line with its source step and tags the first line of a section', () => {
    const notes = step('notes:a', 'notes', ['place', 'define', 'judge-files'], {
      prompt: '# Title\n## This group: A\nsummary\n## Flagged risks\n(none)\n## Rules\nbe brief',
      sections: [
        { line: 0, from: 'fetch' },
        { line: 1, from: 'define' },
        { line: 3, from: 'judge-files' },
        { line: 5, from: 'notes:a' },
      ],
    });
    expect(promptLines(notes, steps).map(({ from, tag }) => [from, tag])).toEqual([
      ['fetch', 'Diff'],
      ['define', 'Define'],
      ['define', undefined],
      ['judge-files', 'Jev'],
      ['judge-files', undefined],
      // The step's own instructions carry no source.
      [undefined, undefined],
      [undefined, undefined],
    ]);
  });
});

describe('stepFacts', () => {
  it('lists the model, time, tokens and freshness that are known', () => {
    const call = step('define', 'define', [], {
      model: 'anthropic/claude',
      endMs: 4800,
      usage: { input: 3100, output: 600 },
      cached: false,
    });
    expect(stepFacts(call)).toBe('anthropic/claude · 4.8 s · 3.1k in / 600 out · fresh');
    expect(stepFacts(step('place', 'place', []))).toBe('10 ms');
  });
});
