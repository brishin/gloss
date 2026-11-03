import type { FileChange } from '@gloss/protocol';
import { looksLikeTest } from './heuristics.ts';

/**
 * Built-in decision checks: the questions a senior reviewer asks of code in one language.
 * The notes pass lists the checks that apply to a group's files, so a group with none of
 * those files gets the same prompt as before. Phrased as what falls short, because a check
 * the code passes gets no decision.
 */
export interface DecisionCheck {
  readonly applies: (path: string) => boolean;
  readonly text: string;
}

const isPython = (path: string) => /\.pyi?$/.test(path) && !looksLikeTest(path);

/**
 * Python backend checks from Brian's review list. An eval on 11 flashback Python PRs found
 * these, in this wording, beat a generalized list (where code lives, how it scales, what it
 * shares, what it returns) on the services-as-parameter finding, and the general list added
 * structure nits to Swift, Kotlin and TypeScript groups.
 */
export const PYTHON_CHECKS: readonly DecisionCheck[] = [
  {
    applies: isPython,
    text: 'A function that takes the services container, or a service, as a parameter so it can call into it, where it should be a method on the service that owns the data: `services.users_repository.lookup_user_by_foo(id)`, not `lookup_user_by_foo(services, id)`.',
  },
  {
    applies: isPython,
    text: 'An import under `if TYPE_CHECKING:` (or a function-level import) that works around a dependency cycle instead of removing it.',
  },
  {
    applies: isPython,
    text: 'A backfill that processes rows or does database lookups one at a time instead of in batches.',
  },
  {
    applies: isPython,
    text: "N+1 queries: loading entities, then querying each one's related entities separately instead of in one query.",
  },
  {
    applies: isPython,
    text: 'A queue job that enqueues a subtask per batch, which makes concurrency unbounded, instead of processing one batch and then enqueuing itself for the next.',
  },
  {
    applies: isPython,
    text: "A queue job's debounce key: which other enqueue sites of that job share it, so their jobs merge or drop, or do not, so duplicates run.",
  },
  {
    applies: isPython,
    text: 'A complex return type, such as a tuple of several values or a nested dict, that deserves its own dataclass.',
  },
];

export const DECISION_CHECKS: readonly DecisionCheck[] = [...PYTHON_CHECKS];

/**
 * "Outrank the guidance to skip refactors" matters: with a plain "check for these" intro the
 * model skipped the services-as-parameter finding on every PR that had it.
 */
const INTRO =
  'The reviewer asks these of every change like this one, and they outrank the guidance to skip refactors and code structure. Go through every function this group adds or changes, not only the main one, and answer each check against it. For each place the code falls short, write a decision on the line, naming the function and what to do instead; rate it medium unless it is worse. A check the code passes, or one that does not apply, gets nothing: never write that code passes a check.';

/** The notes prompt's checks section for a group, or nothing when no check applies to its files. */
export function checksSection(
  files: readonly Pick<FileChange, 'path'>[],
  checks: readonly DecisionCheck[] = DECISION_CHECKS,
): string[] {
  const applicable = checks.filter((check) => files.some((file) => check.applies(file.path)));
  if (applicable.length === 0) return [];
  return ['', '## Reviewer checks', INTRO, ...applicable.map((check) => `- ${check.text}`)];
}
