import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { createFakeJudgeClient } from '../adapters/fake.ts';
import { type JudgeAnswer, JudgeClient, JudgeError } from '../adapters/types.ts';
import { createMemoryCacheStore, TourCache } from '../cache/store.ts';
import {
  BUILT_IN_DECISION_RULES,
  checkDecisionRules,
  ruleFindings,
  ruleQuestions,
  ruleState,
} from './decision-rules.ts';

const rules = ['Flag every new environment variable', 'Flag new env vars', 'Never flag config keys'];
const bool = (probability: number): JudgeAnswer => ({ type: 'bool', probability });
const closest = (choice: string): JudgeAnswer => ({ type: 'choice', choice, probabilities: {}, confidence: 0.9 });

describe('rule questions', () => {
  it('asks about each later rule only, so every pair is asked once', () => {
    const pairs = (index: number) =>
      Object.keys(ruleQuestions(index, rules)).filter((id) => /^(overlaps|contradicts)_/.test(id));
    expect(pairs(0)).toEqual(['overlaps_r2', 'contradicts_r2', 'overlaps_r3', 'contradicts_r3']);
    expect(pairs(2)).toEqual([]);
    expect(Object.keys(ruleState(1, rules).other_rules as object)).toEqual(['r3']);
  });
});

describe('rule findings', () => {
  it.each([
    ['nothing below the threshold', { covered: bool(0.6), vague: bool(0.2) }, []],
    [
      'a repeat of a built-in rule, named',
      { covered: bool(0.9), closest: closest('one_way_doors') },
      [{ rule: 0, kind: 'overlap', builtIn: BUILT_IN_DECISION_RULES.one_way_doors }],
    ],
    [
      'a conflict wins over a repeat of the same built-in rule',
      { covered: bool(0.9), contradicts: bool(0.8), closest: closest('skip_style') },
      [{ rule: 0, kind: 'contradiction', builtIn: BUILT_IN_DECISION_RULES.skip_style }],
    ],
    [
      'pairs with later rules, and vagueness',
      { overlaps_r2: bool(0.9), contradicts_r3: bool(0.75), overlaps_r3: bool(0.9), vague: bool(0.8) },
      [
        { rule: 0, kind: 'overlap', other: 1 },
        { rule: 0, kind: 'contradiction', other: 2 },
        { rule: 0, kind: 'vague' },
      ],
    ],
  ])('%s', (_, answers, expected) => {
    expect(ruleFindings(0, rules, answers as Record<string, JudgeAnswer>)).toEqual(expected);
  });
});

describe('checkDecisionRules', () => {
  const run = (judge?: JudgeClient['Service'], cache = createMemoryCacheStore()) =>
    Effect.runPromise(
      checkDecisionRules(rules).pipe(
        Effect.provide(
          Layer.mergeAll(Layer.succeed(TourCache, cache), judge ? Layer.succeed(JudgeClient, judge) : Layer.empty),
        ),
      ),
    );

  it('reports the rules unchecked without Jev', async () => {
    expect(await run()).toEqual({ findings: [], checked: false });
  });

  it('asks Jev once per rule and caches the answers', async () => {
    const judge = createFakeJudgeClient((state, id) =>
      id === 'overlaps_r2' && state.rule === rules[0] ? bool(0.95) : id === 'closest' ? closest('choices') : bool(0.1),
    );
    const cache = createMemoryCacheStore();
    expect(await run(judge, cache)).toEqual({ findings: [{ rule: 0, kind: 'overlap', other: 1 }], checked: true });
    expect(judge.calls).toBe(3);
    await run(judge, cache);
    expect(judge.calls).toBe(3);
  });

  it('reports the rules unchecked when Jev fails', async () => {
    const judge: JudgeClient['Service'] = {
      model: 'fake/jev',
      judge: () => Effect.fail(new JudgeError({ message: 'down' })),
    };
    expect(await run(judge)).toEqual({ findings: [], checked: false });
  });
});
