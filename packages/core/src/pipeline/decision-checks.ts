import type { FileChange } from '@gloss/protocol';
import { hashOf } from '../hash.ts';
import { looksLikeTest } from './heuristics.ts';

/**
 * Built-in decision checks: the questions a senior reviewer asks of code in one language.
 * A group whose files one applies to gets extra model calls for its checks (see
 * `CHECKS_SYSTEM`); other groups run as before. Phrased as what falls short, because a check
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
 * The checks run as their own model calls beside the notes call, which stays byte-identical
 * to a tour without checks: it keeps its cache entry and all of its usual decisions. Folded
 * into the notes prompt, the checks crowded usual decisions out even when told they came on
 * top (67% of baseline-stable decisions kept, 43% without "on top"; a repeat baseline keeps 60%).
 *
 * "Outrank the guidance to skip refactors" still matters: with a plain "check for these"
 * the model skipped the services-as-parameter finding on every PR that had it.
 */
export const CHECKS_SYSTEM = `You are a senior engineer reviewing one group of a code change against checks the reviewer asks of every change like it. Another pass writes this group's notes and usual decisions; your only job is the checks listed under "## Reviewer checks".

Go through every function this group adds or changes, not only the main one, and answer each check against it. The checks outrank any sense that code structure or a refactor is not worth a reviewer's time. When a hunk is cut off ("truncated"), a file is omitted, or a check turns on code the diff does not show (a function it calls, its callers, a job's other enqueue sites), call read_file and read that code before you judge.

For each place the code falls short, write a decision on the line that makes the choice, naming the function and what to do instead; rate it medium unless it is worse. A check the code passes, or one that does not apply, gets nothing: never write that code passes a check, and submit no decisions when nothing falls short. Never put a decision on a test, fixture or story file, and skip anything the change-wide list covers.

Only reference file ids listed under "## Files". Decisions reference a file id, the hunk id from the hunk header, and the line number printed before the line. Lines starting with "+" or " " use side "additions"; lines starting with "-" use side "deletions". Point decisions only at lines a hunk prints; a finding in code you read goes on the hunk line that relies on it.

Call the submit tool once with the decisions.`;

export const CHECK_SPLIT: 'one' | 'each' = 'one';

/**
 * How the checks that apply to a group split into model calls: all of them in one call, or one
 * call per check. Each batch is one call, so this is also the number of extra calls per group.
 */
export function checkBatches(
  files: readonly Pick<FileChange, 'path'>[],
  checks: readonly DecisionCheck[] = DECISION_CHECKS,
  split: 'one' | 'each' = CHECK_SPLIT,
): DecisionCheck[][] {
  const applicable = checks.filter((check) => files.some((file) => check.applies(file.path)));
  if (applicable.length === 0) return [];
  return split === 'each' ? applicable.map((check) => [check]) : [applicable];
}

/** The checks prompt's closing section: last, so every call for a group shares the rest. */
export function checksSection(checks: readonly DecisionCheck[]): string[] {
  return ['', '## Reviewer checks', ...checks.map((check) => `- ${check.text}`)];
}

/** Bump when `ChecksSchema` in prompts.ts changes. */
const CHECKS_SCHEMA_VERSION = 1;

/**
 * Part of the checks call's cache key and of the finished-tour key: a finished tour is
 * replayed before any prompt is built, so without it a Python tour cached before a check
 * changed would never run the new checks.
 */
export const CHECKS_VERSION = hashOf({
  CHECKS_SYSTEM,
  CHECK_SPLIT,
  CHECKS_SCHEMA_VERSION,
  checks: DECISION_CHECKS.map((check) => check.text),
}).slice(0, 12);

interface PinnedDecision {
  readonly fileId: string;
  readonly side: string;
  readonly line: number;
}

/**
 * The group's decisions: every one the notes call wrote, then each check finding that does not
 * sit within `near` lines of one already kept, so two calls that pin the same choice show it once.
 */
export function mergeDecisions<D extends PinnedDecision>(written: readonly D[], checked: readonly D[], near = 3): D[] {
  const kept = [...written];
  for (const decision of checked) {
    const taken = kept.some(
      (other) =>
        other.fileId === decision.fileId &&
        other.side === decision.side &&
        Math.abs(other.line - decision.line) <= near,
    );
    if (!taken) kept.push(decision);
  }
  return kept;
}
