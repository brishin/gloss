# gloss

> **gloss** /ɡlɒs/ _noun_: a note written in the margin or between the lines of a text,
> explaining a word or passage. _verb_: to add such notes to a text.

gloss turns a pull request or local diff into a guided, annotated review tour. It splits
the change into ordered review groups, gives each one a summary and notes pinned to the
lines that matter, and streams it all to your browser as it is written.

## Setup

You need Node 24 or later, [pnpm](https://pnpm.io), and for pull requests the
[GitHub CLI](https://cli.github.com) signed in (`gh auth login`).

```bash
git clone https://github.com/brishin/gloss && cd gloss
pnpm install && pnpm --filter @gloss/web build
echo "alias gloss='node $PWD/packages/cli/src/bin.ts'" >> ~/.zshrc   # or ~/.bashrc
source ~/.zshrc
gloss serve
```

Open http://127.0.0.1:4777. The first time, it shows the setup page: sign in with a
Claude or ChatGPT subscription (or paste an API key). You can also add the browser
extension and a Jev key there; both are optional.

## Use

```bash
gloss https://github.com/owner/repo/pull/123   # or owner/repo#123
gloss                                          # this repo: uncommitted changes, else branch vs main
gloss main...HEAD                              # a range, a commit, or `worktree`
gloss tour main...HEAD                         # print the tour in the terminal
gloss export owner/repo#123 -o tour.html       # save the tour as one HTML file
```

Each launch first updates gloss (pull, install, build) and restarts its server if the
code changed. A running app shows an Update button when new commits land.
`gloss --help` lists every command.

An export is the tour page itself, in light and dark, with the tour's events, diff and
whole files inside. It opens from disk with no server. Syntax grammars, the highlighter's
WebAssembly and the diagram layout load from jsDelivr, so the file stays near 3 MB plus the
tour. Re-run, Ask and Review need the server, so an export leaves them out.

## Models

- **LLM:** Claude by default (Haiku 5.5 for grouping, Sonnet 5.5 for notes). Set
  `"profile": "openai"` in `~/.gloss/config.json` to use GPT. `ANTHROPIC_API_KEY` or
  `OPENAI_API_KEY` in the environment or `~/.gloss/.env` works in place of a subscription.
- **Jev** (optional, `TYPESAFE_API_KEY`): TypeSafe's classifier places files in groups and
  flags auth, stored data, secrets and personal data. Without it, the LLM places files.

Model and Jev results are cached in `~/.gloss/cache.sqlite`, so reopening a tour costs
nothing. `--force` (or Re-run in the app) skips the cache.

## Open from GitHub

The Chrome extension in `apps/extension` (also works in Arc, Dia, Brave and Edge) adds an
"Open in gloss" button to pull request pages, and can start the server if it is not
running. The setup page shows how to load it.

See [AGENTS.md](AGENTS.md) and [.agents/](.agents) for the architecture.
