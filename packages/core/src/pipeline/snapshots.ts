import type { FileChange } from '@gloss/protocol';
import { isAgentGuidance, isDocumentation } from './guidance.ts';
import { looksLikeConfig, looksLikeTest } from './heuristics.ts';

/**
 * Folders snapshot tests write to: `__snapshots__` (Jest, Vitest, syrupy), `__Snapshots__`
 * (swift-snapshot-testing), `__screenshots__`, Playwright's `<spec>-snapshots`, and `snapshots`
 * with an optional suffix (`snapshots-dark`).
 */
const SNAPSHOT_DIR_RE = /^(__snapshots__|__screenshots__|snapshots([-_][a-z0-9]+)*)$|-snapshots$/i;

/** Source code, which a plain `snapshots` folder can hold too (scripts that record snapshots, and their docs). */
const CODE_RE = /\.(m?[jt]sx?|cjs|py|swift|kt|java|go|rs|rb|sh|php|cs|dart)$/i;

/** A file a snapshot test wrote: a picture or text record of what some code draws or produces. */
export function isSnapshot(path: string): boolean {
  if (/\.snap$/i.test(path)) {
    return true;
  }
  return (
    !CODE_RE.test(path) &&
    !isDocumentation(path) &&
    !isAgentGuidance(path) &&
    path
      .split('/')
      .slice(0, -1)
      .some((part) => SNAPSHOT_DIR_RE.test(part))
  );
}

/** `BentoAddToCollection.stories.tsx` and `bento_add_to_collection.py` both give `bentoaddtocollection`. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A name without test words: `test_render__dark` -> `render`, `CardViewSnapshotTests` -> `CardView`. */
function bare(name: string): string {
  return name
    .split('.')[0]!
    .replace(/^test_/i, '')
    .split('__')[0]!
    .replace(/(Snapshots?|Screenshots?|_snapshots?|_screenshots?)?(Tests?|_tests?)?$/, '');
}

/**
 * The names a snapshot is recorded under: the folder it sits in, when that is below the snapshot
 * folder (a component, test class or test module), then its file name (a story, test or state).
 * `snapshots/sessions/BentoAddToCollection/applied.png` gives `BentoAddToCollection`, `applied`;
 * folders further up only sort snapshots by area. A Playwright folder names its spec.
 */
export function snapshotNames(path: string): string[] {
  const parts = path.split('/');
  const root = parts.slice(0, -1).findLastIndex((part) => SNAPSHOT_DIR_RE.test(part));
  const folder = root >= 0 && root < parts.length - 2 ? [parts.at(-2)!] : [];
  const spec = root >= 0 && /-snapshots$/i.test(parts[root]!) ? [parts[root]!] : [];
  return [...folder, ...spec, parts.at(-1)!].map((name) => normalize(bare(name))).filter((name) => name.length >= 3);
}

/**
 * Same name, or one starts or ends the other with a short difference: `SessionMessageRow` /
 * `SessionMessageRows`, `CompactCaptureCard` / `SharedCompactCaptureCard`.
 */
function sameSubject(name: string, stem: string): boolean {
  if (name === stem) {
    return true;
  }
  const [short, long] = name.length < stem.length ? [name, stem] : [stem, name];
  return short.length >= 6 && (long.startsWith(short) || long.endsWith(short)) && short.length >= long.length * 0.75;
}

function sharedFolders(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');
  let shared = 0;
  while (shared < left.length - 1 && left[shared] === right[shared]) {
    shared++;
  }
  return shared;
}

/**
 * The changed files each snapshot captures, by name. The nearest name with a match wins, and of
 * its matches only those nearest the snapshot in the tree (the same component on another
 * platform is a twin, not the subject). Code files come first, so a snapshot reads with the code
 * that draws it rather than the story or test that renders it; a story or test is the subject only
 * when no code file has the name. Docs, config, manifests and other snapshots never are. A snapshot with no subject
 * is left out.
 */
export function snapshotSubjects(files: readonly FileChange[]): Record<string, string[]> {
  const candidates = files
    .filter(
      (file) =>
        !isSnapshot(file.path) &&
        !isAgentGuidance(file.path) &&
        !isDocumentation(file.path) &&
        !looksLikeConfig(file.path),
    )
    .map((file) => ({
      id: file.id,
      path: file.path,
      // A component folder names its files too: `CompactCollectionCard/platformStyles.ts`.
      stems: [file.path.split('/').at(-2) ?? '', file.path.split('/').at(-1)!].map((name) => normalize(bare(name))),
    }));
  const code = candidates.filter((candidate) => !looksLikeTest(candidate.path));
  const subjects: Record<string, string[]> = {};
  for (const file of files) {
    if (!isSnapshot(file.path)) {
      continue;
    }
    const names = snapshotNames(file.path);
    const matches =
      firstMatch(names, code) ??
      firstMatch(
        names,
        candidates.filter((candidate) => looksLikeTest(candidate.path)),
      );
    if (matches) {
      const near = Math.max(...matches.map((candidate) => sharedFolders(file.path, candidate.path)));
      subjects[file.id] = matches
        .filter((candidate) => sharedFolders(file.path, candidate.path) === near)
        .map((candidate) => candidate.id);
    }
  }
  return subjects;
}

/** File names first, then the folders files sit in; within each, the longest (most specific) snapshot name first. */
function firstMatch<T extends { stems: string[] }>(
  names: readonly string[],
  candidates: readonly T[],
): T[] | undefined {
  const specific = names.toSorted((a, b) => b.length - a.length);
  for (const level of [1, 0]) {
    for (const name of specific) {
      const matches = candidates.filter((candidate) => sameSubject(name, candidate.stems[level]!));
      if (matches.length) {
        return matches;
      }
    }
  }
  return undefined;
}
