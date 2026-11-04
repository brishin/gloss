import {
  type DecisionRuleSet,
  type EditRulesTurn,
  RULE_MAX,
  type RuleFinding,
  type RuleRef,
  type RuleRow,
  RULES_MAX,
} from '@gloss/protocol';
import { Effect, Option } from 'effect';
import * as v from 'valibot';
import { JudgeClient, type JudgeAnswer, type JudgeQuestion, ModelClient } from '../adapters/types.ts';
import { TourCache } from '../cache/store.ts';
import { hashOf } from '../hash.ts';
import { YES } from './judge-questions.ts';

/**
 * The built-in decision rules, in short: what the define and notes prompts (`prompts.ts`)
 * already ask the model to flag or skip. Jev checks a user's rules against these, so keep
 * them in step with the prompts; their text is part of the check's cache key.
 */
export const BUILT_IN_DECISION_RULES: Record<string, string> = {
  choices:
    'Flag a choice a reasonable engineer could have made differently and a reviewer should agree with on purpose: an approach, a default, a data shape, a check or an ordering.',
  omissions: 'Flag something left out: a missing check, limit, cache, backoff or failure report.',
  one_way_doors:
    'Flag one-way doors: a schema migration, stored data deleted or rewritten, a public API, wire format, file format, config key or event name, a published package version, or an irreversible side effect such as sending messages or charging money.',
  migrations:
    'Flag every SQL migration file once; urgent when it drops or rewrites data or cannot be rolled back, else high.',
  change_wide: 'Flag product behavior, scope, rollout and tradeoffs that span several files, once for the change.',
  risks: 'Write a risk in a choice the change makes as a decision, not a note.',
  priority: 'Rate a decision by the consequence if it is wrong, and the lower of two priorities when unsure.',
  skip_style: 'Do not flag styling, layout, naming, refactors, dependency versions or unchanged behavior.',
  skip_tests: 'Do not flag a decision on a test, fixture or story file.',
  skip_description: 'Do not flag what only describes what the code does, or a caveat such as an untested path.',
};

const ruleId = (index: number) => `r${index + 1}`;

/**
 * Jev's questions about rule `index`: is it covered by or at odds with a built-in rule, is it
 * clear, and does it repeat or conflict with each later rule (each pair is asked once).
 */
export function ruleQuestions(index: number, rules: readonly string[]): Record<string, JudgeQuestion> {
  const questions: Record<string, JudgeQuestion> = {
    covered: {
      type: 'bool',
      instructions: 'Do `built_in_rules` already flag the decisions that `rule` asks to flag?',
      criteria: {
        true: '`rule` restates a built-in rule, or asks for a narrower case of one, so it adds nothing.',
        false: '`rule` asks for decisions that the built-in rules would not flag on their own.',
      },
    },
    contradicts: {
      type: 'bool',
      instructions:
        'Does `rule` conflict with `built_in_rules`: it asks to flag what a built-in rule says not to flag, asks not to flag what one says to flag, or asks for a different priority for the same kind of decision?',
    },
    closest: {
      type: 'choice',
      instructions: 'Which built-in rule is closest to `rule`?',
      criteria: BUILT_IN_DECISION_RULES,
    },
    vague: {
      type: 'bool',
      instructions: 'Is `rule` too vague for a reviewer to tell whether a given code choice falls under it?',
      criteria: {
        true: 'It names no kind of code, behavior or choice, e.g. "flag important things" or "be careful".',
        false: 'It names a kind of code, behavior or choice, even a broad one.',
      },
    },
  };
  for (let other = index + 1; other < rules.length; other++) {
    const id = ruleId(other);
    questions[`overlaps_${id}`] = {
      type: 'bool',
      instructions: `Do \`rule\` and \`other_rules.${id}\` ask to flag mostly the same decisions?`,
    };
    questions[`contradicts_${id}`] = {
      type: 'bool',
      instructions: `Does \`rule\` conflict with \`other_rules.${id}\`: one asks to flag what the other asks not to flag, or they ask for different priorities for the same kind of decision?`,
    };
  }
  return questions;
}

