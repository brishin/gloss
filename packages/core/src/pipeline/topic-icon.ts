import { TOPIC_ICONS, type TopicIcon, type TopicIconRequest, TopicIconSchema } from '@gloss/protocol';
import { Effect } from 'effect';
import * as v from 'valibot';
import { ModelClient } from '../adapters/types.ts';
import { TourCache } from '../cache/store.ts';
import { hashOf } from '../hash.ts';

export const TOPIC_ICON_SYSTEM = `You pick an icon for a pull request, or a stack of pull requests, in the dashboard of a code review app. The icon marks what the work is about, so a reader can tell rows apart at a glance.

Read the titles and pick the one icon from the list that best fits the subject of the work: the feature, surface or system it changes (for example "smartphone" for a mobile layout fix, "database" for a storage change, "repeat" for scheduled routines). Prefer the subject over the kind of change: do not pick "bug" or "wrench" only because it is a fix, unless the work is about debugging or tooling.

Call the submit tool once with the result.`;

export const TopicIconResultSchema = v.object({
  icon: v.pipe(TopicIconSchema, v.description('One icon name from the list')),
});

export const TOPIC_ICON_VERSION = hashOf({ TOPIC_ICON_SYSTEM, TOPIC_ICONS, schema: 1 }).slice(0, 12);

/** The titles, bottom to top for a stack; nothing else, so the icon (and its cache entry) stays when a PR changes state. */
export function topicIconPrompt(request: TopicIconRequest): string {
  return [
    request.titles.length > 1 ? 'Stack of PRs, bottom to top:' : 'PR:',
    ...request.titles.map((title) => `- ${title}`),
  ].join('\n');
}

/**
 * Picks a topic icon with the small tier (Haiku by default), cached under the exact request, so
 * a PR or stack gets its icon once until a title changes.
 */
export const pickTopicIcon = Effect.fn('pickTopicIcon')(function* (request: TopicIconRequest) {
  const model = yield* ModelClient;
  const cache = yield* TourCache;
  const prompt = topicIconPrompt(request);
  const key = hashOf({
    kind: 'topic-icon',
    request: { TOPIC_ICON_VERSION, model: model.config().small, prompt },
  });
  const hit = cache.get<TopicIcon>(key);
  if (hit !== undefined) {
    return hit;
  }
  const response = yield* model.prompt({
    tier: 'small',
    system: TOPIC_ICON_SYSTEM,
    prompt,
    result: TopicIconResultSchema,
    resultName: 'topic_icon',
  });
  cache.put(key, 'topic-icon', response.data.icon, response.model);
  return response.data.icon;
});
