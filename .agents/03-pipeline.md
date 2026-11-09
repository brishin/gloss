# Pipeline (`packages/core/src/pipeline`)

| Stage  | Who                                                                                                                                                                               | Typical time                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| fetch  | `gh api` / `git diff`, `.gitattributes`, path heuristics (`heuristics.ts`)                                                                                                        | 0.2 s local, 1-3 s gh            |
| define | LLM fast tier: group labels, summaries, categories, order, overall summary, change-wide decisions, three visual candidate slots; **no file lists**                                | ~5 s                             |
| judge  | Jev, in parallel with define: per-file yes/no flags (generated, tests_only, auth_check, stored_data, secrets_signing, personal_data); after define, group choice + fits_any_group | 0.1-0.6 s per file, 8 concurrent |
| place  | `place.ts` truth table; one LLM follow-up turn for unsure files                                                                                                                   | ms + 1 turn                      |
| notes  | LLM strong tier, one call per group, 3 concurrent, lead group first; also pins decisions to lines                                                                                 | 2-7 s per group                  |

Truth table, in order:

1. `.gitattributes` generated → `generated`.
2. Docs and agent guidance (`guidance.ts`) → the LLM's docs group, or synthetic `guidance`. Agent guidance means AGENTS.md, CLAUDE.md, `.agents/`, `.claude/`, skills and SKILL.md, and editor/agent rules. Prose docs count too, unless they are test fixtures, changelog-style bookkeeping, or Jev generated ≥ 0.7.
3. Jev generated ≥ 0.7 → `generated`.
4. Jev tests_only ≥ 0.7 → the LLM's tests group or synthetic `tests`.
5. Missing/unknown choice, fits_any_group ≤ 0.3 with confidence < 0.8, confidence < 0.5 or top-2 margin < 0.15 → follow-up.
6. Else Jev's choice. After the follow-up, anything left goes to `uncategorized`.

A group is critical when any member file that is not tests-only or generated is ≥ 0.7 on a risk question.

Order: docs and guidance groups lead, because they state the intent and the rules the code should follow; the user asked for this. Then come the LLM's other groups in its order, then tests, then synthetic `tests`/`generated`/`uncategorized`. Provisional groups lead with guidance too. The define prompt marks guidance files `[guidance]` and inlines their diffs first, so the budget never cuts them; then the code that stays, then removed files, then tests. The notes prompt asks what rules or intent they establish.

Without Jev, define asks for `fileIds` per group, `reconcileListedFiles` keeps the
first claim and reports unknown ids (the guidance rule still applies), and the follow-up places the rest.

Jev wording, thresholds and `fileState()` are ported verbatim from the pulls.review
evals (`~/Programming/pulls.review-evals/typesafe-2026-10-26-round3/src`). Retune there
first. `QUESTIONS_VERSION` invalidates cached judgments.

Prompts: `prompts.ts`. Result schemas carry field descriptions that the model sees in
the submit tool. Budgets are 60k characters per prompt and 12k per file, and generated,
binary and oversized files are collapsed to their manifest line. Notes prompts number
each line, using new-file numbers for `+`/` ` lines and old-file numbers for `-` lines.

Decisions name a choice and what it costs or risks, so a reviewer can accept or reject it: asked for a choice and its reason, the model restated the author's case. Define judges costs from the diff, not the description, and lists only choices no single file makes. Notes count an omission as a decision (a missing check or limit) and write a risk in a choice as a decision, not a note. Priority is by consequence if the choice is wrong, and the lower of two when unsure. In the 2026-11-02 eval, stricter note wording and wider Jev risk criteria both made notes worse: stricter wording cut insights, and more flags produced reassuring risk notes.

