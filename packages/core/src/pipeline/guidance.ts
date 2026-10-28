/**
 * Docs and agent guidance: files that state the intent of a change and the rules code
 * should follow. A tour leads with them, so a reviewer reads the "why" and the house
 * rules before the code that is supposed to honor them.
 */

/** Instructions for coding agents and editors, wherever they live in the tree. */
const AGENT_GUIDANCE_RE =
  /(^|\/)(AGENTS?|CLAUDE|GEMINI|CONVENTIONS)\.md$|(^|\/)SKILL\.md$|(^|\/)\.(agents?|claude|codex|cursor|windsurf|clinerules|github\/instructions|github\/prompts)\/|(^|\/)\.(cursorrules|windsurfrules|clinerules)$|(^|\/)\.github\/copilot-instructions\.md$|(^|\/)(skills|prompts)\/[^/]+\.md$/i;

/** Prose documentation. Plain `.txt` is excluded: it is as often data (requirements.txt) as prose. */
const DOCS_RE = /\.(md|mdx|rst|adoc)$|(^|\/)docs?\//i;

/** Docs that are bookkeeping rather than guidance. */
const MECHANICAL_DOCS_RE = /(^|\/)(CHANGELOG|CHANGES|HISTORY|LICENSE|LICENCE|NOTICE|AUTHORS|CODEOWNERS)(\.[a-z]+)?$/i;

export function isAgentGuidance(path: string): boolean {
  return AGENT_GUIDANCE_RE.test(path);
}

export function isDocumentation(path: string): boolean {
  return DOCS_RE.test(path) && !MECHANICAL_DOCS_RE.test(path);
}
