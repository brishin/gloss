import type { Decision, DiffMeta, FileChange, FileJudgment, GroupDefinition, ResolvedGroup } from '@gloss/protocol';
import { CATEGORIES, CATEGORY_GUIDE, DECISION_PRIORITIES, RISK_KEYS, RISK_LABELS } from '@gloss/protocol';
import * as v from 'valibot';
import { hashOf } from '../hash.ts';
import { isAgentGuidance, isDocumentation } from './guidance.ts';
import { looksGenerated, looksLikeTest } from './heuristics.ts';
import { YES } from './judge-questions.ts';

/** Total diff characters inlined into one prompt, and per file (from codiff's budgets). */
export const TOTAL_BUDGET = 60_000;
export const FILE_BUDGET = 12_000;

const categoryGuide = CATEGORIES.map((category) => `${category}: ${CATEGORY_GUIDE[category]}`).join(' ');

const GroupSchema = v.object({
  key: v.pipe(v.string(), v.description('Stable, short, kebab-case id, e.g. "auth-refresh" or "docs".')),
  label: v.pipe(v.string(), v.description('Short, human-readable name for the group (2-5 words), in sentence case.')),
  summary: v.pipe(
    v.string(),
    v.description('1-3 sentences on the intention of this group: why over what. Rendered as Markdown.'),
  ),
  category: v.pipe(
    v.picklist(CATEGORIES),
    v.description(`Which part of the system the group touches. ${categoryGuide}`),
  ),
});

const groupsField = <T extends v.GenericSchema>(entry: T) =>
  v.pipe(
    v.array(entry),
    v.description(
      'Review groups in reading order: the core change first, supporting changes next, mechanical changes (tests, docs, generated) last.',
    ),
  );

const overallSummary = v.pipe(
  v.string(),
  v.description(
    'A short paragraph, 2-4 sentences and under 80 words, telling a reviewer what this change does and where to focus. Rendered as Markdown.',
  ),
);

const decisionText = v.pipe(
  v.string(),
  v.description(
    'Exactly one short sentence, under 25 words, naming one choice and its reason when the reason is not obvious. Add "instead of ..." when the alternative is not obvious. Name the choice, not the code. No Markdown.',
  ),
);
const decisionPriority = v.pipe(
  v.picklist(DECISION_PRIORITIES),
  v.description(
    'urgent: rare; the reviewer must agree before merging because it affects security, access or data loss, or is hard to undo. high: users or other code will depend on it. medium: a design choice worth a look. low: a minor default. Most decisions are medium or low.',
  ),
);

const prDecisions = v.pipe(
  v.array(v.object({ text: decisionText, priority: decisionPriority })),
  v.description(
    'Key decisions about the change as a whole: product behavior, scope, rollout, and tradeoffs that span several files. Most changes have 1-4. Leave out choices that one line or one function makes; a later pass pins those to their lines.',
  ),
);

const short = (description: string) => v.pipe(v.string(), v.description(description));
const at = v.pipe(v.number(), v.description('Position on the time axis, 0 (start) to 100 (end).'));

/** Lenient on purpose: `normalizeVisual` enforces the limits and drops what it can't draw. */
const visual = v.optional(
  v.pipe(
    v.object({
      kind: v.pipe(
        v.picklist(['before-after', 'timeline', 'mermaid']),
        v.description(
          'before-after: the change replaces one shape or flow with another (a data model, an API, a hot path). timeline: when things happen is the point (a timer, a lifecycle event, a race, a retry). mermaid: a small flow or state machine.',
        ),
      ),
      caption: short('One sentence under 25 words saying what the picture shows. No Markdown.'),
      before: v.optional(
        v.pipe(
          v.array(v.string()),
          v.description('before-after only: 1-5 short rows, under 60 characters each. Wrap code names in backticks.'),
        ),
      ),
      after: v.optional(v.pipe(v.array(v.string()), v.description('before-after only: 1-5 short rows, same style.'))),
      markers: v.optional(
        v.pipe(
          v.array(v.object({ at, text: short('2-4 words.') })),
          v.description('timeline only: 0-4 moments on the shared time axis, e.g. "app backgrounded".'),
        ),
      ),
      lanes: v.optional(
        v.pipe(
          v.array(
            v.object({
              label: short('1-2 words, e.g. "Before", "After", "Recording".'),
              spans: v.array(
                v.object({
                  from: at,
                  to: at,
                  text: short('1-4 words shown inside the bar.'),
                  tone: v.optional(v.picklist(['accent', 'muted', 'bad'])),
                }),
              ),
              outcome: v.optional(
                v.object({ at, text: short('What happens, under 8 words.'), tone: v.picklist(['good', 'bad']) }),
              ),
            }),
          ),
          v.description(
            'timeline only: 2-4 lanes sharing one time axis. Usually a "Before" and an "After" lane, each ending in an outcome.',
          ),
        ),
      ),
      mermaid: v.optional(
        v.pipe(
          v.string(),
          v.description(
            'mermaid only: "flowchart TD" or "stateDiagram-v2" source with at most 8 nodes and labels under 30 characters. No styling, classes or click lines.',
          ),
        ),
      ),
    }),
    v.description(
      'One picture of the main decision, only when it explains the decision better than the summary does. Leave it out for most changes.',
    ),
  ),
);

