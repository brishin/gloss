# Pipeline (`packages/core/src/pipeline`)

| Stage  | Who                                                                                                                                                                                                   | Typical time                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| fetch  | `gh api` / `git diff`, `.gitattributes`, path heuristics (`heuristics.ts`)                                                                                                                            | 0.2 s local, 1-3 s gh            |
| define | LLM fast tier: group labels, summaries, categories, order, overall summary; **no file lists**                                                                                                         | ~5 s                             |
| judge  | Jev, in parallel with define: per-file yes/no flags (generated, tests_only, auth_check, stored_data, secrets_signing, personal_data, exported_signature); after define, group choice + fits_any_group | 0.1-0.6 s per file, 8 concurrent |
| place  | `place.ts` truth table; one LLM follow-up turn for unsure files                                                                                                                                       | ms + 1 turn                      |
| notes  | LLM strong tier, one call per group, 3 concurrent, lead group first                                                                                                                                   | 2-7 s per group                  |

Truth table, in order:

1. `.gitattributes` generated → `generated`.
2. Docs and agent guidance (`guidance.ts`) → the LLM's docs group, or synthetic `guidance`. Agent guidance means AGENTS.md, CLAUDE.md, `.agents/`, `.claude/`, skills and SKILL.md, and editor/agent rules. Prose docs count too, unless they are test fixtures, changelog-style bookkeeping, or Jev generated ≥ 0.7.
3. Jev generated ≥ 0.7 → `generated`.
4. Jev tests_only ≥ 0.7 → the LLM's tests group or synthetic `tests`.
5. Missing/unknown choice, fits_any_group ≤ 0.3, confidence < 0.5 or top-2 margin < 0.15 → follow-up.
6. Else Jev's choice. After the follow-up, anything left goes to `uncategorized`.

A group is critical when any member file is ≥ 0.7 on a risk question.

Order: docs and guidance groups lead, because they state the intent and the rules the code should follow; the user asked for this. Then come the LLM's other groups in its order, then tests, then synthetic `tests`/`generated`/`uncategorized`. Provisional groups lead with guidance too. The define prompt marks guidance files `[guidance]` and inlines their diffs first, so the budget never cuts them. The notes prompt asks what rules or intent they establish.

Without Jev, define asks for `fileIds` per group, `reconcileListedFiles` keeps the
first claim and reports unknown ids (the guidance rule still applies), and the follow-up places the rest.

Jev wording, thresholds and `fileState()` are ported verbatim from the pulls.review
evals (`~/Programming/pulls.review-evals/typesafe-2026-10-26-round3/src`). Retune there
first. `QUESTIONS_VERSION` invalidates cached judgments.

Prompts: `prompts.ts`. Result schemas carry field descriptions that the model sees in
the submit tool. Budgets are 60k characters per prompt and 12k per file, and generated,
binary and oversized files are collapsed to their manifest line. Notes prompts number
each line, using new-file numbers for `+`/` ` lines and old-file numbers for `-` lines.

Ideas not built yet: re-tour only changed files on new commits (the per-file and
per-group cache keys already make unchanged work free), moving group order to Jev, and
streaming `group.defined` per group while the define call is still running.
