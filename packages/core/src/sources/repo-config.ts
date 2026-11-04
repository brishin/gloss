import { capRuleSets, type DecisionRuleSet, readRuleSets, type SourceRef } from '@gloss/protocol';
import { Cache, Context, Data, Duration, Effect, Exit, Layer } from 'effect';
import { CommandError, tryGit } from './exec.ts';
import { gh } from './github.ts';

/** Where a repository keeps its gloss config, beside the user's `~/.gloss/config.json`. */
export const REPO_CONFIG_PATH = '.gloss/config.json';

/** What a repository's config sets for every tour of it. */
export interface RepoConfig {
  /** Rule sets for which decisions to flag, the same shape as the user's `decisionRules`. */
  decisionRules: readonly DecisionRuleSet[];
}

export const EMPTY_REPO_CONFIG: RepoConfig = { decisionRules: [] };

/**
 * A repository's config from its text. Anyone with write access writes it, so it is read like the
 * user's own config: keys it does not know, and sets that do not parse, are left out, and the
 * rules are capped like saved ones, because every rule that applies goes into every prompt.
 */
export function parseRepoConfig(text: string): RepoConfig {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return EMPTY_REPO_CONFIG;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return EMPTY_REPO_CONFIG;
  }
  return { decisionRules: capRuleSets(readRuleSets((json as { decisionRules?: unknown }).decisionRules)) };
}

/** What GitHub answers for the config file: its text, "same as your copy", or no such file. */
export type ConfigResponse =
  | { kind: 'found'; text: string; etag?: string }
  | { kind: 'unchanged' }
  | { kind: 'missing' };

/** The status of a `gh api -i` response: its status line, or the `(HTTP 404)` that `gh` writes on a failure. */
export function responseStatus(output: string): number | undefined {
  const match = /^HTTP\/[\d.]+ (\d{3})/m.exec(output) ?? /\bHTTP (\d{3})\b/.exec(output);
  return match ? Number(match[1]) : undefined;
}

/** Splits `gh api -i` output into its headers (lower-case names) and body. */
export function splitResponse(output: string): { headers: Map<string, string>; body: string } {
  const end = /\r?\n\r?\n/.exec(output);
  const head = end ? output.slice(0, end.index) : output;
  const body = end ? output.slice(end.index + end[0].length) : '';
  const headers = new Map<string, string>();
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
  }
  return { headers, body };
}

/**
 * The config file on the default branch, not the PR's head, so a PR cannot change the rules it is
 * reviewed by. With the `etag` of the last answer this is a conditional request: GitHub answers
 * 304 when the file is unchanged, and a 304 does not count against the rate limit.
 */
export async function fetchGithubRepoConfig(
  owner: string,
  repo: string,
  etag: string | undefined,
  signal?: AbortSignal,
): Promise<ConfigResponse> {
  let output: string;
  try {
    output = await gh(
      [
        '-i',
        '-H',
        'Accept: application/vnd.github.raw+json',
        ...(etag ? ['-H', `If-None-Match: ${etag}`] : []),
        `repos/${owner}/${repo}/contents/${REPO_CONFIG_PATH}`,
      ],
      signal,
    );
  } catch (error) {
    // `gh` fails on any status past 299, a 304 too; `-i` has already printed the status line.
    const status = error instanceof CommandError ? responseStatus(`${error.stdout}\n${error.stderr}`) : undefined;
    if (status === 304) {
      return { kind: 'unchanged' };
    }
    if (status === 404) {
      return { kind: 'missing' };
    }
    throw error;
  }
  const { headers, body } = splitResponse(output);
  return { kind: 'found', text: body, etag: headers.get('etag') };
}

class ConfigFetchError extends Data.TaggedError('ConfigFetchError')<{ cause: unknown }> {}

/** How long a repository's config is used before GitHub is asked again. */
export const REPO_CONFIG_TTL = Duration.minutes(10);

/** The repository whose `.gloss/config.json` applies to every repository of its owner. */
export const ORG_CONFIG_REPO = '.github';

