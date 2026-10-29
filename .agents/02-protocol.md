# Protocol

`packages/protocol` is the whole contract between frontend and backend.

- `POST /api/tours {ref, force?}` → `202 {jobId, state, lastSeq}`. A running job for the
  same `serializeRef(ref)` is reused (two tabs, or the CLI pre-starting a tour before
  the page loads). `force` replaces it and skips cache reads.
- `GET /api/tours/:id/events` → SSE (`id: seq`, `event: type`, `data: envelope`) or
  NDJSON with `Accept: application/x-ndjson`. Resumes after `Last-Event-ID` or
  `?after=`. Replays the log, then streams live, `: ping` every 15 s, closes after a
  terminal event (`tour.complete`, fatal `job.error`, `job.aborted`).
- `POST /api/tours/:id/abort`, `GET /api/diffs/:diffId` (hunk bodies, kept out of the
  event log), `GET /api/health`, `GET /api/recent`.

Events (`events.ts`), in the order a fresh tour emits them: `job.started`,
`stage.status`, `diff.ready`, `groups.provisional`, then `group.defined` (one per
group) + `tour.summary` + `groups.defined`, with `file.judged` (one or two per file)
interleaved, then `placement` (per file), `groups.resolved`, `group.notes` (per
group), `tour.complete`. A cache hit is `job.started` then `tour.complete`.

The client parses every event with valibot. It retries only network errors and 5xx,
because a malformed event is a protocol bug and should fail loudly.

Decisions are choices a reviewer should agree with on purpose, each one sentence with a
Linear-style priority. Change-wide ones ride on `tour.summary` (and `Tour.decisions`);
ones in code ride on `group.notes` as `notes.decisions`, with `fileId` and, when the line
is visible, `hunkId`/`side`/`line`.

The tour's visual rides on `tour.summary` (and `Tour.visual`): at most one picture of the
main decision, as data the client draws. `before-after` is two small Mermaid diagrams
(the old flow next to the new; never rows of text, which only restate the summary), `timeline`
is lanes of spans on a shared 0-100 axis with optional markers and an outcome per lane,
and `mermaid` is a flowchart or state diagram rendered with beautiful-mermaid. Never
model-written SVG or HTML. With Jev, `tour.summary` is sent twice: first without the
visual, then with Jev's pick (or none); the reducer keeps the later one.

Change rules: adding an optional field is compatible. A new event type fails
validation in older clients, so prefer an optional field on an existing event. Bump
`PIPELINE_VERSION` when the same inputs can produce different output.
