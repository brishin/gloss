import * as v from 'valibot';

/** At most this many rules, each at most `RULE_MAX` characters: every rule goes into every decision prompt. */
export const RULES_MAX = 20;
export const RULE_MAX = 400;

/**
 * The user's own rules for which decisions to flag, as saved in `~/.gloss/config.json`
 * (`decisionRules`). Each rule is one line of plain text.
 */
export const DecisionRulesSchema = v.pipe(
  v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(RULE_MAX))),
  v.maxLength(RULES_MAX),
);

export const SaveDecisionRulesSchema = v.object({ rules: DecisionRulesSchema });

/**
 * What Jev found when it checked the rules. `rule` and `other` index into the rules;
 * `builtIn` is the text of the built-in rule a finding is about.
 * - `overlap`: the built-in rules (or rule `other`) already flag what the rule asks for.
 * - `contradiction`: the rule asks to flag what the built-in rules (or rule `other`) skip, or the reverse.
 * - `vague`: the rule does not say clearly which choices it covers.
 */
export const RuleFindingSchema = v.object({
  rule: v.number(),
  kind: v.picklist(['overlap', 'contradiction', 'vague']),
  builtIn: v.optional(v.string()),
  other: v.optional(v.number()),
});
export type RuleFinding = v.InferOutput<typeof RuleFindingSchema>;

export const DecisionRulesStateSchema = v.object({
  rules: v.array(v.string()),
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
