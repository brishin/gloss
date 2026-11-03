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
- `GET /api/tours/:id/trace` → `Trace` (`trace.ts`): the job's pipeline steps for the
  debug view. Each step names its `inputs` (the DAG's edges), its prompt with `sections`
  saying which input step each part came from, and its raw output. Kept out of the event
  log because prompts are large; the web app fetches it again as events settle.
- `GET /api/stack?owner&repo&number` → `Stack` (walked fresh each time). `POST /api/stack/name`
  with a `Stack` of two or more PRs → `{name}`: the side rail's name for it, from the `small`
  tier (Haiku by default) reading titles, head branches and description blurbs, never diffs. Cached
  under the exact prompt, which leaves out states and authors, so a merge keeps the name.

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
`mermaid` is a flowchart or state diagram rendered with beautiful-mermaid, and `svg` is a
model-drawn picture that passed the backend's allowlist sanitizer, shown only as an
`<img>`. Never model-written HTML. With Jev, `tour.summary` is sent twice: first without the
visual, then with Jev's pick (or none); the reducer keeps the later one.
`tour.walkthrough` (and `Tour.walkthrough`) follows when code in the diff shows any change-wide decision:
one entry per such decision (`decision` indexes `Tour.decisions`) with `title`, `why`, `instead?`, `check?`,
1-3 `snippets` (a hunk slice `{fileId, hunkId, from, to}` on new-side lines plus `focus`, `caption`, `note?`),
an optional `tree` of rows (`call`, a `CallFrame`, or `concept`, a label; `snippet` hangs one under the row),
`refs` and `links` (to other decision indexes). The web app shows it as a read-only section between the
overview and the groups, and the overview's decision rows it covers link there.

**Ask** (`ask.ts`): `POST /api/ask` takes `{ tour, question, context?, history }` and answers as
SSE `AskEvent`s (`ask.delta`, `ask.tool`, then `ask.done { model, refs }` or `ask.failed`);
`reduceAskEvent` is the only interpretation. The backend keeps no thread: the client sends the
finished tour and the answered turns, and the backend reads the diff from its cache by
`tour.diffId`. Closing the request stops the model. Answers cite lines as `[label](fileId:line)`
(`fileId:-line` for removed lines); `refs` lists only the citations `citedRefs` found in the diff,
and the web app links only those. Threads are saved per diff in the browser (`gloss.ask.<diffId>`).

Change rules: adding an optional field is compatible. A new event type fails
validation in older clients, so prefer an optional field on an existing event. Bump
`PIPELINE_VERSION` when the same inputs can produce different output.