export function ruleState(index: number, rules: readonly string[]): Record<string, unknown> {
  return {
    rule: rules[index],
    built_in_rules: BUILT_IN_DECISION_RULES,
    other_rules: Object.fromEntries(
      rules.flatMap((rule, other) => (other > index ? [[ruleId(other), rule] as const] : [])),
    ),
  };
}

const yes = (answer: JudgeAnswer | undefined) => answer?.type === 'bool' && answer.probability >= YES;

/** A finding about flat rule `index`; `rule` and `other` are flat indexes until `checkDecisionRules` maps them. */
export interface FlatFinding {
  rule: number;
  kind: RuleFinding['kind'];
  builtIn?: string;
  other?: number;
}

/** Findings for rule `index` from Jev's answers; a pair finding is reported on the earlier rule. */
export function ruleFindings(
  index: number,
  rules: readonly string[],
  answers: Record<string, JudgeAnswer>,
): FlatFinding[] {
  const closest = answers.closest?.type === 'choice' ? BUILT_IN_DECISION_RULES[answers.closest.choice] : undefined;
  const builtIn = closest ? { builtIn: closest } : {};
  const findings: FlatFinding[] = [];
  // A conflict matters more than a repeat; one built-in finding per rule.
  if (yes(answers.contradicts)) {
    findings.push({ rule: index, kind: 'contradiction', ...builtIn });
  } else if (yes(answers.covered)) {
    findings.push({ rule: index, kind: 'overlap', ...builtIn });
  }
  for (let other = index + 1; other < rules.length; other++) {
    const id = ruleId(other);
    if (yes(answers[`contradicts_${id}`])) {
      findings.push({ rule: index, kind: 'contradiction', other });
    } else if (yes(answers[`overlaps_${id}`])) {
      findings.push({ rule: index, kind: 'overlap', other });
    }
  }
  if (yes(answers.vague)) {
    findings.push({ rule: index, kind: 'vague' });
  }
  return findings;
}

/** Every rule as Jev reads it, with its scope, and where it sits in the sets. */
export function flattenRules(sets: readonly DecisionRuleSet[]): { ref: RuleRef; text: string }[] {
  return sets.flatMap((set, setIndex) =>
    set.rules.map((rule, ruleIndex) => ({
      ref: { set: setIndex, rule: ruleIndex },
      text: set.files ? `${rule} (only in files whose path matches the glob ${set.files})` : rule,
    })),
  );
}

/**
 * Jev checks each rule against the built-in rules and the rules after it, one call per
 * rule. A rule reads with its files pattern, so rules for different files need not clash.
 * Answers are cached by the exact request. Without Jev, or when a call fails, the rules are
 * reported unchecked: the check only advises, it never blocks a save.
 */
export const checkDecisionRules = Effect.fnUntraced(function* (sets: readonly DecisionRuleSet[]) {
  const judge = Option.getOrUndefined(yield* Effect.serviceOption(JudgeClient));
  const flat = flattenRules(sets);
  if (!judge || flat.length === 0) {
    return { findings: [] as RuleFinding[], checked: !!judge };
  }
  const rules = flat.map((rule) => rule.text);
  const cache = yield* TourCache;
  const answered = yield* Effect.forEach(
    rules,
    (_, index) =>
      Effect.suspend(() => {
        const state = ruleState(index, rules);
        const questions = ruleQuestions(index, rules);
        const key = hashOf({ kind: 'judge-rules', model: judge.model, state, questions });
        const hit = cache.get<Record<string, JudgeAnswer>>(key);
        if (hit) {
          return Effect.succeed(hit);
        }
        return judge
          .judge({ state, questions })
          .pipe(Effect.tap((answers) => Effect.sync(() => cache.put(key, 'judge-rules', answers, judge.model))));
      }).pipe(Effect.map((answers) => ruleFindings(index, rules, answers))),
    { concurrency: 8 },
  ).pipe(Effect.option);
  return Option.match(answered, {
    onNone: () => ({ findings: [] as RuleFinding[], checked: false }),
    onSome: (found) => ({
      findings: found.flat().map(({ rule, other, ...finding }): RuleFinding => ({
        ...flat[rule]!.ref,
        ...finding,
        ...(other === undefined ? {} : { other: flat[other]!.ref }),
      })),
      checked: true,
    }),
  });
});

