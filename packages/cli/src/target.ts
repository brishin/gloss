import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultLocalTarget, findRepoRoot } from '@gloss/core';
import type { SourceRef } from '@gloss/protocol';
import { parseGithubTarget } from '@gloss/protocol';

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolves what the user typed: a PR URL or `owner/repo#123`; a directory (its repo, default
 * target); a git target in the current repo (`HEAD~2`, `main...HEAD`, `''` for the working
 * tree); or nothing (the current repo's uncommitted changes, else its branch).
 */
export async function resolveTarget(input: string | undefined, cwd: string): Promise<SourceRef> {
  if (input) {
    const github = parseGithubTarget(input);
    if (github) {
      return github;
    }
    if (isDirectory(resolve(cwd, input))) {
      const repo = await findRepoRoot(resolve(cwd, input));
      return { kind: 'local', repo, target: await defaultLocalTarget(repo) };
    }
  }
  const repo = await findRepoRoot(cwd).catch(() => {
    throw new Error('Not inside a git repository. Pass a PR URL, owner/repo#123, or a repository path.');
  });
  return {
    kind: 'local',
    repo,
    target: input === undefined ? await defaultLocalTarget(repo) : input === 'worktree' ? '' : input,
  };
}

/** The web route that shows a ref (mirrors apps/web/src/lib/source-routes.ts). */
export function webPath(ref: SourceRef): string {
  switch (ref.kind) {
    case 'github-pr':
      return `/gh/${ref.owner}/${ref.repo}/pull/${ref.number}`;
    case 'local':
      return `/local?${new URLSearchParams({ repo: ref.repo, target: ref.target })}`;
  }
}
