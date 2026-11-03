# Models (`packages/models`)

- **Flue** (`@flue/runtime` 2.3) runs in-process: `ensureFlueRuntime()` calls
  `start({ agents: [GlossStage], providers })` once per process with an in-memory DB.
  Each `ModelClient.prompt` is a fresh `GlossStage` conversation (`init` → `dispatch`
  → `read`). The stage's model answers by calling `submit`, whose input schema is the
  stage's valibot schema. `submit` writes the `result` data part and terminates the
  turn. `useAgentFinish` reminds a model that answered in prose, at most twice.
  Schemas are passed by id through `stageSchemas` because `initialData` must be JSON.
- **Ask**: `ModelClient.chat` runs the `GlossAsk` agent (`ask-agent.ts`), a fresh prose
  conversation on the model the reader picked from `config.ask` (thinking from the `define` tier).
  `ask.models` defaults to the notes tier's provider profile, fast to strong, starting on the mid
  model (Claude Sonnet, GPT Sol); `~/.gloss/config.json` can set `ask: { models, default }`. Its tools
  come from the request by id (`askTools`), like stage schemas; today only `read_file`
  (`runAsk` in `packages/core/src/pipeline/ask.ts`, through `Repos.contents`). Text and tool
  calls stream to `onEvent` from Flue's `message-delta` / `tool-input` / `tool-output` chunks.
- **Auth**: gloss owns a pi-ai `Models` registry (`registry.ts`) with a
  `FileCredentialStore` at `~/.gloss/auth.json`. `gloss login claude|chatgpt` runs
  `models.login(provider, 'oauth', …)`. Flue gets `bridgedProviders()`: each provider
  is re-registered with `auth.apiKey.resolve = () => models.getAuth(id)`, so OAuth
  refresh happens under gloss's store lock. pi-ai detects subscription tokens by shape
  (`sk-ant-oat…` for Anthropic, Sign in with ChatGPT tokens for OpenAI Responses), so
  the bridged path behaves like native OAuth. `providerStatus` (in `/api/health`) tags each
  provider that a subscription serves with `login`, so the web app's `LoginPrompt` opens
  by itself when one is not configured. It drives the same `login()` (OAuth or the
  provider's API key) through `/api/logins` (`packages/server/src/logins.ts`): the flow runs
  on the backend, the app polls it, opens its sign-in page, and answers its prompts. Login has not yet been run end to end
  against a real subscription; that needs a person in the browser. The API-key
  paths are verified.
- **Third-party pi providers**: `providerPackages` in config. Each package default-exports
  a `Provider` or a factory, registered before Flue boots, and may replace a built-in by id.
- **Jev**: `createJevClient` uses pi-ai `models.classify` against `typesafe/jev-latest`,
  falls back to `openrouter/~typesafe/jev-latest`, and returns `undefined` when neither is
  configured. 16 in flight, with retry on 429/529. TypeSafe refuses browser requests,
  so Jev runs only on the backend.
- **Config** (`config.ts`): defaults → `~/.gloss/config.json` (`profile`, `tiers`,
  `thinking`, `judge`, `providerPackages`, `decisionRules`) → env (`GLOSS_PROFILE`, `GLOSS_MODEL`,
  `GLOSS_MODEL_{DEFINE,FOLLOWUP,NOTES,SMALL}`, `GLOSS_JUDGE=off`). The `small` tier
  (Haiku, or luna on OpenAI; thinking off) names stacks and stays cheap when `define` is raised.
  Unset, it takes the cheap model of `define`'s provider, so it never adds a login. `validateModelIds` fails
  loudly at startup on ids missing from pi-ai's catalog. `decisionRules` is read from the file at the
  start of each tour (`DecisionRules` service), so a save on the settings page needs no restart;
  `saveDecisionRules` rewrites only that key.

Tests: `flue-runtime.test.ts` drives the real Flue runtime with pi-ai's faux provider:
a submit call, a prose reply followed by a reminder, and a validation retry.
