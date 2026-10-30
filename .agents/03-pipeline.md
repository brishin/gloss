# Pipeline (`packages/core/src/pipeline`)

| Stage  | Who                                                                                                                                                                                                   | Typical time                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| fetch  | `gh api` / `git diff`, `.gitattributes`, path heuristics (`heuristics.ts`)                                                                                                                            | 0.2 s local, 1-3 s gh            |
| define | LLM fast tier: group labels, summaries, categories, order, overall summary, change-wide decisions, three visual candidate slots; **no file lists**                                                    | ~5 s                             |
| judge  | Jev, in parallel with define: per-file yes/no flags (generated, tests_only, auth_check, stored_data, secrets_signing, personal_data, exported_signature); after define, group choice + fits_any_group | 0.1-0.6 s per file, 8 concurrent |
| place  | `place.ts` truth table; one LLM follow-up turn for unsure files                                                                                                                                       | ms + 1 turn                      |
| notes  | LLM strong tier, one call per group, 3 concurrent, lead group first; also pins decisions to lines                                                                                                     | 2-7 s per group                  |

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
`normalizeVisuals` clips text, clamps timeline positions, caps rows and
lanes, keeps only flowchart and state Mermaid without styling or click lines, and drops
(with a warning) anything it cannot draw legibly. Without Jev the first survivor is
shown. With Jev, `visual-image.ts` draws each candidate to a PNG at tour width (resvg; Mermaid
via beautiful-mermaid with its CSS vars resolved), shrunk or padded so every side is
400-1200 px, since Jev rejects a side outside about 280-1568 px, and one `judge-visual` call sends the pictures as `<image-N>` beside their specs. Jev answers
focused yes/no questions per candidate (`accurate`, `beyond_text`: more than a list would
say, `whole`, and with pictures `easy`), plus one `workflow` question for the change; a
single "which is best" choice favored any flowchart, even a muddled or partial one. The
sketch is shown when Jev finds it accurate and more than a list, unless Jev says the change is a
`workflow` (Brian prefers sketches except for those, where flowcharts read well). Otherwise the
accurate candidate that is more than a list, with the highest `whole` x `easy`, is shown, or none (`pickVisual`).
If a picture fails to draw, Jev reads the specs only; if Jev fails, the
first candidate is shown.

Trace: `runTour`'s `onStep` gets every step as it starts and ends (`pipeline/trace.ts`):
fetch, define, sketch, judge-files, judge-groups, judge-visual, place, followup, and
`notes:<groupKey>`. A finished tour caches its trace next to it (`traceCacheKey`), so a
cached tour replays its trace too. The web app's pipeline view (`d` on a tour) draws it.
When a prompt gains a `## ` section that reads another step, add it to that call's
`promptSections` map, or the view credits it to the fetch.

Ideas not built yet: re-tour only changed files on new commits (the per-file and
per-group cache keys already make unchanged work free), moving group order to Jev, and
streaming `group.defined` per group while the define call is still running.
