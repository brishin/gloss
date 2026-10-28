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

/** A file without its hunk bodies: what the event stream carries. */
export const FileSummarySchema = v.object({ ...fileEntries, hunkIds: v.array(v.string()) });
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

export function summarizeFile(file: FileChange): FileSummary {
  const { hunks, ...rest } = file;
  return { ...rest, hunkIds: hunks.map((hunk) => hunk.id) };
}
