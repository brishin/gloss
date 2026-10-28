import type { SourceRef } from '@gloss/protocol';
import { createGithubSource } from './github.ts';
import { createLocalSource } from './local.ts';
import type { DiffSource } from './types.ts';

export function createSource(ref: SourceRef): DiffSource {
  switch (ref.kind) {
    case 'github-pr':
      return createGithubSource(ref);
    case 'local':
      return createLocalSource(ref);
  }
}

export { createGithubSource } from './github.ts';
export { isGenerated, parseGitattributes } from './gitattributes.ts';
export { createLocalSource, defaultLocalTarget, findRepoRoot, parseLocalTarget } from './local.ts';
export { assignIds, parseHunks, parsePatch } from './patch-parser.ts';
export type { DiffSource, FetchedDiff } from './types.ts';
