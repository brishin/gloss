import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { DiffHunk, DiffPayload, FileChange, FileContents } from '@gloss/protocol';
import { Data } from 'effect';
import type { SearchTree } from './clone.ts';
import { git } from './exec.ts';
import { gh } from './github.ts';
import { type ImportQuery, importsQueryPath, isImportLine } from './importers.ts';

/** The file no longer reads as the diff says (an edited working tree). */
export class StaleFileError extends Data.TaggedError('StaleFileError') {
  override readonly message = 'The file has changed since the diff was read. Reload the tour to see it.';
}

/** Appends `from[start..end)` one by one: a spread overflows the call stack on a large file. */
function copy(from: readonly string[], start: number, end: number, to: string[]) {
  for (let i = start; i < end; i++) {
    to.push(from[i]!);
  }
}

/**
 * The old side of a file, rebuilt from its new side by undoing the hunks. Only the head
 * is fetched: a PR's old side is the merge base, which `base.sha` is not once the base
 * branch moves, and the patch already says exactly what changed. Throws `StaleFileError`
 * when the new side no longer matches the patch.
 */
export function reverseApply(
  newContents: string,
  hunks: readonly Pick<DiffHunk, 'newStart' | 'newLines' | 'patch'>[],
): string {
  const newLines = newContents.split('\n');
  const newEol = newLines.at(-1) === '';
  if (newEol) {
    newLines.pop();
  }
  const oldLines: string[] = [];
  // Without a marker, the end is unchanged: the old side ends like the new one.
  let oldMarker = false;
  let newMarker = false;
  let next = 0;
  for (const hunk of hunks) {
    // A hunk with no new lines names the line it follows; any other start is 1-based.
    const start = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
    if (start < next) {
      throw new StaleFileError();
    }
    copy(newLines, next, start, oldLines);
    next = start;
    let previous = '';
    for (const line of hunk.patch.split('\n')) {
      const kind = line[0];
      if (kind === '\\') {
        // "\ No newline at end of file" ends whichever side the line before it is on.
        oldMarker ||= previous !== '+';
        newMarker ||= previous !== '-';
        continue;
      }
      if (kind === '-' || kind === ' ' || line === '') {
        oldLines.push(line.slice(1));
      }
      if (kind === '+' || kind === ' ' || line === '') {
        // The file must still read as the patch says; a working tree may have moved on.
        if (newLines[next] !== line.slice(1)) {
          throw new StaleFileError();
        }
        next++;
      }
      previous = kind ?? ' ';
    }
  }
  copy(newLines, next, newLines.length, oldLines);
  const oldEol = !oldMarker && (newMarker || newEol);
  return oldLines.join('\n') + (oldEol && oldLines.length ? '\n' : '');
}

async function readHead(diff: DiffPayload, path: string, signal?: AbortSignal): Promise<string> {
  const { ref, meta } = diff;
  if (ref.kind === 'github-pr') {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return gh(
      [
        '-H',
        'Accept: application/vnd.github.raw+json',
        `repos/${ref.owner}/${ref.repo}/contents/${encoded}?ref=${encodeURIComponent(meta.headSha ?? meta.headRef)}`,
      ],
      signal,
    );
  }
  // `--textconv`: the diff ran any textconv driver, so the lines must match its output.
  if (meta.headSha) {
    return git(ref.repo, ['cat-file', '--textconv', `${meta.headSha}:${path}`], { signal });
  }
  // The working tree, through git's clean filters (CRLF, LFS) as the diff saw it, not the raw checkout.
  const blob = (await git(ref.repo, ['hash-object', '-w', '--', path], { signal })).trim();
  return git(ref.repo, ['cat-file', '--textconv', `--path=${path}`, blob], { signal });
}

/**
 * A repository path as a model may name it: relative, with no `.` or `..` segments, so a read
 * stays inside the repository. Undefined for anything else.
 */
export function repoPath(path: string): string | undefined {
  const trimmed = path.trim().replace(/^\.\//, '');
  const segments = trimmed.split('/');
  if (
    !trimmed ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('-') ||
    /[\0\\:]/.test(trimmed) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  return trimmed;
}

/**
 * Any file of the repository as it reads at the diff's head, changed or not, for a model that
 * needs code the diff does not show. `path` must already be a `repoPath`. Only a changed file is
 * read from a working tree; any other file reads as HEAD, which a working-tree diff starts from,
 * so a read never leaves git's tree.
 */
export async function readRepoFile(diff: DiffPayload, path: string, signal?: AbortSignal): Promise<string> {
  const { ref, meta } = diff;
  const changed = diff.files.some((file) => file.path === path && file.status !== 'removed');
  if (ref.kind === 'local' && !meta.headSha) {
    if (!changed) {
      return git(ref.repo, ['cat-file', '--textconv', `HEAD:${path}`], { signal });
    }
    // The working tree follows symlinks; a changed link reads as its target path, as git stores it,
    // and nothing outside the repository is read.
    const full = join(ref.repo, path);
    if ((await lstat(full)).isSymbolicLink()) {
      return readlink(full);
    }
    const [root, real] = await Promise.all([realpath(ref.repo), realpath(full)]);
    if (!real.startsWith(root + sep)) {
      throw new Error(`${path} is outside the repository`);
    }
  }
  return readHead(diff, path, signal);
}

/**
 * Both sides of a changed file in full, so the page can show the unchanged lines between
 * hunks, and Ask can read the whole file. A file with no hunks (renamed or mode change only) reads
 * the same on both sides. Undefined for files whose sides the diff cannot rebuild: added, removed,
 * binary, truncated.
 */
export async function readFileContents(
  diff: DiffPayload,
  file: FileChange,
  signal?: AbortSignal,
): Promise<FileContents | undefined> {
  if (file.status === 'added' || file.status === 'removed' || file.isBinary || file.truncated) {
    return undefined;
  }
  const newContents = await readHead(diff, file.path, signal);
  return { oldContents: reverseApply(newContents, file.hunks), newContents };
}

/** Lines one search returns; the model narrows the pattern or the path for more. */
const SEARCH_LINES = 40;

interface CodeSearchItem {
  path: string;
  text_matches?: { fragment: string }[];
}

/** Lines of `git grep` output in `tree`, with the commit prefix dropped; none when nothing matches. */
async function grepTree(tree: SearchTree, args: readonly string[], paths: readonly string[], signal?: AbortSignal) {
  let out: string;
  try {
    out = await git(
      tree.cwd,
      // Unquoted paths: `src/écran.ts`, not `"src/\303\251cran.ts"`.
      [
        '-c',
        'core.quotePath=false',
        'grep',
        '-n',
        '-I',
        ...args,
        ...(tree.rev ? [tree.rev] : ['--untracked']),
        '--',
        ...paths,
      ],
      {
        signal,
      },
    );
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { code?: unknown }).code === 1) {
      return [];
    }
    throw error;
  }
  const prefix = tree.rev ? `${tree.rev}:` : '';
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => (prefix && line.startsWith(prefix) ? line.slice(prefix.length) : line));
}