The user's own decision rules (`decisionRules` in `~/.gloss/config.json`, edited on the settings
page) are sets of rules, each with an optional `files` glob tested against changed paths (gitignore-style, `glob.ts`: `*.py` matches at any depth, `src/**/*.{ts,tsx}` is anchored, as Copilot, Greptile and CodeRabbit scope rules)
(`rulesFor`; a set that matches only some of a prompt's files names them after each rule). They go into the define prompt (sets matching any changed file) and each group's
notes prompt (sets matching one of its files) as a `## Reviewer's decision rules` section, not the
system text, so tours without rules keep their prompts and caches. A rule wins over the built-in
guidance, and its priority is used. All sets join the tour cache key only when there are some. On
save, Jev checks each rule, read with its files glob (`decision-rules.ts`, one call per rule,
cached): is it covered by or at odds with a built-in rule (`BUILT_IN_DECISION_RULES`, a short
summary of the prompts' rules; keep it in step), too vague, or a repeat of or at odds with a later
rule. The findings only advise; the save always goes through.
The settings page shows one row per rule with its own files glob; rows save as sets (rows that
share a glob share a set, `setsFromRows`). A chat under the rows (`POST /api/rules/edit`,
`editDecisionRules`, define tier) rewrites the whole list from a request in words; the result is an
unsaved draft that the user saves (and Jev checks) like a hand edit.

A reviewed repository can commit its own rule sets, same shape, at `.gloss/config.json`
(`repo-config.ts`), and an org can commit the same file in its `.github` repository for all its
repos (as Probot does). Sets merge broadest first: org, then repo, then the user's, in the prompts
and the tour key; `rulesFor` drops a repeated rule. Local repos read only their own file. GitHub
repos read the file from the default branch, never the PR head, so a PR cannot change the rules
it is reviewed by; local repos read it at HEAD. To keep `gh` calls low, each repo's answer is
kept in memory for 10 minutes (one entry per repo, shared by a stack), then asked again with its
ETag: an unchanged file answers 304, which does not count against the rate limit. The request
runs beside the fingerprint, so it adds no wait. A re-run asks at once. A failed request is never
kept; the tour uses the last answer, or none. Jev's rule check covers only the user's sets.

Both decision passes look first for one-way doors. Each SQL migration file gets exactly one
notes decision pinned in the file (urgent if it drops or rewrites data, else high), and define
lists only its rollout across files. Define sees only that rollout rule; given the full rule it
restated the schema change change-wide, and notes then skipped it as covered.

The define call overgenerates two required candidate slots, `first`/`second` from the data
kinds, each with an explicit `none`; asked for a 2-3 item list, the model returned one
every time. A third candidate, the `sketch`, is an SVG the model draws itself (hand-drawn
pictures explained decisions best in the bake-off). It has its own call on the define model
(`SKETCH_SYSTEM`, the define prompt plus the tour's summary and decisions), run while Jev
judges files: as an optional kind it was drawn once in five PRs, and as a define slot it came
out as a shallow overview. It is the first candidate. `svg-sanitize.ts` parses it against an element
and attribute allowlist (no script, style, links, images, foreignObject, entities or
external `url()`), rejects anything else whole, and the web app shows it only as an
`<img>`. `SKETCH_GUIDE` gives the house style (neutral boxes, one accent or dashed-red
step, labelled arrows) and three example figures. The sketch names its figure type (`form`:
architecture, timeline, states, boundary, fan, shape or bands) before it draws; with bands as the only
layout described, it drew before/after bands for most changes, so bands is listed last.
A sketch whose arrow ends touch no box is dropped (`looseEnds`): in the eval, arrows into
empty space were how sketches failed to close a loop. `sketchGap` also drops one whose
caption says "before" with no BEFORE band, or whose arrows are mostly unlabelled: prompt
rules alone did not hold.
A tour with change-wide decisions also gets one more define-tier call right after the groups are defined (`WALKTHROUGH_SYSTEM`, a numbered diff and the decisions numbered from 0): the walkthrough reads each decision in code, so a reviewer understands it, sees where it lives and reads the few lines that build it (Brian's ask, 2026-11-03, after mocks in the project's mocks/decision-walkthrough/). Per decision: a short claim as title, why, the option not taken, what to check, 1-3 snippets of 2-12 lines with the line that makes the choice as `focus` and an optional note under it, and a tree only when it helps: calls when the decision runs across a call path or many callers reach it, concepts when it is a hierarchy (what counts, which case resolves how). The page hangs each snippet under the tree row that points at it. `normalizeWalkthrough` keeps one entry per listed decision, moves a snippet to the hunk that shows its focus, moves a focus the diff does not show onto the first added line, narrows a snippet to 16 rows around its focus, makes tree depths a tree, keeps a row's line only where the diff shows it, drops a tree with no child or a call path with nothing new, and drops an entry with no code. A second define-tier call beside it, `callpath` (`CALL_PATH_SYSTEM`, the prompt the walkthrough had before decisions), draws the change's key code paths ("Key Code Paths" on the page): a call tree from a known entry point (frames) read in 2-5 steps of short excerpts, or none when there is no path (Brian's ask, 2026-11-03, after 0 of 16 decisions on two PRs got a tree, with or without "most decisions need none"; asked in the decisions call, the model left the path empty). `normalizeWalkthrough` keeps a path with a call and something new on it and at least two steps with code, and drops it when the decisions' call trees already show every new or changed frame. A tour with no change-wide decisions skips the decisions call but still asks for the path. It runs forked in the stream's scope beside placement and notes; the tour joins it before it finishes. A Jev `call_path` gate on the path was tried and dropped, because on 24 PRs it hid most walkthroughs worth showing.
No visual candidates means no pick.
`normalizeVisuals` clips text, clamps timeline positions, caps rows and
lanes, keeps only flowchart and state Mermaid without styling or click lines, and drops
(with a warning) anything it cannot draw legibly. Without Jev the first survivor is
shown. With Jev, `visual-image.ts` draws each candidate to a PNG at tour width (resvg; Mermaid
via beautiful-mermaid with its CSS vars resolved), shrunk or padded so every side is
400-1200 px, since Jev rejects a side outside about 280-1568 px, and one `judge-visual` call sends the pictures as `<image-N>` beside their specs. Jev answers
focused yes/no questions per candidate (`accurate`, `beyond_text`: more than a list would
say, `whole`, and with pictures `easy`), plus a `workflow` question for the change; a
single "which is best" choice favored any flowchart, even a muddled or partial one. The
sketch is shown when Jev finds it accurate and more than a list, unless Jev says the change is a
`workflow` (Brian prefers sketches except for those, where flowcharts read well). Otherwise the
accurate candidate that is more than a list, with the highest `whole` x `easy`, is shown, or none (`pickVisual`).
If a picture fails to draw, Jev reads the specs only; if Jev fails, the
first candidate is shown.

Notes, the walkthrough and the call path get one read-only tool, `read_file` (`read-file.ts`): any file at
the diff's head, numbered, 400 lines or 24k characters a read, 8 reads a call. It is for code
the prompt cuts off (a truncated or omitted diff, a file too large to show) and for code a
changed line calls into that the diff does not show; without it, notes said they "could not see"
a function. `repoPath` keeps a path relative and inside the repository, and a file the diff does
not change reads from git's tree (the head commit, or HEAD for a working tree), never the disk.
Notes still pin only to hunk lines. The per-group cache key is still the prompt, so a cached
answer does not see later edits to files outside the group. The trace lists each call's reads.

Trace: `runTour`'s `onStep` gets every step as it starts and ends (`pipeline/trace.ts`):
fetch, define, sketch, judge-files, judge-groups, judge-visual, walkthrough, callpath, place, followup, and
`notes:<groupKey>`. A finished tour caches its trace next to it (`traceCacheKey`), so a
cached tour replays its trace too. The web app's pipeline view (`d` on a tour) draws it.
When a prompt gains a `## ` section that reads another step, add it to that call's
`promptSections` map, or the view credits it to the fetch.

Ideas not built yet: re-tour only changed files on new commits (the per-file and
per-group cache keys already make unchanged work free), moving group order to Jev, and
streaming `group.defined` per group while the define call is still running.
