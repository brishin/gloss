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

/** A Git LFS pointer's object sizes in bytes, per side; a side is absent when the file has none there. */
export const LfsSizesSchema = v.object({ oldSize: v.optional(v.number()), newSize: v.optional(v.number()) });
export type LfsSizes = v.InferOutput<typeof LfsSizesSchema>;

/** A file without its hunk bodies: what the event stream carries. */
export const FileSummarySchema = v.object({
  ...fileEntries,
  hunkIds: v.array(v.string()),
  /** Set when the diff is only a Git LFS pointer: the content itself is not in the repository. */
  lfs: v.optional(LfsSizesSchema),
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
  /^(?:version https:\/\/git-lfs\.github\.com\/spec\/v1|oid sha256:[0-9a-f]{64}|size (\d+)|ext-\d+-\w+ \S+)$/;

/**
 * The object sizes when every changed line is a Git LFS pointer line (`version`, `oid`, `size`),
 * as git diffs a file tracked by LFS without its smudge filter. Undefined for any other file.
 */
export function lfsPointer(file: { hunks: readonly Pick<DiffHunk, 'patch'>[] }): LfsSizes | undefined {
  let version = false;
  let oldSize: number | undefined;
  let newSize: number | undefined;
  for (const hunk of file.hunks) {
    for (const line of hunk.patch.split('\n')) {
      if (line === '' || line.startsWith('\\')) {
        continue;
      }
      const match = LFS_LINE.exec(line.slice(1));
      if (!match) {
        return undefined;
      }
      version ||= line.slice(1).startsWith('version ');
      if (match[1] !== undefined) {
        const size = Number(match[1]);
        if (line[0] !== '+') {
          oldSize = size;
        }
        if (line[0] !== '-') {
          newSize = size;
        }
      }
    }
  }
  return version ? { oldSize, newSize } : undefined;
}

export function summarizeFile(file: FileChange): FileSummary {
  const { hunks, ...rest } = file;
  const lfs = lfsPointer(file);
  return { ...rest, hunkIds: hunks.map((hunk) => hunk.id), ...(lfs && { lfs }) };
}