const RuleRowsResultSchema = v.object({
  rules: v.pipe(
    v.array(
      v.object({
        text: v.pipe(
          v.string(),
          v.description(
            'One rule: an imperative sentence naming which decisions to flag, e.g. "Flag every new environment variable".',
          ),
        ),
        files: v.pipe(
          v.string(),
          v.description(
            'A gitignore-style glob tested against each changed file\'s path, e.g. "*.py" (any depth), "apps/web/**" or "src/**/*.{ts,tsx}"; "" for all files.',
          ),
        ),
      }),
    ),
    v.description(
      'The complete list of rules after the change, in order: keep every rule the request leaves alone, word for word.',
    ),
  ),
  reply: v.pipe(
    v.string(),
    v.description(
      'One or two plain sentences to the reviewer on what you changed, or a short question if the request is unclear (then return the rules unchanged).',
    ),
  ),
});

export const EDIT_RULES_SYSTEM = `You edit a code reviewer's own rules for which decisions gloss flags in a pull request review. gloss already flags decisions by its built-in rules; the reviewer's rules add to them, win where they disagree, and can name a priority (low, medium, high, urgent).

Apply the reviewer's request to the current rules: add, remove, reword, split, merge or scope rules as asked, and nothing else. Keep each rule one short imperative sentence that names a kind of code, behavior or choice, so it is clear whether a change falls under it. Do not add a rule a built-in rule already covers, unless the reviewer asks for it, for example to raise its priority. Scope a rule to some files only when the request says which files (a language, a directory, a kind of file), with a gitignore-style glob on the path, such as *.py or apps/web/**.

To undo an earlier turn, go back to the rules as they were before it, listed under "Earlier in this edit".

Call the submit tool once with the complete list and your reply.`;

/** The current rules and the request, with the built-in rules to avoid repeating. */
export function buildEditRulesPrompt(request: {
  rules: readonly RuleRow[];
  instruction: string;
  history: readonly EditRulesTurn[];
}): string {
  const row = (rule: RuleRow) => `- ${rule.text}${rule.files ? ` [files: ${rule.files}]` : ''}`;
  return [
    '## Built-in rules',
    ...Object.values(BUILT_IN_DECISION_RULES).map((rule) => `- ${rule}`),
    '',
    '## Current rules',
    ...(request.rules.length ? request.rules.map(row) : ['(none)']),
    ...(request.history.length
      ? [
          '',
          '## Earlier in this edit',
          ...request.history.flatMap((turn, index) => [
            ...(index ? [''] : []),
            ...(turn.before
              ? ['Rules before this request:', ...(turn.before.length ? turn.before.map(row) : ['(none)'])]
              : []),
            `Reviewer: ${turn.instruction}`,
            `You: ${turn.reply}`,
          ]),
        ]
      : []),
    '',
    '## Request',
    request.instruction,
  ].join('\n');
}

/**
 * The model rewrites the rules from a request in words; nothing is saved, the settings page
 * shows the result as a draft. Model output is untrusted: blank rules go, repeats go, and the
 * list is capped. A glob that cannot be read matches nothing (`globMatcher`).
 */
export const editDecisionRules = Effect.fnUntraced(function* (request: {
  rules: readonly RuleRow[];
  instruction: string;
  history: readonly EditRulesTurn[];
}) {
  const model = yield* ModelClient;
  const { data } = yield* model.prompt({
    tier: 'define',
    system: EDIT_RULES_SYSTEM,
    prompt: buildEditRulesPrompt(request),
    result: RuleRowsResultSchema,
    resultName: 'rules',
  });
  return { rules: normalizeRuleRows(data.rules), reply: data.reply.trim() };
});

export function normalizeRuleRows(rows: readonly { text: string; files?: string }[]): RuleRow[] {
  const out: RuleRow[] = [];
  for (const row of rows) {
    const text = row.text.trim().replace(/\s+/g, ' ').slice(0, RULE_MAX);
    const files = row.files?.trim().slice(0, RULE_MAX) || undefined;
    if (text && !out.some((seen) => seen.text === text && seen.files === files)) {
      out.push(files ? { text, files } : { text });
    }
  }
  return out.slice(0, RULES_MAX);
}
