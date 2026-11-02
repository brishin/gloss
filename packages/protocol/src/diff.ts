import * as v from 'valibot';
import { SourceRefSchema } from './source-ref.ts';

export const FileStatusSchema = v.picklist(['added', 'modified', 'removed', 'renamed', 'copied']);
export type FileStatus = v.InferOutput<typeof FileStatusSchema>;

/** pierre's side vocabulary: `additions` lines are numbered by the new file, `deletions` by the old one. */
export const DiffSideSchema = v.picklist(['additions', 'deletions']);
export type DiffSide = v.InferOutput<typeof DiffSideSchema>;

export const DiffHunkSchema = v.object({
  /** Deterministic from the file and hunk content, so model output can reference it across runs. */
  id: v.string(),
  header: v.string(),
  oldStart: v.number(),
  oldLines: v.number(),
  newStart: v.number(),
  newLines: v.number(),
  /** Body lines with their ` `/`+`/`-` prefixes, joined by `\n`. */
  patch: v.string(),
});
export type DiffHunk = v.InferOutput<typeof DiffHunkSchema>;

const fileEntries = {
  id: v.string(),
  path: v.string(),
  previousPath: v.optional(v.string()),
  status: FileStatusSchema,
  additions: v.number(),
  deletions: v.number(),
  isBinary: v.boolean(),
  /** The patch was too large to keep; counts are still right. */
  truncated: v.boolean(),
  /** Set when `.gitattributes` marks the file `linguist-generated` (or `-diff`). */
  generated: v.optional(v.literal('gitattributes')),
};

export const FileChangeSchema = v.object({ ...fileEntries, hunks: v.array(DiffHunkSchema) });
export type FileChange = v.InferOutput<typeof FileChangeSchema>;

/** A Git LFS object: its sha256 and its size in bytes. */
export const LfsObjectSchema = v.object({ oid: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)), size: v.number() });
export type LfsObject = v.InferOutput<typeof LfsObjectSchema>;

/** The objects a Git LFS pointer names, per side; a side is absent when the file has none there. */
export const LfsPointerSchema = v.object({ old: v.optional(LfsObjectSchema), new: v.optional(LfsObjectSchema) });
export type LfsPointer = v.InferOutput<typeof LfsPointerSchema>;

/** A file without its hunk bodies: what the event stream carries. */
export const FileSummarySchema = v.object({
  ...fileEntries,
  hunkIds: v.array(v.string()),
  /** Set when the diff is only a Git LFS pointer: the content itself is not in the repository. */
  lfs: v.optional(LfsPointerSchema),
});
export type FileSummary = v.InferOutput<typeof FileSummarySchema>;

export const CommitSchema = v.object({ sha: v.string(), subject: v.string() });
export type Commit = v.InferOutput<typeof CommitSchema>;

export const DiffMetaSchema = v.object({
  title: v.string(),
  description: v.optional(v.string()),
  url: v.optional(v.string()),
  author: v.optional(v.string()),
  baseRef: v.string(),
  headRef: v.string(),
  baseSha: v.optional(v.string()),
  headSha: v.optional(v.string()),
  commits: v.array(CommitSchema),
});
export type DiffMeta = v.InferOutput<typeof DiffMetaSchema>;

export const DiffPayloadSchema = v.object({
  /** Content address of this diff: `sourceKey` plus `fingerprint`. */
  id: v.string(),
  ref: SourceRefSchema,
  sourceKey: v.string(),
  /** Head sha, or a hash of the diff text for a working tree. */
  fingerprint: v.string(),
  meta: DiffMetaSchema,
  files: v.array(FileChangeSchema),
});
export type DiffPayload = v.InferOutput<typeof DiffPayloadSchema>;

/** A changed file in full on both sides: what the page needs to show the unchanged lines between hunks. */
export const FileContentsSchema = v.object({ oldContents: v.string(), newContents: v.string() });
export type FileContents = v.InferOutput<typeof FileContentsSchema>;

const LFS_LINE =
  /^(?:version https:\/\/git-lfs\.github\.com\/spec\/v1|oid sha256:([0-9a-f]{64})|size (\d+)|ext-\d+-\w+ \S+)$/;

/**
 * The objects named when every changed line is a Git LFS pointer line (`version`, `oid`, `size`),
 * as git diffs a file tracked by LFS without its smudge filter. Undefined for any other file, and
 * when a side with lines is not a whole pointer, so a broken pointer's diff stays visible.
 */
export function lfsPointer(file: { hunks: readonly Pick<DiffHunk, 'patch'>[] }): LfsPointer | undefined {
  const sides = {
    old: { lines: 0, version: false, oid: undefined as string | undefined, size: undefined as number | undefined },
    new: { lines: 0, version: false, oid: undefined as string | undefined, size: undefined as number | undefined },
  };
  for (const hunk of file.hunks) {
    for (const line of hunk.patch.split('\n')) {
      if (line === '' || line.startsWith('\\')) {
        continue;
      }
      const match = LFS_LINE.exec(line.slice(1));
      if (!match) {
        return undefined;
      }
      for (const side of [line[0] !== '+' && sides.old, line[0] !== '-' && sides.new]) {
        if (side) {
          side.lines++;
          side.version ||= line.slice(1).startsWith('version ');
          side.oid = match[1] ?? side.oid;
          side.size = match[2] === undefined ? side.size : Number(match[2]);
        }
      }
    }
  }
  const pointer: LfsPointer = {};
  for (const key of ['old', 'new'] as const) {
    const { lines, version, oid, size } = sides[key];
    if (!lines) {
      continue;
    }
    if (!version || oid === undefined || size === undefined) {
      return undefined;
    }
    pointer[key] = { oid, size };
  }
  return pointer.old || pointer.new ? pointer : undefined;
}

export function summarizeFile(file: FileChange): FileSummary {
  const { hunks, ...rest } = file;
  const lfs = lfsPointer(file);
  return { ...rest, hunkIds: hunks.map((hunk) => hunk.id), ...(lfs && { lfs }) };
}