/** With Jev, the LLM only defines groups; Jev and code place the files. */
export const DefineSchema = v.object({
  overallSummary,
  decisions: prDecisions,
  visual,
  groups: groupsField(GroupSchema),
});

/** Without Jev, the LLM also lists each group's files. */
export const DefineWithFilesSchema = v.object({
  overallSummary,
  decisions: prDecisions,
  visual,
  groups: groupsField(
    v.object({
      ...GroupSchema.entries,
      fileIds: v.pipe(
        v.array(v.string()),
        v.description('Ids of the files in this group. Every file id MUST be in exactly one group.'),
      ),
      critical: v.optional(
        v.pipe(
          v.boolean(),
          v.description(
            'Set only when the whole group deserves extra reviewer care (security, data loss, hard to revert).',
          ),
        ),
      ),
    }),
  ),
});

export const FollowupSchema = v.object({
  placements: v.array(
    v.object({
      fileId: v.string(),
      groupKey: v.pipe(v.string(), v.description('Key of an existing group.')),
    }),
  ),
});

const noteText = v.pipe(
  v.string(),
  v.description(
    '1-2 sentences, under 40 words, explaining what a reviewer would otherwise have to work out: non-obvious logic, a subtle behavior change, a risk. State what you found instead of asking the reviewer to verify it. Rendered as Markdown. Never restate the code.',
  ),
);
const noteCritical = v.optional(
  v.pipe(
    v.boolean(),
    v.description('Set only when the reviewer should take extra care here: security, data loss, hard to revert.'),
  ),
);

export const NotesSchema = v.object({
  fileNotes: v.pipe(
    v.array(v.object({ fileId: v.string(), text: noteText, critical: noteCritical })),
    v.description('Notes about a whole file. Add one only where it saves the reviewer time; most files need none.'),
  ),
  lineNotes: v.pipe(
    v.array(
      v.object({
        fileId: v.string(),
        hunkId: v.pipe(v.string(), v.description('The hunk id shown in the hunk header.')),
        side: v.pipe(
          v.picklist(['additions', 'deletions']),
          v.description('"additions" for a + or unchanged line, "deletions" for a - line.'),
        ),
        line: v.pipe(v.number(), v.description('The line number shown before the line in the diff.')),
        text: noteText,
        critical: noteCritical,
      }),
    ),
    v.description('Notes pinned to one line. Prefer these over file notes when the point is about one spot.'),
  ),
  riskNotes: v.pipe(
    v.array(
      v.object({
        fileId: v.string(),
        risk: v.picklist(RISK_KEYS),
        text: v.pipe(
          v.string(),
          v.description('What exactly changed and what the reviewer should verify. 1-2 sentences.'),
        ),
      }),
    ),
    v.description(
      'One note per flagged risk listed in the prompt that the diff confirms. Empty when none were flagged.',
    ),
  ),
  decisions: v.pipe(
    v.array(
      v.object({
        fileId: v.string(),
        hunkId: v.pipe(v.string(), v.description('The hunk id shown in the hunk header.')),
        side: v.pipe(
          v.picklist(['additions', 'deletions']),
          v.description('"additions" for a + or unchanged line, "deletions" for a - line.'),
        ),
        line: v.pipe(v.number(), v.description('The line number of the line that makes the choice.')),
        text: decisionText,
        priority: decisionPriority,
      }),
    ),
    v.description(
      'Key decisions this group makes in code, each pinned to the line that makes it: a chosen approach, default, data shape, check or ordering a reviewer should agree with on purpose. Never on tests or stylesheets, and never one the change-wide list covers. Most groups have 0-3, and an unimportant group has none.',
    ),
  ),
});

