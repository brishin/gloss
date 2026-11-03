import * as v from 'valibot';

/** Limits, because every rule that applies goes into every decision prompt. */
export const RULE_SETS_MAX = 10;
export const RULES_MAX = 20;
export const RULE_MAX = 400;

const isRegex = (pattern: string) => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};

/**
 * Rules for which decisions to flag, and the files they are about: `files` is a regular
 * expression tested against each changed file's path; without one the rules apply to every file.
 */
export const DecisionRuleSetSchema = v.object({
  files: v.optional(
    v.pipe(v.string(), v.trim(), v.maxLength(RULE_MAX), v.check(isRegex, 'Files must be a regular expression')),
  ),
  rules: v.pipe(v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(RULE_MAX))), v.minLength(1)),
});
export type DecisionRuleSet = v.InferOutput<typeof DecisionRuleSetSchema>;

/** The user's rule sets, as saved in `~/.gloss/config.json` (`decisionRules`). */
export const DecisionRuleSetsSchema = v.pipe(
  v.array(DecisionRuleSetSchema),
  v.maxLength(RULE_SETS_MAX),
  v.check(
    (sets) => sets.reduce((count, set) => count + set.rules.length, 0) <= RULES_MAX,
    `At most ${RULES_MAX} rules`,
  ),
);

export const SaveDecisionRulesSchema = v.object({ sets: DecisionRuleSetsSchema });

/** One rule, by its set and its place in the set. */
export const RuleRefSchema = v.object({ set: v.number(), rule: v.number() });
export type RuleRef = v.InferOutput<typeof RuleRefSchema>;

/**
 * What Jev found when it checked the rules. `builtIn` is the text of the built-in rule a finding
 * is about; `other` is the user's rule it is about.
 * - `overlap`: the built-in rules (or `other`) already flag what the rule asks for.
 * - `contradiction`: the rule asks to flag what the built-in rules (or `other`) skip, or the reverse.
 * - `vague`: the rule does not say clearly which choices it covers.
 */
export const RuleFindingSchema = v.object({
  ...RuleRefSchema.entries,
  kind: v.picklist(['overlap', 'contradiction', 'vague']),
  builtIn: v.optional(v.string()),
  other: v.optional(RuleRefSchema),
});
export type RuleFinding = v.InferOutput<typeof RuleFindingSchema>;

export const DecisionRulesStateSchema = v.object({
  sets: v.array(DecisionRuleSetSchema),
  findings: v.array(RuleFindingSchema),
  /** False when the backend has no Jev, so nothing was checked. */
  checked: v.boolean(),
});
export type DecisionRulesState = v.InferOutput<typeof DecisionRulesStateSchema>;

/**
 * Rules from text a person typed: one per line, list markers ("-", "*", "•", "1.", "1)")
 * dropped, blank lines and repeats left out. Lines are not joined: a rule is one line.
 */
export function parseRules(text: string): string[] {
  const rules: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const rule = line
      .replace(/^\s*(?:[-*•‣◦]|\d+[.)])\s+/, '')
      .trim()
      .replace(/\s+/g, ' ');
    if (rule && !rules.some((seen) => seen.toLowerCase() === rule.toLowerCase())) {
      rules.push(rule);
    }
  }
  return rules;
}

/** How many matching paths a scoped rule names before it counts the rest. */
const SCOPE_PATHS = 6;

/**
 * The rules that apply to a set of changed files: those of every set with no `files`, or whose
 * `files` matches at least one path. A rule whose set matches only some of the paths names
 * them, so a prompt that holds other files keeps the rule to its own. A pattern that does not
 * compile (a hand-edited config) matches nothing.
 */
export function rulesFor(sets: readonly DecisionRuleSet[], paths: readonly string[]): string[] {
  const rules: string[] = [];
  // A rule that also applies everywhere needs no scoped copy.
  const everywhere = new Set(sets.flatMap((set) => (set.files ? [] : set.rules)));
  for (const set of sets) {
    let pattern: RegExp | undefined;
    try {
      pattern = set.files ? new RegExp(set.files) : undefined;
    } catch {
      continue;
    }
    const matched = pattern ? paths.filter((path) => pattern.test(path)) : paths;
    if (pattern && matched.length === 0) {
      continue;
    }
    const more = matched.length - SCOPE_PATHS;
    const scope =
      matched.length < paths.length
        ? ` (only in ${matched.slice(0, SCOPE_PATHS).join(', ')}${more > 0 ? ` and ${more} more files matching /${set.files}/` : ''})`
        : '';
    for (const rule of set.rules) {
      if (pattern && everywhere.has(rule)) {
        continue;
      }
      const text = `${rule}${scope}`;
      if (!rules.includes(text)) {
        rules.push(text);
      }
    }
  }
  return rules;
}
