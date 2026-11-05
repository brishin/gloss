import * as v from 'valibot';
import { globMatcher } from './glob.ts';

/** Limits, because every rule that applies goes into every decision prompt. */
export const RULE_SETS_MAX = 10;
export const RULES_MAX = 20;
export const RULE_MAX = 400;

/**
 * Rules for which decisions to flag, and the files they are about: `files` is a glob (`*.py`,
 * `src/**\/*.{ts,tsx}`, see `glob.ts`) tested against each changed file's path; without one the
 * rules apply to every file.
 */
export const DecisionRuleSetSchema = v.object({
  files: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(RULE_MAX))),
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
 * them, so a prompt that holds other files keeps the rule to its own.
 */
export function rulesFor(sets: readonly DecisionRuleSet[], paths: readonly string[]): string[] {
  const rules: string[] = [];
  // A rule that also applies everywhere needs no scoped copy.
  const everywhere = new Set(sets.flatMap((set) => (set.files ? [] : set.rules)));
  for (const set of sets) {
    const matches = set.files ? globMatcher(set.files) : undefined;
    const matched = matches ? paths.filter(matches) : paths;
    if (matches && matched.length === 0) {
      continue;
    }
    const more = matched.length - SCOPE_PATHS;
    const scope =
      matched.length < paths.length
        ? ` (only in ${matched.slice(0, SCOPE_PATHS).join(', ')}${more > 0 ? ` and ${more} more files matching ${set.files}` : ''})`
        : '';
    for (const rule of set.rules) {
      if (matches && everywhere.has(rule)) {
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

/**
 * Rule sets from a config someone wrote by hand (`decisionRules` in `~/.gloss/config.json` or a
 * repository's `.gloss/config.json`). A set that does not parse is left out; a plain list of
 * strings is one set for all files.
 */
export function readRuleSets(value: unknown): DecisionRuleSet[] {
  if (!Array.isArray(value)) {
    return [];
  }
  if (value.every((rule) => typeof rule === 'string')) {
    // A rule past `RULE_MAX` is left out, as the set schema would refuse it.
    const rules = value.map((rule: string) => rule.trim()).filter((rule) => rule && rule.length <= RULE_MAX);
    return rules.length ? [{ rules }] : [];
  }
  return value.flatMap((set) => {
    const parsed = v.safeParse(DecisionRuleSetSchema, set);
    return parsed.success ? [parsed.output] : [];
  });
}

/** The first sets that fit in `RULE_SETS_MAX` sets and `RULES_MAX` rules; the rest are left out. */
export function capRuleSets(sets: readonly DecisionRuleSet[]): DecisionRuleSet[] {
  const kept: DecisionRuleSet[] = [];
  let count = 0;
  for (const set of sets) {
    if (kept.length === RULE_SETS_MAX || count + set.rules.length > RULES_MAX) {
      break;
    }
    kept.push(set);
    count += set.rules.length;
  }
  return kept;
}

/**
 * One rule as the settings page shows it: its own row, with its own files pattern. Rows are
 * saved as sets (rows with the same pattern share one), so the config and the pipeline keep sets.
 */
export const RuleRowSchema = v.object({
  text: v.pipe(v.string(), v.trim(), v.maxLength(RULE_MAX)),
  files: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(RULE_MAX))),
});
export type RuleRow = v.InferOutput<typeof RuleRowSchema>;

export function rowsFromSets(sets: readonly DecisionRuleSet[]): RuleRow[] {
  return sets.flatMap((set) => set.rules.map((text) => (set.files ? { text, files: set.files } : { text })));
}

/**
 * Rows as sets, in the order each pattern first appears, plus where each row landed (`refs`,
 * undefined for a row left out). Blank rows and repeats within a pattern are left out.
 */
export function setsFromRows(rows: readonly RuleRow[]): { sets: DecisionRuleSet[]; refs: (RuleRef | undefined)[] } {
  const sets: DecisionRuleSet[] = [];
  const refs = rows.map((row) => {
    const text = row.text.trim().replace(/\s+/g, ' ');
    const files = row.files?.trim() || undefined;
    if (!text) {
      return undefined;
    }
    let set = sets.findIndex((candidate) => candidate.files === files);
    if (set < 0) {
      set = sets.push(files ? { files, rules: [] } : { rules: [] }) - 1;
    }
    const rules = sets[set]!.rules;
    if (rules.includes(text)) {
      return undefined;
    }
    return { set, rule: rules.push(text) - 1 };
  });
  return { sets, refs };
}

/** A request to change the rules in words: the agent returns the whole new list, unsaved. */
export const EditRulesRequestSchema = v.object({
  rules: v.pipe(v.array(RuleRowSchema), v.maxLength(RULES_MAX * 2)),
  instruction: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
  /** Earlier turns of this edit, so "undo that" or "also for tests" can refer back. */
  history: v.optional(
    v.pipe(
      v.array(
        v.object({
          instruction: v.pipe(v.string(), v.maxLength(4000)),
          reply: v.pipe(v.string(), v.maxLength(4000)),
          /** The rules as they were before this turn, so "undo that" can bring removed rules back. */
          before: v.optional(v.pipe(v.array(RuleRowSchema), v.maxLength(RULES_MAX * 2))),
        }),
      ),
      v.maxLength(10),
    ),
    [],
  ),
});
export type EditRulesRequest = v.InferInput<typeof EditRulesRequestSchema>;
export type EditRulesTurn = v.InferOutput<typeof EditRulesRequestSchema>['history'][number];

export const EditRulesResponseSchema = v.object({
  rules: v.array(RuleRowSchema),
  /** One or two sentences on what changed, or a question when the request was unclear. */
  reply: v.string(),
});
export type EditRulesResponse = v.InferOutput<typeof EditRulesResponseSchema>;
