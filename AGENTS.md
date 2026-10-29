# gloss

Streaming, annotated review tours for pull requests and local diffs. A local backend
runs the pipeline (git/gh → Jev + LLM via Flue → per-group notes) and streams typed
events; the web app renders them as they land. Source and tests win over these docs.

## Map

- `packages/protocol`: wire contract (valibot schemas, `TourEvent`, `reduceTourEvent`, SSE codec, HTTP `GlossClient`). Browser + Node.
- `packages/core`: diff sources (`gh`, local git), heuristics, Jev questions, prompts, truth table, normalizer, orchestrator (`runTour`, an Effect `Stream`), cache. Node only, Effect but no model SDK imports.
- `packages/models`: the only pi-ai/Flue importer: OAuth credential store, provider registry, `GlossStage` Flue agent, `FlueModelClient`, Jev client, config.
- `packages/server`: Hono API + `Jobs` service (dedupe, replay log, abort; each job is a fiber).
- `packages/cli`: `gloss` bin: serves API + built web app, `tour`, `login`, `status`.
- `apps/web`: TanStack Start (SPA mode) + Astryx (prebuilt CSS) + `@pierre/diffs`. The tour page is an Elm program on Effect Atom (`lib/tour-model.ts` pure update, `lib/tour-program.ts` commands, `lib/tea.ts` runtime).
- `.agents/`: goal, architecture, protocol, pipeline and model notes. Read the relevant one before changing an area.

## Invariants

- MUST: inference runs only on the backend. The web app talks to the backend only through `GlossClient` (HTTP + SSE), so a remote backend is a base URL + bearer token away.
- MUST: `reduceTourEvent` is the only interpretation of events. `tour.complete.tour` is built from the reducer, so a replayed log always equals the final tour.
- MUST: every file ends in exactly one group at every stage (`place.ts`, `groupsInOrder`). Never drop a file.
- MUST: only fetched diffs and model/Jev output are cached; never heuristics or errors. Cache keys hash the exact request (prompt text, model, `PROMPTS_VERSION`/`QUESTIONS_VERSION`/`PIPELINE_VERSION`).
- MUST: model output is untrusted. It references `fileId`/`hunkId`; `normalize.ts` validates lines and demotes invalid line notes to file notes.
- MUST: `packages/core` stays free of pi-ai/Flue; model access goes through the `ModelClient`/`JudgeClient` services (fakes in `adapters/fake.ts`).
- MUST: business logic is Effect: services via `Context.Service` + layers, cancellation by interruption (no `AbortSignal` plumbing), concurrency via `Effect.forEach`/`Semaphore`.
- MUST: the tour page's state changes only in `update` (`tour-model.ts`); side effects (backend, URL, scrolling, storage, title) are `Cmd`s. Other backend reads are plain `AsyncResult` atoms in `lib/client.ts`.
- SHOULD: source is TypeScript run directly by Node 24 (type stripping): erasable syntax only, relative imports end in `.ts`.
- SHOULD: tests sit next to the code (`foo.test.ts`) and are high-signal: truth tables, invariants, protocol round-trips. No component snapshot tests.

## Commands

```bash
pnpm install
vp check --fix          # format, lint, type-check
vp test                 # all tests
pnpm --filter @gloss/web build
node packages/cli/src/bin.ts --help
```

Dev loop: `node packages/cli/src/bin.ts serve` (API on :4777) and `pnpm --filter @gloss/web dev` (web on :4778, talks to :4777).
