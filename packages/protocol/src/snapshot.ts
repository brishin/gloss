import * as v from 'valibot';
import type { GlossClient } from './client.ts';
import { DiffPayloadSchema, FileContentsSchema } from './diff.ts';
import { isTerminal, type TourEvent, TourEventSchema } from './events.ts';
import { type SourceRef, SourceRefSchema, serializeRef } from './source-ref.ts';
import { StackSchema } from './stack.ts';
import { TraceSchema } from './trace.ts';

/**
 * A finished tour with everything the tour page reads from the backend, so the page can show
 * it with no backend at all (`gloss export`). The events are the job's own log, so the page
 * builds the tour with `reduceTourEvent` exactly as it does live.
 */
export const TourSnapshotSchema = v.object({
  version: v.literal(1),
  exportedAt: v.string(),
  ref: SourceRefSchema,
  jobId: v.string(),
  events: v.array(TourEventSchema),
  diffs: v.record(v.string(), DiffPayloadSchema),
  /** Whole files for expanding unchanged lines, keyed by `fileKey`; files left out stay collapsed. */
  files: v.record(v.string(), FileContentsSchema),
  trace: v.optional(TraceSchema),
  stack: v.optional(StackSchema),
  stackName: v.optional(v.string()),
  /** PR body attachments as `data:` URLs, keyed by their GitHub URL. */
  assets: v.record(v.string(), v.string()),
});
export type TourSnapshot = v.InferOutput<typeof TourSnapshotSchema>;

export const fileKey = (diffId: string, fileId: string): string => `${diffId}/${fileId}`;