export const DEFINE_SYSTEM = `You are a senior engineer preparing a guided review tour of a code change.

Split the change into review groups a reviewer can read one at a time. Group by intention (one feature, fix or refactor per group), not by file type or directory. Keep groups few: 2-7 for most changes, one for a small focused change. Fold small supporting edits (formatting, field order, a dependency added for the feature, styles for a component) into the group they support instead of giving them their own group. Tests belong with the code they test unless they are the point of the change; generated files may be their own group.

Documentation and agent guidance (files marked [guidance]: AGENTS.md, CLAUDE.md, .agents/, agent skills and SKILL.md, editor and agent rules, docs/, READMEs) are important. They state the intent of the change and the rules the code is meant to follow, so a reviewer reads them first. Put them together in one group with category "docs", first in the order, and summarize the intent or rules they establish, not just that docs changed.

Write labels and summaries for a reviewer who has not seen the change. Explain why, not what. After the docs group, order groups so the core change comes first.

Also list the key decisions the change makes as a whole. A decision is a choice that a reasonable engineer could have made differently, and that a reviewer should agree with on purpose: product behavior, scope, a tradeoff, or what is deferred. Take them from the description where it states them, and infer the rest from the diff. List only choices that span several files or no file: if one file makes the choice, leave it out, because a later pass pins it to its line. Skip styling, layout, naming and dependency versions. Do not describe what the code does.

When a picture would explain the main decision faster than words, add one visual. Use before-after when the change swaps one design for another, timeline when the order or timing of events is the point, and mermaid for a small flow or state machine. Draw the decision, not the file list or the call graph. Most changes need no visual: leave it out for refactors, small fixes, docs and styling.

Call the submit tool once with the complete result.`;

export const FOLLOWUP_SYSTEM = `You are placing the remaining files of a code change into review groups that already exist. Put every listed file into the existing group it fits best. Call the submit tool once with all placements.`;

export const NOTES_SYSTEM = `You are a senior engineer annotating one group of a code change for a reviewer.

Write a few precise notes where they save the reviewer real effort: non-obvious logic, subtle behavior changes, edge cases, risks, and things that look wrong but are not. Skip anything the code already says plainly. Most groups need 0-6 notes; quality over quantity.

Only reference file ids listed under "## Files"; other files belong to other groups. Line notes reference a file id, the hunk id from the hunk header, and the line number printed before the line. Lines starting with "+" or " " use side "additions"; lines starting with "-" use side "deletions".

For documentation and agent guidance, note the rules or intent each change establishes or alters, so the reviewer can hold the code to them; flag instructions that are ambiguous or contradict each other.

When the prompt lists flagged risks, check each against the diff and write a risk note only for those the diff confirms.

Separately from notes, list the key decisions this group makes in code, each on the line that makes it. A decision is a choice that a reasonable engineer could have made differently, and that a reviewer should agree with on purpose: an approach, a default, a data shape, a check or an ordering. Include ones the description states and ones you infer. Skip CSS and visual styling, layout, naming, refactors, error handling details and anything that only describes what the code does. Never put a decision on a test, fixture or story file: record it where the code makes it. Skip any choice the change-wide list already covers, even when you can point at its line. Before you submit, remove each decision that restates a change-wide one.

Call the submit tool once with the result.`;

/** Bump when a result schema above changes shape or field descriptions. */
const SCHEMA_VERSION = 3;

export const PROMPTS_VERSION = hashOf({
  DEFINE_SYSTEM,
  FOLLOWUP_SYSTEM,
  NOTES_SYSTEM,
  TOTAL_BUDGET,
  FILE_BUDGET,
  SCHEMA_VERSION,
}).slice(0, 12);

function header(meta: DiffMeta): string {
  const lines = [`# ${meta.title}`, `${meta.baseRef} <- ${meta.headRef}`];
  if (meta.description?.trim()) {
    lines.push('', '## Description', meta.description.trim().slice(0, 4000));
  }
  if (meta.commits.length) {
    lines.push('', '## Commits', ...meta.commits.slice(-30).map((commit) => `- ${commit.subject}`));
  }
  return lines.join('\n');
}

function collapsedReason(file: FileChange): string | undefined {
  if (file.isBinary) {
    return 'binary';
  }
  if (file.truncated) {
    return 'too large to show';
  }
  if (file.generated || looksGenerated(file.path)) {
    return 'generated';
  }
  return undefined;
}

function isGuidance(file: FileChange): boolean {
  return isAgentGuidance(file.path) || (isDocumentation(file.path) && !looksLikeTest(file.path));
}

function manifestLine(file: FileChange): string {
  const rename = file.previousPath ? ` (from ${file.previousPath})` : '';
  const note = collapsedReason(file) ?? (isGuidance(file) ? 'guidance' : undefined);
  return `${file.id} ${file.status} ${file.path}${rename} +${file.additions} -${file.deletions}${note ? ` [${note}]` : ''}`;
}

