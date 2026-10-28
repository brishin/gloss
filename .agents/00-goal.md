# Goal

Make reviewing a change feel like being walked through it by its author: what it does,
in what order to read it, and which lines deserve care. Optimize for time to first
useful content when a PR is opened, and for cost (tours run automatically).

Prior art, read for ideas:

- `~/Programming/pulls.review`: review groups, valibot schema-first types, the
  `DiffSource`/`serializeRef` pattern, local-agent streaming. Its AI result arrived
  atomically; gloss streams partial structure instead.
- `~/Programming/codiff`: deterministic hunk ids (the model references ids, not line
  numbers), content-addressed walkthrough cache, transport-agnostic review surface.
- `~/Documents/jev-pulls-review-report.md`: the LLM writes prose (labels, summaries,
  notes), Jev answers typed per-file questions, code holds the truth table. 2.5x faster,
  3x fewer output tokens, and no coverage retries in the eval.

Non-goals for now: hosting a backend, posting comments to GitHub, chat.
