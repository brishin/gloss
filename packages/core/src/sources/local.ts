import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Commit, SourceRef } from '@gloss/protocol';
import { sha256 } from '../hash.ts';
import { git, tryGit } from './exec.ts';
import { assignIds, parsePatch, type ParsedFile } from './patch-parser.ts';
import type { DiffSource, FetchedDiff } from './types.ts';

/** Pinned so the parser always reads the same shape: no colors, no external tools, plain prefixes. */
const DIFF_ARGS = [
  '-c',
  'core.quotePath=false',
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--full-index',
  '-M',
];
/** A file's patch past this is dropped to its counts. */
const MAX_PATCH_BYTES = 512 * 1024;

type LocalTarget =
  | { kind: 'worktree' }
  | { kind: 'commit'; rev: string }
  | { kind: 'range'; base: string; head: string; mergeBase: boolean };

function revision(rev: string, target: string): string {
  // Passed to git as an argument: never let a revision read as an option.
  if (rev.startsWith('-')) {
    throw new Error(`Invalid revision in target "${target}".`);
  }
  return rev || 'HEAD';
}

/** `''` is the working tree, `A...B` a merge-base range, `A..B` a tree diff, anything else one commit. */
export function parseLocalTarget(target: string): LocalTarget {
  const text = target.trim();
  if (!text) {
    return { kind: 'worktree' };
  }
  for (const [separator, mergeBase] of [
    ['...', true],
    ['..', false],
  ] as const) {
    const at = text.indexOf(separator);
    if (at !== -1) {
      return {
        kind: 'range',
        base: revision(text.slice(0, at), target),
        head: revision(text.slice(at + separator.length), target),
        mergeBase,
      };
    }
  }
  return { kind: 'commit', rev: revision(text, target) };
}

interface Resolved {
  base: string;
  /** `undefined` for the working tree. */
  head?: string;
  title: string;
  commits: Commit[];
}

const revParse = async (root: string, rev: string) =>
  (await git(root, ['rev-parse', '--verify', `${rev}^{commit}`])).trim();

const emptyTree = async (root: string) => (await git(root, ['hash-object', '-t', 'tree', devNull])).trim();

async function commitsBetween(root: string, range: string[]): Promise<Commit[]> {
  const log = await git(root, ['log', '--reverse', '--format=%H%x00%s%x1e', ...range, '--']);
  return log
    .split('\x1E')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha = '', subject = ''] = entry.split('\0');
      return { sha, subject };
    });
}

async function resolveTarget(root: string, target: LocalTarget, text: string): Promise<Resolved> {
  switch (target.kind) {
    case 'worktree': {
      const head = await tryGit(root, ['rev-parse', '--verify', '-q', 'HEAD']);
      return { base: head?.trim() || (await emptyTree(root)), title: 'Working tree changes', commits: [] };
    }
    case 'commit': {
      const sha = await revParse(root, target.rev);
      const parent = (await tryGit(root, ['rev-parse', '--verify', '-q', `${sha}^`]))?.trim();
      const commits = await commitsBetween(root, ['-1', sha]);
      return { base: parent || (await emptyTree(root)), head: sha, title: commits[0]?.subject ?? text, commits };
    }
    case 'range': {
      const head = await revParse(root, target.head);
      const base = target.mergeBase
        ? (await git(root, ['merge-base', await revParse(root, target.base), head])).trim()
        : await revParse(root, target.base);
      const commits = await commitsBetween(root, [`${base}..${head}`]);
      const title =
        commits.length === 1 ? commits[0]!.subject : `${target.base}${target.mergeBase ? '...' : '..'}${target.head}`;
      return { base, head, title, commits };
    }
  }
}

