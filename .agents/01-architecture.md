# Architecture

```
browser (apps/web, SPA)  ──HTTP+SSE──▶  gloss server (packages/server, Hono)
                                          │ JobManager: one job per ref, replay log, abort
                                          ▼
                                       runTour (packages/core)
                                          ├─ DiffSource: gh api / git
                                          ├─ JudgeClient: Jev via pi-ai classify   (packages/models)
                                          ├─ ModelClient: Flue GlossStage agent     (packages/models)
                                          └─ CacheStore: node:sqlite ~/.gloss/cache.sqlite
```

- The CLI (`packages/cli`) builds the backend (`createBackend`) and serves the API and
  the built web shell from one port (default 4777), injecting `window.__GLOSS__ = { backendUrl: '' }`.
- The web app is TanStack Start in SPA mode: the backend is a separate API, so a hosted
  frontend or a remote backend only changes `backendUrl` (plus `token` for bearer auth,
  `GLOSS_TOKEN` on the server, `GLOSS_CORS_ORIGINS` for cross-origin frontends).
- Astryx is used via its prebuilt CSS/JS (`@astryxdesign/core/astryx.css`,
  `@astryxdesign/theme-neutral/built`); app layout CSS uses Astryx tokens in
  `apps/web/src/styles.css` (`@layer product`). A StyleX source build
  (`@astryxdesign/build/vite`) is possible later if product code needs `stylex.create`.
- Diffs render with `@pierre/diffs` `FileDiff`; line notes are `lineAnnotations` with
  arrays memoized per file so pierre keeps measured heights.

Remote-backend checklist (not done): persistent job store if the server restarts,
per-user cache scoping, auth beyond a shared token, `gh` credentials on the server.
