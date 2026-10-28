import * as v from 'valibot';

/**
 * What a tour is about. `github-pr` is fetched through the `gh` CLI; `local` is a
 * repository on the backend's machine, with `target` in git's revision syntax:
 * `''` the working tree, `A...B` a merge-base range, `A..B` a tree diff, anything else one commit.
 */
export const SourceRefSchema = v.variant('kind', [
  v.object({
    kind: v.literal('github-pr'),
    owner: v.string(),
    repo: v.string(),
    number: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  v.object({
    kind: v.literal('local'),
    /** Absolute path of the repository root on the backend's machine. */
    repo: v.string(),
    target: v.string(),
  }),
]);
export type SourceRef = v.InferOutput<typeof SourceRefSchema>;

/** The only formula for a ref's identity: job dedupe and cache keys all go through it. */
export function serializeRef(ref: SourceRef): string {
  switch (ref.kind) {
    case 'github-pr':
      return `github:${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
    case 'local':
      return `local:${ref.repo}@${ref.target}`;
  }
}

const PR_URL_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i;
const PR_SHORT_RE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

/** Parses a GitHub PR URL or `owner/repo#123`. Local targets are resolved by the CLI, which knows the cwd. */
export function parseGithubTarget(input: string): SourceRef | undefined {
  const text = input.trim();
  const match = PR_URL_RE.exec(text) ?? PR_SHORT_RE.exec(text);
  if (!match) {
    return undefined;
  }
  return { kind: 'github-pr', owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

export function describeRef(ref: SourceRef): string {
  switch (ref.kind) {
    case 'github-pr':
      return `${ref.owner}/${ref.repo}#${ref.number}`;
    case 'local':
      return `${ref.repo.split('/').pop()} ${ref.target || 'working tree'}`;
  }
}
