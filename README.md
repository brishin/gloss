# gloss

A guided, annotated review tour of a pull request or local diff. gloss splits a change
into ordered review groups, each with a summary and notes pinned to the lines that
matter, and streams it to the browser stage by stage. The diff and a path-based first
grouping appear in under a second; the model's groups, Jev's placements and the notes
fill in after.

```bash
pnpm install && pnpm --filter @gloss/web build
node packages/cli/src/bin.ts https://github.com/owner/repo/pull/123   # or owner/repo#123
node packages/cli/src/bin.ts                                          # this repo: uncommitted changes, else branch vs main
node packages/cli/src/bin.ts tour main...HEAD                         # print a tour in the terminal
```

## Open from GitHub

`apps/extension` is a Chrome extension (also Arc, Brave, Edge): on a pull request page, its
toolbar button (or Alt+G, or "Open in gloss" on any PR link) opens the PR in the local
server it finds on ports 4777 to 4786. Load it once from `chrome://extensions` (Developer
mode, Load unpacked), then run `gloss extension install` so the button can start
`gloss serve` itself when nothing is running (logs in `~/.gloss/serve.log`). Without that,
it shows how to start the server and opens the PR once it is up.

## Models and keys

- **LLM** (group definitions, follow-up placement, notes) runs through a [Flue](https://flueframework.com) agent on the backend. Defaults: Claude Haiku 5.5 for the fast tiers, Sonnet 5.5 for notes. Set `"profile": "openai"` in `~/.gloss/config.json` for GPT.
  - Subscriptions: `gloss login claude` (Claude Pro/Max) or `gloss login chatgpt` (ChatGPT Plus/Pro), using pi-ai's OAuth. Tokens live in `~/.gloss/auth.json`.
  - API keys also work: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, in the environment or `~/.gloss/.env`.
  - Third-party pi provider packages: `"providerPackages": ["some-pi-provider"]` in config.
- **Jev** (TypeSafe's classifier) makes the per-file judgments: which group, generated, tests-only, and whether a file touches auth, stored data, secrets or personal data. Set `TYPESAFE_API_KEY` (or `OPENROUTER_API_KEY`). Without it the LLM places files itself.

`gloss status` shows what is configured.

## Cost

Tours run automatically when opened. Every model and Jev request is cached in
`~/.gloss/cache.sqlite` by a hash of the exact request, so reopening a tour for the same
head replays in about 100 ms with no model calls. `--force` (or Re-run) skips cache reads.
`gloss cache prune --days 30` trims it.

See [AGENTS.md](AGENTS.md) and [.agents/](.agents) for the architecture.
