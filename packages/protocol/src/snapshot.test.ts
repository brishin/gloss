import { describe, expect, test } from 'vitest';
import type { GlossClient } from './client.ts';
import type { DiffPayload, FileContents } from './diff.ts';
import type { TourEvent, TourEventBody } from './events.ts';
import { initialTourState, reduceTourEvent } from './reducer.ts';
import {
  captureTourSnapshot,
  createSnapshotGlossClient,
  descriptionMedia,
  fileKey,
  parseTourSnapshot,
} from './snapshot.ts';
import type { Tour } from './tour.ts';

const ref = { kind: 'github-pr' as const, owner: 'o', repo: 'r', number: 1 };
const models = { define: 'a', followup: 'a', notes: 'a' };
const meta = {
  title: 't',
  description: 'see https://github.com/user-attachments/assets/abc-1',
  baseRef: 'main',
  headRef: 'f',
  commits: [],
};
const entries = {
  path: 'a.ts',
  status: 'modified' as const,
  additions: 1,
  deletions: 0,
  isBinary: false,
  truncated: false,
};
const file = { ...entries, id: 'f1', hunkIds: [] };
const diff: DiffPayload = {
  id: 'd',
  ref,
  sourceKey: 'k',
  fingerprint: 'x',
  meta,
  files: [
    { ...entries, id: 'f1', hunks: [] },
    { ...entries, id: 'f2', path: 'b.ts', hunks: [] },
  ],
};
const tour: Tour = {
  diffId: 'd',
  ref,
  meta,
  files: [file],
  groups: [],
  placements: {},
  judgments: {},
  notes: {},
  models,
};
const bodies: TourEventBody[] = [
  { type: 'job.started', ref, sourceKey: 'k', pipelineVersion: '1', models, cached: false },
  { type: 'diff.ready', diffId: 'd', meta, files: [file] },
  { type: 'tour.summary', overallSummary: 'one' },
  { type: 'tour.complete', tour, cached: false },
];
const events: TourEvent[] = bodies.map((body, i) => ({ ...body, seq: i + 1, jobId: 'j', at: '2026-11-03T00:00:00Z' }));
const contents: Record<string, FileContents> = {
  f1: { oldContents: 'aaaa', newContents: 'bbbb' },
  f2: { oldContents: 'cccc', newContents: 'dddd' },
};

const backend = (log: TourEvent[]) =>
  ({
    startTour: async () => ({ jobId: 'j', state: 'complete', lastSeq: log.length }),
    async *events() {
      yield* log;
    },
    diff: async () => diff,
    fileContents: async (_diffId: string, fileId: string) => contents[fileId]!,
    trace: async () => ({ steps: [], done: true }),
    stack: async () => ({ owner: 'o', repo: 'r', base: 'main', members: [] }),
    asset: async (url: string) => ({ url: `${url}?signed`, contentType: 'image/png' }),
  }) as unknown as GlossClient;
const png = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;

describe('tour snapshots', () => {
  test('replay the job log so the reducer rebuilds the finished tour', async () => {
    const snapshot = parseTourSnapshot(
      JSON.parse(JSON.stringify(await captureTourSnapshot(backend(events), ref, { fetch: png }))),
    );
    const client = createSnapshotGlossClient(snapshot);
    const { jobId } = await client.startTour(ref);
    let state = initialTourState();
    for await (const event of client.events(jobId)) state = reduceTourEvent(state, event);
    expect(state.status).toBe('complete');
    expect(state.meta).toEqual(tour.meta);
    expect(await client.diff('d')).toEqual(diff);
    expect(await client.fileContents('d', 'f2')).toEqual(contents.f2);
    expect(await client.asset('https://github.com/user-attachments/assets/abc-1')).toEqual({
      url: 'data:image/png;base64,AQID',
      contentType: 'image/png',
    });
  });

  test('read the diff of a tour replayed from the cache, which sends no diff.ready', async () => {
    const cached = [events[0]!, { ...events[3]!, seq: 2 }];
    const snapshot = await captureTourSnapshot(backend(cached), ref, { fetch: png });
    expect(Object.keys(snapshot.diffs)).toEqual(['d']);
    expect(Object.keys(snapshot.files)).toHaveLength(2);
    expect(Object.keys(snapshot.assets)).toHaveLength(1);
  });

  test('find every image a description loads', () => {
    expect(
      descriptionMedia(
        'a https://github.com/user-attachments/assets/x-1 ![s](https://user-images.githubusercontent.com/1/a.png) <img width="5" src="https://example.com/b.gif">',
      ),
    ).toEqual([
      'https://github.com/user-attachments/assets/x-1',
      'https://user-images.githubusercontent.com/1/a.png',
      'https://example.com/b.gif',
    ]);
  });

  test('carry the LFS images the diff shows', async () => {
    const oid = 'a'.repeat(64);
    const image = { ...file, id: 'f3', path: 'logo.png', lfs: { new: { oid, size: 3 } } };
    const withImage = events.map((event) =>
      event.type === 'tour.complete' ? { ...event, tour: { ...event.tour, files: [file, image] } } : event,
    );
    const lfsBackend = Object.assign(backend(withImage), {
      lfsObject: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    });
    const client = createSnapshotGlossClient(await captureTourSnapshot(lfsBackend, ref, { fetch: png }));
    const blob = await client.lfsObject('d', oid);
    expect(blob.type).toBe('image/png');
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  test('keep whole files only up to the limit', async () => {
    const snapshot = await captureTourSnapshot(backend(events), ref, { fetch: png, limits: { fileChars: 8 } });
    expect(Object.keys(snapshot.files)).toEqual([fileKey('d', 'f1')]);
  });

  test('refuse a tour that did not finish', async () => {
    await expect(captureTourSnapshot(backend(events.slice(0, 3)), ref)).rejects.toThrow('did not finish');
  });

  test('serve only the tour it holds', async () => {
    const client = createSnapshotGlossClient(await captureTourSnapshot(backend(events), ref, { fetch: png }));
    await expect(client.startTour({ ...ref, number: 2 })).rejects.toThrow('not part of this exported tour');
    await expect(client.review({} as never)).rejects.toThrow('not part of this exported tour');
  });
});
