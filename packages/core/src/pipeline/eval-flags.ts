/**
 * EVAL ONLY (Jev exploration, not for merge): switches read from `GLOSS_EVAL_JEV`, a comma list.
 *
 * - early: placement and notes do not wait for the picture.
 * - roomy: in notes and walk prompts, a long file uses budget the group's other files leave over.
 * - keyhint: Jev's key hunks are listed in the walk call's prompt; no key-hunk follow-up call.
 * - diet: Jev reads every hunk before define; hunks it is sure are mechanical show as one line in every prompt.
 * - jevplace: files Jev is unsure of keep Jev's best group; no placement follow-up call.
 */
export function evalFlags(): ReadonlySet<string> {
  return new Set(
    (process.env.GLOSS_EVAL_JEV ?? '')
      .split(',')
      .map((flag) => flag.trim())
      .filter(Boolean),
  );
}