function plainDiff(file: FileChange, budget: number): string {
  const text = file.hunks.map((hunk) => `${hunk.header}\n${hunk.patch}`).join('\n');
  return text.length > budget ? `${text.slice(0, budget)}\n... (truncated)` : text;
}

/** The prompt for defining groups: a manifest of every file, then as many diffs as fit the budget. */
export function buildDefinePrompt(meta: DiffMeta, files: readonly FileChange[], withFiles: boolean): string {
  const parts = [header(meta), '', `## Files (${files.length})`, ...files.map(manifestLine)];
  let remaining = TOTAL_BUDGET;
  const diffs: string[] = [];
  const omitted: string[] = [];
  // Guidance diffs go first so the budget never cuts the files that explain the change.
  const ordered = [...files.filter(isGuidance), ...files.filter((file) => !isGuidance(file))];
  for (const file of ordered) {
    if (collapsedReason(file)) {
      continue;
    }
    const body = plainDiff(file, Math.min(FILE_BUDGET, remaining));
    if (remaining <= 0 || body.length === 0) {
      omitted.push(file.id);
      continue;
    }
    diffs.push(`### ${file.id} ${file.path}\n${body}`);
    remaining -= body.length;
  }
  parts.push('', '## Diffs', ...diffs);
  if (omitted.length) {
    parts.push('', `(Diffs omitted for budget: ${omitted.join(', ')}. Judge them by path and the hunk headers.)`);
  }
  parts.push(
    '',
    withFiles
      ? 'Define the review groups and assign every file id to exactly one group.'
      : 'Define the review groups. Do not list files; they are placed separately.',
  );
  return parts.join('\n');
}

export function buildFollowupPrompt(
  meta: DiffMeta,
  groups: readonly GroupDefinition[],
  files: readonly FileChange[],
): string {
  return [
    header(meta),
    '',
    '## Groups',
    ...groups.map((group) => `- ${group.key}: ${group.label}. ${group.summary}`),
    '',
    '## Files to place',
    ...files.map((file) => `### ${manifestLine(file)}\n${plainDiff(file, 2000)}`),
  ].join('\n');
}

/** Hunk lines numbered for line notes: new-file numbers on `+`/` ` lines, old-file numbers on `-` lines. */
export function renderNumberedHunk(hunk: FileChange['hunks'][number]): string {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const out = [`@@ hunk ${hunk.id} ${hunk.header.replace(/^@@ .*? @@ ?/, '')}`.trimEnd()];
  for (const line of hunk.patch.split('\n')) {
    const marker = line[0] ?? ' ';
    if (marker === '\\') {
      continue;
    }
    const text = line.slice(1);
    if (marker === '-') {
      out.push(`- ${oldLine++} ${text}`);
    } else if (marker === '+') {
      out.push(`+ ${newLine++} ${text}`);
    } else {
      out.push(`  ${newLine++} ${text}`);
      oldLine++;
    }
  }
  return out.join('\n');
}

export function flaggedRisks(judgment: FileJudgment | undefined): (typeof RISK_KEYS)[number][] {
  return RISK_KEYS.filter((key) => (judgment?.[key] ?? 0) >= YES);
}

export function buildNotesPrompt(
  meta: DiffMeta,
  overallSummary: string | undefined,
  group: ResolvedGroup,
  files: readonly FileChange[],
  judgments: Record<string, FileJudgment>,
  decisions: readonly Decision[] = [],
): string {
  const parts = [header(meta)];
  if (overallSummary) {
    parts.push('', '## Overall', overallSummary);
  }
  if (decisions.length) {
    parts.push(
      '',
      '## Change-wide decisions (already listed; do not repeat)',
      ...decisions.map((decision) => `- ${decision.text}`),
    );
  }
  parts.push('', `## This group: ${group.label}`, group.summary);
  const risks = files.flatMap((file) =>
    flaggedRisks(judgments[file.id]).map((risk) => `- ${file.id} ${file.path}: ${risk} (${RISK_LABELS[risk]})`),
  );
  parts.push('', '## Flagged risks', ...(risks.length ? risks : ['(none)']));
  let remaining = TOTAL_BUDGET;
  parts.push('', '## Files');
  for (const file of files) {
    const reason = collapsedReason(file);
    if (reason) {
      parts.push(`### ${manifestLine(file)}`);
      continue;
    }
    let body = file.hunks.map(renderNumberedHunk).join('\n');
    const budget = Math.min(FILE_BUDGET, Math.max(remaining, 0));
    if (body.length > budget) {
      body = budget > 500 ? `${body.slice(0, budget)}\n... (truncated)` : '(omitted for budget)';
    }
    remaining -= body.length;
    parts.push(`### ${manifestLine(file)}`, body);
  }
  return parts.join('\n');
}