/** The working tree against `base`, untracked files included via a throwaway index (the user's index is untouched). */
async function worktreeDiff(root: string, base: string, signal?: AbortSignal): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gloss-'));
  try {
    const index = join(dir, 'index');
    const realIndex = resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).trim());
    await copyFile(realIndex, index).catch(() => {});
    const env = { GIT_INDEX_FILE: index };
    await git(root, ['add', '--intent-to-add', '--', '.'], { env, signal });
    return await git(root, [...DIFF_ARGS, base, '--'], { env, signal });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function truncateLarge(files: ParsedFile[]): ParsedFile[] {
  return files.map((file) =>
    file.hunks.reduce((sum, hunk) => sum + hunk.patch.length, 0) > MAX_PATCH_BYTES
      ? { ...file, hunks: [], truncated: true }
      : file,
  );
}

/** Paths `.gitattributes` marks generated, as git itself resolves them at `source` (or the working tree). */
async function generatedPaths(root: string, paths: string[], source?: string): Promise<Set<string>> {
  if (paths.length === 0) {
    return new Set();
  }
  const args = ['check-attr', '-z', '--stdin', ...(source ? [`--source=${source}`] : []), 'linguist-generated', 'diff'];
  const out = await tryGit(root, args, { input: paths.join('\0') });
  const generated = new Set<string>();
  if (!out) {
    return generated;
  }
  const parts = out.split('\0');
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const [path, attr, value] = [parts[i]!, parts[i + 1]!, parts[i + 2]!];
    if (
      (attr === 'linguist-generated' && (value === 'set' || value === 'true')) ||
      (attr === 'diff' && value === 'unset')
    ) {
      generated.add(path);
    }
  }
  return generated;
}

export function createLocalSource(ref: Extract<SourceRef, { kind: 'local' }>): DiffSource {
  const parsed = parseLocalTarget(ref.target);
  const root = ref.repo;

  async function diffText(resolved: Resolved, signal?: AbortSignal): Promise<string> {
    return resolved.head
      ? git(root, [...DIFF_ARGS, resolved.base, resolved.head, '--'], { signal })
      : worktreeDiff(root, resolved.base, signal);
  }

  return {
    ref,
    async fingerprint(signal) {
      const resolved = await resolveTarget(root, parsed, ref.target);
      // The base is part of a working-tree fingerprint: a new commit can leave the diff text unchanged.
      return (
        resolved.head ?? `worktree:${sha256(`${resolved.base}\n${await diffText(resolved, signal)}`).slice(0, 16)}`
      );
    },
    async fetch(signal): Promise<FetchedDiff> {
      const resolved = await resolveTarget(root, parsed, ref.target);
      const parsedFiles = truncateLarge(parsePatch(await diffText(resolved, signal)));
      const generated = await generatedPaths(
        root,
        parsedFiles.map((file) => file.path),
        resolved.head,
      );
      const files = assignIds(parsedFiles).map((file) =>
        generated.has(file.path) ? { ...file, generated: 'gitattributes' as const } : file,
      );
      const branch = (await tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
      return {
        meta: {
          title: resolved.title,
          baseRef: parsed.kind === 'range' ? parsed.base : resolved.base.slice(0, 7),
          headRef:
            parsed.kind === 'range'
              ? parsed.head
              : parsed.kind === 'commit'
                ? parsed.rev
                : `${branch ?? 'HEAD'} (working tree)`,
          baseSha: resolved.base,
          headSha: resolved.head,
          commits: resolved.commits,
        },
        files,
      };
    },
  };
}

/** The repository root containing `cwd`. */
export async function findRepoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

/**
 * What `gloss` with no target means in a checkout: uncommitted changes when there are any,
 * else the current branch against the default branch's merge base.
 */
export async function defaultLocalTarget(root: string): Promise<string> {
  const status = await git(root, ['status', '--porcelain']);
  if (status.trim()) {
    return '';
  }
  const remoteHead = (await tryGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.trim();
  for (const base of [remoteHead, 'origin/main', 'main', 'origin/master', 'master']) {
    if (base && (await tryGit(root, ['rev-parse', '--verify', '-q', base]))) {
      return `${base}...HEAD`;
    }
  }
  return 'HEAD';
}