export interface SnapshotLimits {
  /** Whole-file contents kept in all, in characters; files past it stay collapsed. */
  fileChars: number;
  /** Bytes kept per PR body attachment. */
  assetBytes: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = { fileChars: 4_000_000, assetBytes: 2_000_000 };

export interface CaptureOptions {
  force?: boolean;
  limits?: Partial<SnapshotLimits>;
  onEvent?: (event: TourEvent) => void;
  /** Loads a resolved attachment URL (the backend's `asset`); defaults to `fetch`. */
  fetch?: typeof fetch;
}

const ATTACHMENT_URL = /https:\/\/github\.com\/[^\s"'<>()[\]]+/g;

/** Runs (or replays) the tour for `ref` on a backend and reads everything its page needs. */
export async function captureTourSnapshot(
  client: GlossClient,
  ref: SourceRef,
  options: CaptureOptions = {},
): Promise<TourSnapshot> {
  const limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...options.limits };
  const { jobId } = await client.startTour(ref, { force: options.force });
  const events: TourEvent[] = [];
  for await (const event of client.events(jobId)) {
    events.push(event);
    options.onEvent?.(event);
    if (isTerminal(event)) break;
  }
  const last = events.at(-1);
  if (last?.type !== 'tour.complete') {
    const reason = last?.type === 'job.error' ? `: ${last.message}` : '';
    throw new Error(`The tour did not finish${reason}`);
  }

  // A tour replayed from the cache sends no `diff.ready`, so its own diff id counts too.
  const diffIds = new Set(events.flatMap((event) => (event.type === 'diff.ready' ? [event.diffId] : [])));
  diffIds.add(last.tour.diffId);
  const diffs: TourSnapshot['diffs'] = {};
  for (const diffId of diffIds) {
    diffs[diffId] = await client.diff(diffId);
  }

  const files: TourSnapshot['files'] = {};
  let chars = 0;
  for (const diff of Object.values(diffs)) {
    for (const file of diff.files) {
      const contents = await client.fileContents(diff.id, file.id).catch(() => undefined);
      const size = contents ? contents.oldContents.length + contents.newContents.length : 0;
      if (contents && chars + size <= limits.fileChars) {
        files[fileKey(diff.id, file.id)] = contents;
        chars += size;
      }
    }
  }

  const trace = await client.trace(jobId).catch(() => undefined);
  const stack = ref.kind === 'github-pr' ? await client.stack(ref).catch(() => undefined) : undefined;
  const stackName =
    stack && stack.members.length > 1 ? await client.stackName(stack).catch(() => undefined) : undefined;

  const assets: TourSnapshot['assets'] = {};
  const load = options.fetch ?? fetch;
  const bodies = Object.values(diffs).map((diff) => diff.meta.description ?? '');
  for (const url of new Set(bodies.flatMap((body) => body.match(ATTACHMENT_URL) ?? []))) {
    const data = await client
      .asset(url)
      .then(async (asset) => {
        const response = await load(asset.url);
        if (!response.ok) return undefined;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > limits.assetBytes) return undefined;
        const type = asset.contentType ?? response.headers.get('content-type') ?? 'application/octet-stream';
        return `data:${type};base64,${toBase64(bytes)}`;
      })
      .catch(() => undefined);
    if (data) assets[url] = data;
  }

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    ref,
    jobId,
    events,
    diffs,
    files,
    trace,
    stack,
    stackName,
    assets,
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export class NotInSnapshotError extends Error {
  constructor(what: string) {
    super(`${what} is not part of this exported tour`);
    this.name = 'NotInSnapshotError';
  }
}

/**
 * A read-only backend over a snapshot: the tour replays from its log and everything else it
 * holds is served from memory. Calls that need a live backend (models, GitHub, logins) fail.
 */
export function createSnapshotGlossClient(snapshot: TourSnapshot): GlossClient {
  const missing = (what: string) => () => Promise.reject(new NotInSnapshotError(what));
  const lastSeq = snapshot.events.at(-1)?.seq ?? 0;
  const found = <A>(value: A | undefined, what: string): Promise<A> =>
    value === undefined ? Promise.reject(new NotInSnapshotError(what)) : Promise.resolve(value);
  return {
    startTour: (ref) =>
      serializeRef(ref) === serializeRef(snapshot.ref)
        ? Promise.resolve({ jobId: snapshot.jobId, state: 'complete', lastSeq })
        : Promise.reject(new NotInSnapshotError('That tour')),
    async *events(jobId, options = {}) {
      if (jobId !== snapshot.jobId) throw new NotInSnapshotError('That job');
      for (const event of snapshot.events) {
        if (event.seq > (options.after ?? 0)) yield event;
      }
    },
    abort: () => Promise.resolve(),
    // oxlint-disable-next-line require-yield
    async *ask() {
      throw new NotInSnapshotError('Ask');
    },
    diff: (diffId) => found(snapshot.diffs[diffId], 'That diff'),
    trace: (jobId) => found(jobId === snapshot.jobId ? snapshot.trace : undefined, 'The trace'),
    fileContents: (diffId, fileId) => found(snapshot.files[fileKey(diffId, fileId)], 'That file'),
    lfsObject: missing('An LFS object'),
    health: missing('Health'),
    recent: () => Promise.resolve({ tours: [] }),
    // The page picks <video> or <img> by the type, which the data: URL carries.
    asset: (url) =>
      found(snapshot.assets[url], 'That attachment').then((data) => ({
        url: data,
        contentType: /^data:([^;,]+)/.exec(data)?.[1],
      })),
    stack: (ref) => found(serializeRef(ref) === serializeRef(snapshot.ref) ? snapshot.stack : undefined, 'That stack'),
    stackName: () => found(snapshot.stackName, 'The stack name'),
    review: missing('Review'),
    startLogin: missing('Sign-in'),
    login: missing('Sign-in'),
    answerLogin: missing('Sign-in'),
    cancelLogin: () => Promise.resolve(),
    setup: missing('Setup'),
    githubLogin: missing('Setup'),
    installNativeHost: missing('Setup'),
    saveJudgeKey: missing('Setup'),
    updateStatus: () => Promise.resolve({ behind: 0 }),
    update: missing('Update'),
  };
}

/** Reads a snapshot back, for the page that embeds it. */
export const parseTourSnapshot = (input: unknown): TourSnapshot => v.parse(TourSnapshotSchema, input);
