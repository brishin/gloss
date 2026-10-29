import type { SourceRef } from '@gloss/protocol';
import { Context, Layer } from 'effect';
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

/** Turns a ref into its diff source; tests swap in fixed sources. */
export class DiffSources extends Context.Service<DiffSources, { make(ref: SourceRef): DiffSource }>()(
  '@gloss/core/DiffSources',
) {
  static readonly layer = Layer.succeed(DiffSources, { make: createSource });
}

export { createGithubSource, resolveGithubAsset } from './github.ts';
export { MAX_STACK, resolveGithubStack, type StackLookup, walkStack } from './github-stack.ts';
export { isGenerated, parseGitattributes } from './gitattributes.ts';
export { createLocalSource, defaultLocalTarget, findRepoRoot, parseLocalTarget } from './local.ts';
export { assignIds, parseHunks, parsePatch } from './patch-parser.ts';
export type { DiffSource, FetchedDiff } from './types.ts';
