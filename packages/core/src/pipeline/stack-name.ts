import type { Stack } from '@gloss/protocol';
import { Effect } from 'effect';
import * as v from 'valibot';
import { ModelClient, ModelError } from '../adapters/types.ts';
import { TourCache } from '../cache/store.ts';
import { hashOf } from '../hash.ts';

export const STACK_NAME_SYSTEM = `You name a stack of pull requests for the side rail of a code review app. Each PR in the stack builds on the one before it; together they work toward one goal.

Name that goal in 2 to 5 words: a noun phrase in sentence case, the way a reviewer would say what the stack is about (for example "Stack names in the side rail", "Effect rewrite of the server", "Android editor toolbar"). Prefer the words the titles use. Do not say "stack", "PR" or "pull request", and give no PR numbers, branch names, quotes or end punctuation.

Call the submit tool once with the result.`;

export const StackNameResultSchema = v.object({
  name: v.pipe(v.string(), v.description('2 to 5 words, sentence case, no end punctuation')),
});

/** Longest name the rail shows; a longer answer is cut at a word. */
const MAX_NAME_CHARS = 48;

export const STACK_NAME_VERSION = hashOf({ STACK_NAME_SYSTEM, MAX_NAME_CHARS, schema: 1 }).slice(0, 12);

/**
 * What the model reads: the repo, the base, and each PR bottom to top with its branch, title
 * and description blurb. No diffs, states or authors: a name is about intent, and leaving out
 * states keeps the name (and its cache entry) when a PR merges.
 */
export function stackNamePrompt(stack: Stack): string {
  const lines = [`Repo: ${stack.owner}/${stack.repo}`, `Base: ${stack.base}`, '', 'PRs, bottom to top:'];
  for (const member of stack.members) {
    lines.push(`- #${member.number} ${member.title} (branch ${member.headRef})`);
    if (member.blurb) {
      lines.push(`  ${member.blurb}`);
    }
  }
  return lines.join('\n');
}

/** The model's name as the rail shows it: one line, no quotes or end punctuation, at most `MAX_NAME_CHARS`. */
export function cleanStackName(raw: string): string {
  const name = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .replace(/[.!?:;,]+$/, '')
    .trim();
  if (name.length <= MAX_NAME_CHARS) {
    return name;
  }
  const cut = name.slice(0, MAX_NAME_CHARS);
  return cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : MAX_NAME_CHARS);
}

/**
 * Names a stack with the small tier (Haiku by default). The name is cached under the exact request, so a
 * stack is named once until a title, branch or description changes.
 */
export const nameStack = Effect.fn('nameStack')(function* (stack: Stack) {
  const model = yield* ModelClient;
  const cache = yield* TourCache;
  const prompt = stackNamePrompt(stack);
  const key = hashOf({
    kind: 'stack-name',
    request: { STACK_NAME_VERSION, model: model.config().small, prompt },
  });
  const hit = cache.get<string>(key);
  if (hit !== undefined) {
    return hit;
  }
  const response = yield* model.prompt({
    tier: 'small',
    system: STACK_NAME_SYSTEM,
    prompt,
    result: StackNameResultSchema,
    resultName: 'stack_name',
  });
  const name = cleanStackName(response.data.name);
  if (!name) {
    return yield* new ModelError({ message: 'The model gave an empty stack name' });
  }
  cache.put(key, 'stack-name', name, response.model);
  return name;
});
