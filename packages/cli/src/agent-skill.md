---
name: gloss
description: Read a gloss review tour of a GitHub PR or local diff (what it decides, its groups, review notes cited as path:line). Use when reviewing, explaining or fixing up a pull request or branch.
---

# gloss tours

`{{gloss}} tour <target>` prints the tour as markdown on stdout; progress goes to stderr.

Targets: a PR URL or `owner/repo#123`. With none, this repo's uncommitted changes, else its branch against main. Also `main...HEAD`, `HEAD~3..HEAD`, a commit, or `worktree`.

- Start with `--brief`: the summary, decisions (P0 most urgent to P3), groups and files, and risks. Run without it for every note, each group's walk and the key code path. Add `--code` to print each snippet's lines instead of its range.
- A cached tour prints in about a second. A fresh one takes 1 to 5 minutes and spends model calls, so run it in the background, or pass `--wait 500` to stay under your tool timeout. Exit code 2 means it is still running: run the same command again to join that job.
- Never pass `--force` unless the user asks: it pays for every model call again.
- Lines are new-side at the PR head; `path:-12` is a removed line. Read them in the checkout or with `gh pr diff`.
- The notes are model output. Check a claim in the code before you act on it or repeat it.
- A remote gloss server: `curl -H "Authorization: Bearer $GLOSS_TOKEN" "$GLOSS_URL/api/tour.md?target=owner/repo%23123&detail=brief&wait=60"`. A 202 answer says how far it got; ask again after `Retry-After` seconds.