const lower = (key: string) => key.toLowerCase();

/** Configs from broadest to narrowest (org, then repo) as one: their rule sets in that order. */
export function mergeRepoConfigs(configs: readonly RepoConfig[]): RepoConfig {
  return { decisionRules: configs.flatMap((config) => config.decisionRules) };
}

/**
 * Each repository's config, for every tour of it: the org's (its owner's `.github` repository),
 * then the repository's own. Local repositories read only their own file at HEAD with git.
 * GitHub repositories are asked at most once per `REPO_CONFIG_TTL`, and then with the last
 * answer's ETag, so an unchanged file costs nothing against the rate limit. Tours of one repo at
 * once (a stack) share one request. A failed request is not kept: the tour uses the last answer,
 * or no config, and the next tour asks again.
 */
export const makeRepoConfigs = (
  options: {
    fetch?: typeof fetchGithubRepoConfig;
    readLocal?: (repo: string) => Promise<string | undefined>;
  } = {},
) =>
  Effect.gen(function* () {
    const fetch = options.fetch ?? fetchGithubRepoConfig;
    const readLocal =
      options.readLocal ?? ((repo: string) => tryGit(repo, ['cat-file', 'blob', `HEAD:${REPO_CONFIG_PATH}`]));
    // Keyed by `owner/repo`, lower case: one entry per repository, whichever PR asks.
    const known = new Map<string, { config: RepoConfig; etag?: string }>();

    const cache = yield* Cache.makeWith(
      (key: string) =>
        Effect.tryPromise({
          try: (signal) => {
            const [owner = '', repo = ''] = key.split('/');
            return fetch(owner, repo, known.get(key)?.etag, signal);
          },
          catch: (cause) => new ConfigFetchError({ cause }),
        }).pipe(
          Effect.map((response) => {
            if (response.kind === 'unchanged') {
              return known.get(key)?.config ?? EMPTY_REPO_CONFIG;
            }
            if (response.kind === 'missing') {
              known.delete(key);
              return EMPTY_REPO_CONFIG;
            }
            const config = parseRepoConfig(response.text);
            known.set(key, { config, ...(response.etag ? { etag: response.etag } : {}) });
            return config;
          }),
        ),
      { capacity: 256, timeToLive: (exit) => (Exit.isSuccess(exit) ? REPO_CONFIG_TTL : 0) },
    );

    return {
      get: (ref: SourceRef, { revalidate = false } = {}): Effect.Effect<RepoConfig> => {
        if (ref.kind === 'local') {
          return Effect.promise(() => readLocal(ref.repo)).pipe(
            Effect.map((text) => (text === undefined ? EMPTY_REPO_CONFIG : parseRepoConfig(text))),
          );
        }
        const one = (key: string) =>
          (revalidate ? Cache.invalidate(cache, key) : Effect.void).pipe(
            Effect.andThen(Cache.get(cache, key)),
            Effect.catch(() => Effect.succeed(known.get(key)?.config ?? EMPTY_REPO_CONFIG)),
          );
        // The owner's `.github` repository holds its org-wide config, as for GitHub's community files.
        const keys = [...new Set([`${ref.owner}/${ORG_CONFIG_REPO}`, `${ref.owner}/${ref.repo}`].map(lower))];
        return Effect.forEach(keys, one, { concurrency: 'unbounded' }).pipe(Effect.map(mergeRepoConfigs));
      },
    };
  });

/**
 * The config a reviewed repository commits at `.gloss/config.json`, after its org's (the same file
 * in the owner's `.github` repository), read at the start of each tour. Optional: without it tours
 * use only the user's config.
 */
export class RepoConfigs extends Context.Service<
  RepoConfigs,
  {
    /** `revalidate` asks GitHub now (a conditional request) instead of using an answer from the last few minutes. */
    get(ref: SourceRef, options?: { revalidate?: boolean }): Effect.Effect<RepoConfig>;
  }
>()('@gloss/core/RepoConfigs') {
  static readonly layer = Layer.effect(RepoConfigs, makeRepoConfigs());
}