/** GitHub's code search for a fixed string, as `path: text`; it indexes the default branch only. */
async function githubSearch(
  ref: { owner: string; repo: string },
  pattern: string,
  path: string | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  const terms = [
    `"${pattern.replaceAll('"', ' ')}"`,
    `repo:${ref.owner}/${ref.repo}`,
    ...(path ? [`path:${path}`] : []),
  ];
  const result = JSON.parse(
    await gh(
      [
        '-X',
        'GET',
        'search/code',
        '-H',
        'Accept: application/vnd.github.text-match+json',
        '-f',
        `q=${terms.join(' ')}`,
        '-f',
        'per_page=30',
      ],
      signal,
    ),
  ) as { items?: CodeSearchItem[] };
  const lines: string[] = [];
  for (const item of result.items ?? []) {
    const hits = (item.text_matches ?? [])
      .flatMap((match) => match.fragment.split('\n'))
      .filter((line) => line.includes(pattern));
    lines.push(...(hits.length ? hits.slice(0, 3).map((line) => `${item.path}: ${line.trim()}`) : [item.path]));
  }
  return lines;
}

/**
 * Where a fixed string appears in the repository at the diff's head, as `path:line: text`. A local
 * diff greps its head (or its working tree, untracked files too); a PR greps a shallow clone of its
 * head (`RepoClones`), or asks GitHub's code search (`path: text`, default branch only) when the
 * clone cannot be fetched (`tree` undefined). `path` limits it to a directory, already a `repoPath`.
 */
export async function searchRepo(
  diff: DiffPayload,
  tree: SearchTree | undefined,
  pattern: string,
  path: string | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!tree) {
    if (diff.ref.kind !== 'github-pr') {
      return [];
    }
    return (await githubSearch(diff.ref, pattern, path, signal)).slice(0, SEARCH_LINES);
  }
  return (await grepTree(tree, ['-F', '--max-count=5', '-e', pattern], path ? [path] : [], signal)).slice(
    0,
    SEARCH_LINES,
  );
}

/**
 * The files that import what `query` names, as `path:line: text`, outside the files the diff
 * changes. Grepped like `searchRepo`; without a tree, GitHub's code search for the bare name, keeping
 * the import lines (it matches any file of that name, so it is a guess).
 */
export async function findImporters(
  diff: DiffPayload,
  tree: SearchTree | undefined,
  query: ImportQuery,
  signal?: AbortSignal,
): Promise<string[]> {
  const changed = new Set(diff.files.map((file) => file.path));
  const outside = (line: string) => !changed.has(line.slice(0, line.indexOf(':')));
  // Same-named files elsewhere (another app's RichTextEditor) are not importers of this one.
  const pointsAt = (line: string) => importsQueryPath(line.slice(0, line.indexOf(':')), line, query);
  if (!tree) {
    if (diff.ref.kind !== 'github-pr') {
      return [];
    }
    const lines = await githubSearch(diff.ref, query.term, undefined, signal);
    return onePerFile(lines.filter((line) => isImportLine(line, query) && outside(line) && pointsAt(line))).slice(
      0,
      SEARCH_LINES,
    );
  }
  const words = ['import', 'from', 'require', 'export'].flatMap((word) => ['-e', word]);
  const args = [
    // Every matching line, not one per file: a file may import a namesake before the real one.
    '-F',
    '(',
    ...query.needles.flatMap((needle) => ['-e', needle]),
    ')',
    '--and',
    '(',
    ...words,
    ')',
  ];
  return onePerFile((await grepTree(tree, args, [], signal)).filter((line) => outside(line) && pointsAt(line))).slice(
    0,
    SEARCH_LINES,
  );
}

/** The first line of each file, in order. */
function onePerFile(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const path = line.slice(0, line.indexOf(':'));
    return !seen.has(path) && seen.add(path);
  });
}

/** A file as it reads in the tour's search tree; undefined when there is no tree or no such file. */
export async function readTreeFile(
  tree: SearchTree | undefined,
  path: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!tree) {
    return undefined;
  }
  try {
    return tree.rev
      ? await git(tree.cwd, ['show', `${tree.rev}:${path}`], { signal })
      : await readFile(join(tree.cwd, path), 'utf8');
  } catch {
    return undefined;
  }
}
