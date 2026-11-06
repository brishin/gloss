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
    v.description(
      '1-3 sentences on the problem this group solves, beyond the overall summary. Do not list components, or mention tests or generated files; they are placed elsewhere. Rendered as Markdown.',
    ),
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
      'Review groups in reading order: docs first, then the core change, then supporting changes, then tests and generated files.',
    ),
  );

const overallSummary = v.pipe(
  v.string(),
  v.description(
    'One sentence on what changes and why, adding to the title rather than repeating it. Then where to focus: the logic most likely to be wrong and how it could fail, not what a compiler or CI would catch. 2-4 sentences, under 80 words. Rendered as Markdown.',
  ),
);

const decisionText = v.pipe(
  v.string(),
  v.description(
    'Exactly one sentence, under 25 words, that a reviewer can accept or reject. Name the choice, then what it costs or risks; give its reason only when there is no cost worth stating. Add "instead of ..." when the alternative is not obvious. No Markdown.',
  ),
);
const decisionPriority = v.pipe(
  v.picklist(DECISION_PRIORITIES),
  v.description(
    'urgent: if wrong, a follow-up cannot fix it: it exposes data or access, or loses or rewrites stored data. high: if wrong, users or existing callers are affected, or other code will depend on it. medium: a design choice worth a look. low: a minor default, or a choice that is easy to change later. Between two, pick the lower.',
  ),
);

const prDecisions = v.pipe(
  v.array(
    v.object({
      text: decisionText,
      priority: decisionPriority,
      groupKey: v.optional(
        v.pipe(
          v.string(),
          v.description(
            'Key of the group this decision is mostly about, so it shows in that group. Omit only when it is about the change as a whole.',
          ),
        ),
      ),
    }),
  ),
  v.description(
    'Key decisions about the change as a whole: product behavior, scope, rollout, and tradeoffs that span several files. Most changes have 0-3. Leave out choices that one file makes; a later pass pins those to their lines.',
  ),
);

const short = (description: string) => v.pipe(v.string(), v.description(description));
const at = v.pipe(v.number(), v.description('Position on the time axis, 0 (start) to 100 (end).'));

/**
 * Lenient on purpose: `normalizeVisual` enforces the limits and drops what it can't draw.
 * Required, with an explicit "none", because models skip an optional field almost always.
 */
const visual = v.pipe(
  v.object({
    kind: v.pipe(
      v.picklist(['before-after', 'timeline', 'mermaid', 'none']),
      v.description(
        'none: no picture in this slot. before-after: the change replaces one flow or structure with another (a data path, a state machine, a component tree), drawn as two small diagrams. timeline: when things happen is the point (a timer, a lifecycle event, a race, a retry). mermaid: a small flow or state machine. Never a list of points: the summary already says them.',
      ),
    ),
    caption: short('One sentence under 25 words saying what the picture shows. No Markdown. Empty for none.'),
    before: v.optional(
      v.pipe(
        v.string(),
        v.description(
          'before-after only: the old flow as "flowchart TD" or "stateDiagram-v2" source, 2-6 nodes, labels under 30 characters, no styling.',
        ),
      ),
    ),
    after: v.optional(
      v.pipe(
        v.string(),
        v.description(
          'before-after only: the new flow in the same style, reusing the node names that did not change so the difference stands out.',
        ),
      ),
    ),
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
            label: short('1-2 words, e.g. "Before", "After", "Retry".'),
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
    'One picture of the main decision: a design replaced by another, events whose timing matters, or a flow of three or more steps.',
  ),
);

/**
 * The hand-drawn candidate, from its own call: as one slot of the define call it was drawn
 * as a shallow overview that left out parts its own caption named (eval rounds 6-10).
 */
export const SketchSchema = v.pipe(
  v.object({
    form: v.pipe(
      v.picklist(['architecture', 'bands', 'timeline', 'states', 'boundary', 'fan', 'shape', 'none']),
      v.description(
        'The figure type, chosen from the mechanism before drawing (see "Figure types"). none only when svg is "".',
      ),
    ),
    caption: short('One sentence under 25 words saying what the picture shows. No Markdown. Empty for none.'),
    svg: v.pipe(
      v.string(),
      v.description(
        'One <svg> drawn as "Drawing the sketch" says, or "" only for a rename, a styling tweak, a dependency bump or a docs-only change. Only rect, circle, ellipse, line, polyline, polygon, path, text, tspan, g, defs and marker; no style, class, script, image, links, CSS or transform; attribute values in double quotes.',
      ),
    ),
  }),
  v.description('A hand-drawn explainer figure of the main decision, like one in a design doc.'),
);

/**
 * Overgenerated on purpose: a judge (or, without one, the order) picks the one shown.
 * Required slots, because asked for a list of 2-3 the model returned one every time.
 */
const visuals = v.pipe(
  v.object({
    first: visual,
    second: v.pipe(visual, v.description('Another candidate, of a different kind or angle than first, or none.')),
  }),
  v.description(
    'Two candidate pictures of the main decision drawn from data; a hand-drawn one is made separately and only one is shown. Both none only for a rename, a styling tweak, a dependency bump or a docs-only change.',
  ),
);

/** With Jev, the LLM only defines groups; Jev and code place the files. */
export const DefineSchema = v.object({
  overallSummary,
  decisions: prDecisions,
  visuals,
  groups: groupsField(GroupSchema),
});

/** Without Jev, the LLM also lists each group's files. */
export const DefineWithFilesSchema = v.object({
  overallSummary,
  decisions: prDecisions,
  visuals,
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
          v.description(
            'What changed and what it exposes or makes hard to undo, as fact from the diff, under 40 words. No request to verify.',
          ),
        ),
      }),
    ),
    v.description(
      'One note per flagged risk listed in the prompt that the diff confirms, unless a line note or decision here already makes the point. A flag that turns out harmless gets no note; never reassure. Empty otherwise.',
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

/**
 * One-way doors are the decisions a reviewer most needs to agree with on purpose, so both
 * decision passes look for them first. SQL migrations are the commonest kind: the notes pass
 * pins each one in its file, so the define pass gets only the rollout half of the rule, or it
 * restates the schema change change-wide.
 */
const ONE_WAY_DOORS = `Look hardest for one-way doors: choices that are expensive or impossible to reverse once merged and deployed, and so need agreement before merging rather than a follow-up fix. Examples: a SQL or schema migration; data deleted, rewritten or stored in a new shape; a public API, wire format, file format, config key or event name that other code or clients will depend on; a published package version; an irreversible external side effect such as sending messages or charging money. Say in the decision what makes it hard to undo. A one-way door that loses no data and exposes nothing is high.`;

const MIGRATION_ROLLOUT = `A later pass pins each SQL migration's schema change, and any data it drops, to its migration file. Do not list what a migration adds, drops, renames or backfills here. List only how it rolls out across files: the order the migration and the code that relies on it must deploy in, or code that stops working against the old schema.`;

const MIGRATION_PIN = `SQL migrations are always key decisions: any migration file, raw DDL, or ORM change that alters the database schema. For each migration file in this group, pin exactly one decision to its first statement that drops, renames or rewrites data, or else its first schema statement. Name what it changes (a table or column added, dropped or renamed, a table rebuilt by copy and drop, a type or nullability change, a new constraint or index, a backfill or data rewrite) and whether it can be rolled back, for a backfill the value it writes and what that value gets wrong, and fold any other choice the file makes, such as a cascade or a JSON column, into it. Rate one that drops or rewrites data, cannot be rolled back, or locks a large table urgent, and any other migration high, never medium or low. Pin it even when the change-wide list mentions the migration: that list covers rollout, and this decision names the schema change.`;

/**
 * How to draw the sketch, from the bake-off's hand-drawn figures (the style Brian liked) and
 * the artifact diagramming guidance. Its colors are roles: the web app's .visual-sketch
 * styles map each one to a theme token, so keep the two lists in step.
 */
const SKETCH_GUIDE = `Drawing the sketch. Draw it as the engineer who has to live with the decision, like a figure in a design doc:
- Draw the mechanism, not its name: the path a request takes, the boundary it crosses, the step or edge the change adds or removes. Pick the part only this change has (a walk and where it stops, a loop, a fan-out, what moved where) over the request plumbing every feature shares. Write the caption first, then draw every noun it names as a box: if it says "plus recent tours", recent tours is a box, and if it says "before", there is a BEFORE band.
- Color only the part that differs: accent (stroke #5b4cc4, stroke-width 1.5, fill none) for what the change adds, bad (stroke #cf222e, stroke-dasharray "4 3", fill none) for what it removes or fixes. One accent at most. A part that only sometimes exists is a box with stroke-dasharray "4 3" in #8c959f.
- Everything else is neutral: boxes rx 8, 40 tall, fill #f6f8fa, stroke #d1d9e0; arrows are paths, stroke #8c959f, fill none, marker-end="url(#a)", one path per arrow (a marker marks only the last point). Every arrow starts and ends on a box edge; a loop is an arrow back to the box it left.
- Text: labels 13px #1f2328 centered in their box (text-anchor middle); a second line or an arrow label 11.5px #59636e; code in font-family "ui-monospace,Menlo,monospace" 11.5px; band headings 12px, font-weight 600, letter-spacing .04em, #59636e, in capitals.
- Label every arrow with a verb or condition ("calls", "miss", "writes", "on abort"), 11.5px #59636e, just above a level arrow or beside a vertical one. A word or three per label; a box is about 7px per character plus 24; sentences go in the caption.
- Grid: viewBox 760 wide, 16 margins, shared baselines, even gaps (about 60 between boxes), height sized to the content (about 160-460). Three to six boxes a band; draw what the decision turns on, not the whole system.

Figure types. Pick the one whose shape is the mechanism. Every change is a before and an after, so that alone is no reason for bands: draw the new mechanism in its own shape and accent what the change adds or fixes. Choose bands only when the old path itself is what the reviewer must see, such as a step that moved or a call that was removed.
- architecture: the change adds, removes or rewires a component of the system (a service, worker, queue, store, cache, client or third-party API), or moves work from one to another. The components the change touches and their direct neighbors, grouped into tiers left to right (client, server, workers, data, external) as wide regions (fill #f6f8fa, no stroke) with capital headings, boxes inside them (fill #ffffff). Arrows say what flows (HTTP, events, rows, files). Accent the new or moved component, and mark a removed one dashed red. Five to nine boxes.
- timeline: order or timing is the point (a timer, a debounce, a race, a retry, a save on background, a lifecycle event). Lanes on one left-to-right time axis, events as small boxes on it, the moment the change moves accented.
- states: a status, mode, hold or lifecycle the change adds to or rewires, or a decode or fallback chain. States as boxes, transitions as labelled arrows (the event or condition), the new or changed transition accented.
- boundary: what crosses a line between places (client and server, app and worker, process, network, trust or package boundary). The places as wide regions (fill #f6f8fa, no stroke) with their names as headings, boxes inside them (fill #ffffff), arrows for what crosses.
- fan: one-to-many or many-to-one (fan-out, batching, a queue, a pool, a concurrency limit, a filter that drops some). One box to a short column of boxes, the count, limit or rule in a label.
- shape: the change is a data shape (a schema, a record, a tree, a tag set, a size limit). The structure as nested boxes or rows of fields in monospace, the added or changed field accented.
- bands: a BEFORE band over an AFTER band on the same grid, so the step that differs sits in the same place in both.

An example of the style, for a cache added in front of a query:
<svg viewBox="0 0 760 272"><defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#8c959f"/></marker></defs><text x="16" y="24" font-size="12" font-weight="600" letter-spacing=".04em" fill="#59636e">BEFORE</text><rect x="16" y="38" width="150" height="40" rx="8" fill="#f6f8fa" stroke="#d1d9e0"/><text x="91" y="63" font-size="13" text-anchor="middle" fill="#1f2328">Request</text><rect x="226" y="38" width="150" height="40" rx="8" fill="#f6f8fa" stroke="#d1d9e0"/><text x="301" y="63" font-size="13" text-anchor="middle" fill="#1f2328">Handler</text><rect x="436" y="38" width="150" height="40" rx="8" fill="none" stroke="#cf222e" stroke-dasharray="4 3"/><text x="511" y="56" font-size="11.5" font-family="ui-monospace,Menlo,monospace" text-anchor="middle" fill="#cf222e">db.query()</text><text x="511" y="71" font-size="11.5" text-anchor="middle" fill="#59636e">every request</text><path d="M166 58H224" stroke="#8c959f" fill="none" marker-end="url(#a)"/><text x="195" y="52" font-size="11.5" text-anchor="middle" fill="#59636e">sends</text><path d="M376 58H434" stroke="#8c959f" fill="none" marker-end="url(#a)"/><text x="405" y="52" font-size="11.5" text-anchor="middle" fill="#59636e">calls</text><line x1="16" x2="744" y1="104" y2="104" stroke="#d1d9e0"/><text x="16" y="132" font-size="12" font-weight="600" letter-spacing=".04em" fill="#59636e">AFTER</text><rect x="16" y="146" width="150" height="40" rx="8" fill="#f6f8fa" stroke="#d1d9e0"/><text x="91" y="171" font-size="13" text-anchor="middle" fill="#1f2328">Request</text><rect x="226" y="146" width="150" height="40" rx="8" fill="#f6f8fa" stroke="#d1d9e0"/><text x="301" y="171" font-size="13" text-anchor="middle" fill="#1f2328">Handler</text><rect x="436" y="146" width="150" height="40" rx="8" fill="none" stroke="#5b4cc4" stroke-width="1.5"/><text x="511" y="164" font-size="13" text-anchor="middle" fill="#1f2328">Cache</text><text x="511" y="179" font-size="11.5" text-anchor="middle" fill="#59636e">hit: no query</text><path d="M166 166H224" stroke="#8c959f" fill="none" marker-end="url(#a)"/><text x="195" y="160" font-size="11.5" text-anchor="middle" fill="#59636e">sends</text><path d="M376 166H434" stroke="#8c959f" fill="none" marker-end="url(#a)"/><text x="405" y="160" font-size="11.5" text-anchor="middle" fill="#59636e">calls</text><path d="M511 186V214" stroke="#8c959f" fill="none" marker-end="url(#a)"/><text x="519" y="204" font-size="11.5" fill="#59636e">miss</text><rect x="436" y="216" width="150" height="40" rx="8" fill="#f6f8fa" stroke="#d1d9e0"/><text x="511" y="241" font-size="11.5" font-family="ui-monospace,Menlo,monospace" text-anchor="middle" fill="#1f2328">db.query()</text></svg>

A states example, for edits made while a save is in flight:
<svg viewBox="0 0 760 136"><defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#8c959f"/></marker></defs><rect x="16" y="48" width="150" height="40" rx="8" fill="#f6f8fa" stroke="#d1d9e0"/><text x="91" y="73" font-size="13" text-anchor="middle" fill="#1f2328">Editing</text><rect x="306" y="48" width="150" height="40" rx="8" fill="#f6f8fa" stroke="#d1d9e0"/><text x="381" y="73" font-size="13" text-anchor="middle" fill="#1f2328">Saving</text><rect x="596" y="48" width="148" height="40" rx="8" fill="#f6f8fa" stroke="#d1d9e0"/><text x="670" y="73" font-size="13" text-anchor="middle" fill="#1f2328">Saved</text><path d="M166 68H304" stroke="#8c959f" fill="none" marker-end="url(#a)"/><text x="235" y="62" font-size="11.5" text-anchor="middle" fill="#59636e">pause 1s</text><path d="M456 68H594" stroke="#8c959f" fill="none" marker-end="url(#a)"/><text x="525" y="62" font-size="11.5" text-anchor="middle" fill="#59636e">write ok</text><path d="M91 88V112H670V90" stroke="#8c959f" fill="none" marker-end="url(#a)"/><text x="380" y="128" font-size="11.5" text-anchor="middle" fill="#59636e">nothing to save</text><path d="M356 48V24H406V46" stroke="#5b4cc4" stroke-width="1.5" fill="none" marker-end="url(#a)"/><text x="381" y="18" font-size="11.5" text-anchor="middle" fill="#59636e">edit: save again</text></svg>

An architecture example, for a queue added between the API and a new worker:
<svg viewBox="0 0 760 200"><defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#8c959f"/></marker></defs><rect x="16" y="16" width="180" height="168" rx="8" fill="#f6f8fa"/><text x="32" y="38" font-size="12" font-weight="600" letter-spacing=".04em" fill="#59636e">CLIENT</text><rect x="212" y="16" width="336" height="168" rx="8" fill="#f6f8fa"/><text x="228" y="38" font-size="12" font-weight="600" letter-spacing=".04em" fill="#59636e">SERVER</text><rect x="564" y="16" width="180" height="168" rx="8" fill="#f6f8fa"/><text x="580" y="38" font-size="12" font-weight="600" letter-spacing=".04em" fill="#59636e">DATA</text><rect x="36" y="56" width="140" height="40" rx="8" fill="#ffffff" stroke="#d1d9e0"/><text x="106" y="81" font-size="13" text-anchor="middle" fill="#1f2328">Web app</text><rect x="232" y="56" width="120" height="40" rx="8" fill="#ffffff" stroke="#d1d9e0"/><text x="292" y="81" font-size="13" text-anchor="middle" fill="#1f2328">API</text><rect x="412" y="56" width="116" height="40" rx="8" fill="#ffffff" stroke="#5b4cc4" stroke-width="1.5"/><text x="470" y="81" font-size="13" text-anchor="middle" fill="#1f2328">Job queue</text><rect x="412" y="124" width="116" height="40" rx="8" fill="#ffffff" stroke="#5b4cc4" stroke-width="1.5"/><text x="470" y="149" font-size="13" text-anchor="middle" fill="#1f2328">Worker</text><rect x="584" y="90" width="140" height="40" rx="8" fill="#ffffff" stroke="#d1d9e0"/><text x="654" y="115" font-size="11.5" font-family="ui-monospace,Menlo,monospace" text-anchor="middle" fill="#1f2328">postgres</text><path d="M176 76H230" stroke="#8c959f" fill="none" marker-end="url(#a)"/><text x="203" y="70" font-size="11.5" text-anchor="middle" fill="#59636e">HTTP</text><path d="M352 76H410" stroke="#8c959f" fill="none" marker-end="url(#a)"/><text x="381" y="70" font-size="11.5" text-anchor="middle" fill="#59636e">enqueue</text><path d="M470 96V122" stroke="#8c959f" fill="none" marker-end="url(#a)"/><text x="478" y="114" font-size="11.5" fill="#59636e">pulls</text><path d="M528 144H556V118H582" stroke="#8c959f" fill="none" marker-end="url(#a)"/><text x="560" y="160" font-size="11.5" fill="#59636e">writes</text><path d="M292 96V174H654V132" stroke="#8c959f" fill="none" marker-end="url(#a)"/><text x="300" y="168" font-size="11.5" fill="#59636e">reads</text></svg>`;

export const DEFINE_SYSTEM = `You are a senior engineer preparing a guided review tour of a code change.

Split the change into review groups a reviewer can read one at a time. Group by intention (one feature, fix or refactor per group), not by file type, directory or layer; "backend" and "frontend" are not intentions. Keep groups few: 2-7 for most changes, one for a small focused change. Fold small supporting edits (formatting, field order, a dependency added for the feature, styles for a component) into the group they support instead of giving them their own group. Tests go in their own group: define one with category "tests" and say what behavior they pin. Generated files may be their own group.

Documentation and agent guidance (files marked [guidance]: AGENTS.md, CLAUDE.md, .agents/, agent skills and SKILL.md, editor and agent rules, docs/, READMEs) are important. They state the intent of the change and the rules the code is meant to follow, so a reviewer reads them first. Put them together in one group with category "docs", first in the order, and summarize the intent or rules they establish, not just that docs changed.

Write labels and summaries for a reviewer who has not seen the change. Explain why, not what. After the docs group, order groups so the core change comes first.

Also list the key decisions the change makes as a whole. A decision is a choice that a reasonable engineer could have made differently, and that a reviewer should agree with on purpose: product behavior, scope, a tradeoff, or what is deferred. List only choices no single file makes: if one file makes the choice, leave it out, because a later pass pins it to its line. The description is the author's case: judge each choice's cost from the diff, and repeat a guarantee only if the code enforces it. A caveat, such as an untested path, is not a decision. Skip styling, layout, naming and dependency versions. Do not describe what the code does. Give each decision the key of the group it is mostly about; leave the key out only for a decision about the change as a whole.

${ONE_WAY_DOORS}

${MIGRATION_ROLLOUT}

Then propose two candidate visuals of the main decision, drawn from data; only one picture will be shown. Make them differ in kind or angle so there is a real choice. Add them whenever the change has any of these: a design replaced by another (before-after: a small diagram of the old flow or structure next to one of the new), events whose order or timing matters (timeline: a timer, a lifecycle event, a race, a retry, a walk that now stops somewhere), or a flow or state machine of three or more steps that the change adds or alters (mermaid). Most features and behavior fixes have one of these. Draw the decision, not the file list or the call graph, and use the reviewer's words, not code dumps. A picture must show structure (flow, branching, order or timing) that a bulleted list would lose; never restate the summary as rows of text. Use kind "none" in a slot only when you have nothing different to draw, and in both only when none of these applies, such as a rename, a styling tweak, a dependency bump or a docs-only change.

Call the submit tool once with the complete result.`;

/**
 * The walkthrough: each change-wide decision read in code. Short snippets with the line that
 * makes the choice, and a tree only when the decision has one (calls or concepts). Flat tree
 * rows with a depth, because tool schemas draw recursion poorly. Everything points at numbered
 * lines, which `normalizeWalkthrough` checks against the diff.
 */
export const WalkthroughResultSchema = v.pipe(
  v.object({
    decisions: v.pipe(
      v.array(
        v.object({
          decision: v.pipe(v.number(), v.description('Number of the decision under "Key decisions", from 0.')),
          title: short(
            'The choice in a few words, as a claim, e.g. "Catch-up replays share 24 slots per process". No Markdown.',
          ),
          why: short(
            'One or two sentences on why the change makes this choice, from what the code shows. Code names in backticks.',
          ),
          instead: short('The option it chose against, in a few words; "" when there was no real alternative.'),
          check: short(
            'One sentence on what the reviewer should hold the code to: the consequence that follows if the choice is wrong, or a case it does not cover. "" when there is none.',
          ),
          snippets: v.pipe(
            v.array(
              v.object({
                fileId: short('Id of the file, from "## Files".'),
                hunkId: short('Id of the hunk, from its "@@ hunk" header.'),
                from: v.pipe(v.number(), v.description('First new-file line number to show, as printed in the diff.')),
                to: v.pipe(v.number(), v.description('Last new-file line number to show, as printed in the diff.')),
                focus: v.pipe(
                  v.number(),
                  v.description('The new-file line number, from..to, of the one line that makes the choice.'),
                ),
                caption: short(
                  'One sentence on what these lines show about the decision, e.g. "Every replay takes a slot first, so the 25th waits here."',
                ),
                note: short(
                  'One sentence pinned under the focus line, only for what the code does not say (a consequence, what the line replaced); "" otherwise.',
                ),
              }),
            ),
            v.description(
              '1-3 snippets in reading order: the lines where the decision is made first, then where it takes effect. 2-12 lines each.',
            ),
          ),
          tree: v.pipe(
            v.picklist(['none', 'calls', 'concepts']),
            v.description(
              'calls: the decision runs across a call path or many callers reach it. concepts: the decision defines a hierarchy (what counts, kinds, which case resolves how). none: the snippets say it all, which is common.',
            ),
          ),
          nodes: v.pipe(
            v.array(
              v.object({
                depth: v.pipe(
                  v.number(),
                  v.description('0 for a root; a child is one deeper than the row it belongs to.'),
                ),
                receiver: short('calls: what the function is called on, e.g. "self._slots"; "" otherwise.'),
                name: short('calls: the function or method name only; "" for a concept.'),
                args: short('calls: its parameters as short names, or "..."; "" otherwise.'),
                status: v.pipe(
                  v.picklist(['new', 'changed', 'same']),
                  v.description(
                    'calls: new if the change adds it, changed if its body or signature changes, same otherwise. concepts: same.',
                  ),
                ),
                label: short(
                  'concepts: the concept in a few words, e.g. "Snapshot cached before the deploy"; "" for a call.',
                ),
                note: short('A few words on its part in the decision, e.g. "waits here once 24 run"; "" when none.'),
                fileId: short('Id of the file that defines it, or "".'),
                line: v.pipe(
                  v.number(),
                  v.description('The new-file line number printed before its definition in the diff, or 0.'),
                ),
                snippet: v.pipe(
                  v.number(),
                  v.description('Index (from 0) of the snippet that shows under this row, or -1.'),
                ),
              }),
            ),
            v.description('The tree, top down, 3-12 rows. Empty when tree is none.'),
          ),
          refs: v.pipe(
            v.array(
              v.object({
                label: short('A few words on what this place does with the decision, e.g. "Admin check".'),
                fileId: short('Id of the file.'),
                line: v.pipe(v.number(), v.description('The new-file line number printed in the diff, or 0.')),
              }),
            ),
            v.description(
              'Other places the decision reaches that the snippets and tree do not show (more callers, a test that holds it), up to 6. Often empty.',
            ),
          ),
          links: v.pipe(
            v.array(
              v.object({
                to: v.pipe(v.number(), v.description('Number of another decision under "Key decisions".')),
                text: short('One sentence on how they connect: one forces, enables or costs the other.'),
              }),
            ),
            v.description('Other key decisions this one depends on or forces. Often empty.'),
          ),
        }),
      ),
      v.description('One entry per key decision that code in the diff makes or carries out, in the listed order.'),
    ),
  }),
  v.description("The change's key decisions, each read in a few lines of code."),
);

/**
 * The key code paths, read beside the decisions: a call tree from an entry point a reviewer knows,
 * read in 2-5 steps with short excerpts. Its own call, because asked in the decisions call the
 * model left it empty. `normalizeWalkthrough` checks it against the diff.
 */
export const CallPathResultSchema = v.pipe(
  v.object({
    frames: v.pipe(
      v.array(
        v.object({
          depth: v.pipe(
            v.number(),
            v.description('0 for an entry point; a callee is one deeper than the frame that calls it.'),
          ),
          receiver: short(
            'What the function is called on as the code writes it, e.g. "ScheduleCheck", "permission", "this.tools"; "" for a plain function.',
          ),
          name: short('The function or method name only, e.g. "authorize".'),
          args: short('Its parameters as short names, e.g. "session, check", or "..." when long. Under 40 characters.'),
          fileId: short('Id of the file that defines it, or "" when no listed file does.'),
          line: v.pipe(
            v.number(),
            v.description(
              'The new-file line number printed before its definition in the diff, or 0 when the diff does not show the definition.',
            ),
          ),
          status: v.pipe(
            v.picklist(['new', 'changed', 'same']),
            v.description(
              'new: the change adds this function. changed: its body or signature changes. same: unchanged, shown only to connect the path to its entry point.',
            ),
          ),
        }),
      ),
      v.description(
        'The call tree of the key code paths, top down: each frame is followed by what it calls, one level deeper, in call order. 4-14 frames. Empty when the change adds or alters no key code path.',
      ),
    ),
    steps: v.pipe(
      v.array(
        v.object({
          title: short(
            'A few words naming what happens at this step, e.g. "The handler schedules the check". No Markdown.',
          ),
          text: short(
            'One or two sentences on what this code does in the change and why it matters to the next step. Code names in backticks.',
          ),
          frames: v.pipe(
            v.array(v.number()),
            v.description('Indexes into frames (from 0) of the frames this step covers.'),
          ),
          excerpts: v.pipe(
            v.array(
              v.object({
                fileId: short('Id of the file, from "## Files".'),
                hunkId: short('Id of the hunk, from its "@@ hunk" header.'),
                from: v.pipe(v.number(), v.description('First new-file line number to show, as printed in the diff.')),
                to: v.pipe(v.number(), v.description('Last new-file line number to show, as printed in the diff.')),
              }),
            ),
            v.description(
              '1-3 short slices of code this step reads, in reading order: the changed lines that matter and a line or two around them, under 25 lines each. Slices from different files are fine.',
            ),
          ),
        }),
      ),
      v.description('2-5 steps that follow the call tree top down. Empty when the tree is not worth walking.'),
    ),
  }),
  v.description('The key code paths read in order, step by step, with the code each step reaches.'),
);

export const SKETCH_SYSTEM = `You are a senior engineer drawing the one figure a reviewer sees first in a guided review tour of a code change: an explainer of its main decision, like a figure in a design doc. Read the change and the tour's summary and decisions, find the mechanism the decision changes, then draw it.

${SKETCH_GUIDE}

Call the submit tool once with the caption and the svg.`;

export const WALKTHROUGH_SYSTEM = `You are a senior engineer walking a reviewer through the key decisions of a code change, before they read it file by file. The tour already lists the decisions. For each one, help the reviewer understand it, see where it lives in the code, and read the few lines that build it, so they can accept or reject it on purpose.

For each key decision that code in the diff makes or carries out:
- title: the choice as a short claim.
- why: one or two sentences on why the change makes it, judged from the code, not the description.
- instead: the option it chose against.
- check: what the reviewer should hold the code to, such as the consequence if the choice is wrong, or a case it leaves out.
- snippets: 1-3 short slices of the diff, 2-12 lines each, in reading order: where the choice is made first, then where it takes effect. Mark the one line that makes the choice as focus. The caption says what the lines show; never paraphrase the code line by line. Add a note only for what the code does not say.
- tree: only when it helps the reviewer see how the decision connects. Use calls when the decision runs across functions on a call path, or when many callers now reach it (the callers are the rows). Use concepts when the decision defines a hierarchy, such as what counts and what does not, or which case resolves how. Otherwise use none. Most decisions need none. A row whose code a snippet shows points at that snippet, and the snippet appears under the row. Leave out logging, framework plumbing and small getters.
- refs: other places the decision reaches, one line each, when they are not already in a snippet or the tree.
- links: another key decision this one forces, enables or costs.

Skip a decision that no code in the diff shows, such as a change to a process or a dependency. Point slices and rows at the file id, the hunk id from its "@@ hunk" header, and new-file line numbers printed in the diff. When a diff is truncated or omitted, or the decision runs through code the diff does not show, call read_file to follow it rather than guess. Snippets still point only at lines the diff prints, and a row you found by reading takes line 0.

Call the submit tool once with the result.`;

export const CALL_PATH_SYSTEM = `You are a senior engineer walking a reviewer through the key code paths a code change adds or alters, before they read the change file by file: the paths a reviewer must follow to trust the change, not every path it touches. First draw them as an indented call tree, then read it in order and show the code at each stop, so the reviewer sees how the pieces connect across files.

The tree: start at an entry point a reviewer knows (a route or RPC handler, a job, a command, a component, an event listener) and go down to the new or changed functions it reaches; under each function, what it calls, in call order, one level deeper. Include every new or changed function on that path, and the unchanged callers needed to connect them (status same). Leave out logging, error helpers, framework plumbing and small getters. Use two or three entry points only when the change has separate key paths; each starts again at depth 0. Leave out a path that only repeats another or that a reviewer would not need to follow. Name functions as the code calls them: the receiver ("ScheduleCheck", "this.tools"), the method name, and its parameters as short names. Point each frame at the file id and the line number printed before its definition in the diff, or line 0 when the diff does not show it.

The steps: 2-5 steps that follow the tree top down. Each step names the frames it covers and shows 1-3 short slices of the diff: the changed lines that do the work at that step (the call that hands off to the next frame, or the new logic in the callee) with a line or two around them. Keep each slice under 25 lines; never a whole file. A step can show slices from different files when a call crosses them. Say what each step does in the change and how it leads to the next; skip anything the overview already says. Point each slice at the file id, the hunk id from its "@@ hunk" header, and the new-file line numbers printed in the diff.

When a diff is truncated or omitted, or the path runs through code the diff does not show, call read_file to follow it rather than guess. Frames and slices still point only at lines the diff prints; a frame you found by reading takes line 0.

Return no frames and no steps only when the change has no key code path to walk: styling, copy, config, a dependency bump, docs, tests only, a schema or data change with no new callers, or a change inside one function.

Call the submit tool once with the frames and the steps.`;

/**
 * The description check: its own call beside define, so the define prompt and its cache stay
 * as they are, and the check gets the model's full attention. A reviewer reads the description
 * first and trusts it; this finds where the diff disagrees with it: a claim the diff does not
 * do or contradicts, a behavior change it never mentions, or code that reaches past the scope it
 * states (a change called admin-only that edits code every user runs). Listing every claim and
 * every area first makes the model look at each one: asked as one more kind of decision in
 * define, it found nothing.
 */
export const DescriptionCheckSchema = v.object({
  claims: v.pipe(
    v.array(
      v.object({
        claim: short('One thing the title, description or commits say about the change, in a few words.'),
        status: v.pipe(
          v.picklist(['done', 'partly', 'missing', 'contradicted']),
          v.description(
            'done: the diff does it. partly: only some of it. missing: nothing in the diff does it. contradicted: the diff does something else.',
          ),
        ),
      }),
    ),
    v.description('Every claim the description makes. Empty when it makes none.'),
  ),
  stated: v.pipe(
    v.string(),
    v.description(
      'The scope the description states, in a few words: an audience, a product area, a platform, a flag that gates it, or a promise such as "no behavior change". Empty when it states none.',
    ),
  ),
  areas: v.pipe(
    v.array(
      v.object({
        area: short('A part of the code the diff changes, e.g. "admin email tools" or "shared rich text editor".'),
        fileIds: v.pipe(v.array(v.string()), v.description('Ids of the changed files in this area.')),
        reachedBy: short(
          'Who or what runs this code once merged: e.g. "staff in the admin app", "every web user who edits a note", "all callers of send_email".',
        ),
        described: v.pipe(
          v.boolean(),
          v.description(
            'True when the description describes or clearly implies this change, or it only supports a change it describes.',
          ),
        ),
        inScope: v.pipe(
          v.boolean(),
          v.description('False only when a scope is stated and someone or something in reachedBy is outside it.'),
        ),
      }),
    ),
    v.description('Every area of changed code, tests and docs left out.'),
  ),
  decisions: v.pipe(
    v.array(v.object({ text: decisionText, priority: decisionPriority })),
    v.description(
      'One decision per gap between the description and the diff; gaps with one cause share a decision. Empty when they agree.',
    ),
  ),
});

export const DESCRIPTION_CHECK_SYSTEM = `You are a senior engineer checking a code change against what its author says it does, before a reviewer approves it. The reviewer reads the title and description first and trusts them; find where the diff disagrees.

First, the claims. From the title, description and commits, list each thing they say about the change: what it adds, fixes or changes, whom or what it reaches, and what it leaves alone. Skip boilerplate, links, checklists and test plans. Check each claim against the diff: done, partly, missing (nothing in the diff does it) or contradicted (the diff does something else). Also write down the scope they state, if any: an audience (admin or staff only, internal tools, one platform, one customer), a product area, a flag or setting that gates it, or a promise such as "no behavior change" or "refactor only". If the title, description and commits say nothing about the change, list nothing and submit.

Then go through every area of changed code, using the file paths and the diffs. Say who or what runs it once merged, whether the description describes or clearly implies it, and whether it stays inside the stated scope. Edits that only support a described change (types, wiring, a renamed helper, tests) count as described. Code reaches past the stated scope when:
- users outside the stated audience or area run it: a screen, route, API or job in the product when the change says admin, staff or internal, or another platform or surface;
- it is shared: a component, editor, client, model, helper, service or function that other screens or code paths call. Shared code reaches all of its callers, not only the new one, even when the description says their behavior is unchanged: that promise is for the reviewer to check;
- the stated flag or role check does not guard it;
- it changes behavior in a change that promises none.

Last, write one decision for each gap a reviewer should know before approving:
- a claim that is missing, partly done or contradicted: what the description says and what the diff does instead;
- an area past the stated scope: what the description claims, what the diff also changes and who it reaches, e.g. "Described as admin-only, but the shared editor's save path changes for every user who edits a note.";
- an undescribed area that changes what users or callers see: what changes and who sees it.
Rate a gap urgent when it exposes data or access or loses stored data; high when users or existing callers get behavior the description does not lead the reviewer to expect, or a claimed fix or guard is not there; medium when shared code changes but every caller behaves as before, or a minor claim is partly done; low for a small unmentioned change. Write only gaps between what the description says and what the diff does: never a risk or limitation the description itself admits, and never a code-quality concern. A promise that shared code behaves as before is not an admitted risk: still write the shared change, for the reviewer to check. Write nothing where they agree, and never write that the code matches the description. The tour already lists the decisions under "Decisions the tour lists": skip any gap one of them already makes, even in other words.

Call the submit tool once with the result.`;

export const FOLLOWUP_SYSTEM = `You are placing the remaining files of a code change into review groups that already exist. Put every listed file into the existing group it fits best. Call the submit tool once with all placements.`;

export const NOTES_SYSTEM = `You are a senior engineer annotating one group of a code change for a reviewer.

Write a few precise notes where they save the reviewer real effort: non-obvious logic, subtle behavior changes, edge cases, risks, and things that look wrong but are not. Skip anything the code already says plainly. Most groups need 0-6 notes; quality over quantity.

On tests, note only what a test misses or could pass while the code is broken. Never describe what a test does.

Only reference file ids listed under "## Files". You see this group's hunks. When a hunk is cut off ("truncated"), a file is omitted or too large to show, or a changed line depends on code the diff does not show (a function it calls, a caller, a check it relies on), call read_file and read that code before you judge it. Never write that you could not see code: read it, or leave the point out. Describe other code only from what you read. Line notes reference a file id, the hunk id from the hunk header, and the line number printed before the line. Lines starting with "+" or " " use side "additions"; lines starting with "-" use side "deletions". Point notes and decisions only at lines a hunk prints; a finding in code you read goes on the hunk line that relies on it.

For documentation and agent guidance, note the rules or intent each change establishes or alters, so the reviewer can hold the code to them; flag instructions that are ambiguous or contradict each other.

When the prompt lists flagged risks, check each against the diff and write a risk note only for those the diff confirms.

Also list the key decisions this group makes in code, each on the line that makes it. A decision is a choice that a reasonable engineer could have made differently, and that a reviewer should agree with on purpose: an approach, a default, a data shape, a check or an ordering. Include ones the description states and ones you infer. Leaving something out counts: a missing check, limit, cache, backoff or failure report, pinned where it would go. Judge what the diff does, not what the description or a comment claims. Skip CSS and visual styling, layout, naming, refactors, unchanged behavior and anything that only describes what the code does. Never put a decision on a test, fixture or story file: record it where the code makes it. If a note names a risk in a choice this change makes, write it as a decision, not a note. Skip any choice the change-wide list already covers, even when you can point at its line. Before you submit, remove each decision that restates a change-wide one.

${ONE_WAY_DOORS}

${MIGRATION_PIN}

Call the submit tool once with the result.`;

/** Bump when a result schema above changes shape or field descriptions. */
const SCHEMA_VERSION = 19;

/** The description check's own version, so changing it keeps the other calls' caches. */
export const DESCRIPTION_CHECK_VERSION = hashOf({
  DESCRIPTION_CHECK_SYSTEM,
  TOTAL_BUDGET,
  FILE_BUDGET,
  schema: 4,
}).slice(0, 12);

/**
 * What a change reaches: the parts of the codebase it touches, then the screens, emails, APIs
 * and jobs people meet differently, found by following shared code to its callers with
 * search_code and read_file. Systems come first so the model looks for callers before it names
 * surfaces; only the surfaces reach the tour.
 */
export const AffectedResultSchema = v.object({
  systems: v.pipe(
    v.array(
      v.object({
        name: short(
          'A part of the codebase in the team\'s words, e.g. "Admin app", "Web capture editor", "Plain email client".',
        ),
        fileIds: v.pipe(v.array(v.string()), v.description('Ids of the changed files in this part.')),
        change: short('What the change does there, in one sentence.'),
        usedBy: v.pipe(
          v.array(v.string()),
          v.description(
            'Screens, routes, jobs or other code that import or call the changed code, from search_code or read_file. Empty when nothing else uses it.',
          ),
        ),
      }),
    ),
    v.description('Every part of the codebase the diff touches, largest change first. Leave out tests and docs.'),
  ),
  surfaces: v.pipe(
    v.array(
      v.object({
        surface: short(
          'A screen, route, email, notification, API or job a person meets, e.g. "Capture editor (web)", "Outgoing support emails".',
        ),
        audience: short(
          'Who meets it, in a few words, with any flag, role or platform that gates it: e.g. "admins", "web users with the ts-web-editor flag", "email recipients".',
        ),
        effect: v.pipe(
          v.picklist(['changes', 'unchanged']),
          v.description(
            'changes: what they see or get differs, or may differ. unchanged: shared code under it changed but it is meant to behave the same.',
          ),
        ),
        what: short('What they see or get differently, or what to check when it should be unchanged. One sentence.'),
        evidence: short(
          'The one file and line that ties the change to it, written only as file:line, e.g. "SupportCompose.tsx:118". No other words.',
        ),
      }),
    ),
    v.description(
      'Every surface a person meets whose behavior may differ after the change, including ones reached only through shared code. Empty when there is none, such as a change to tests or tooling.',
    ),
  ),
});

export const AFFECTED_SYSTEM = `You are a senior engineer mapping what a code change reaches, so a reviewer sees who will meet it differently once it ships.

First, the systems: group the changed files into the parts of the codebase a team member would name (an app, a service, a shared library, an admin tool, a job). Say what the change does in each, and list who imports or calls the changed code. "Callers found" lists, from the code, who imports the changed files and the packages the change bumps: go through every entry. For a changed file or package it leaves out, call find_importers; for a changed function or component name, call search_code. A caller is often itself shared: follow it up to the screen, route or job that mounts it, with find_importers or read_file, and read where it is mounted to find any flag, role or platform check that gates it.

Then, the surfaces: every screen, route, email, notification, public API or background job a person meets whose behavior may differ after the change, including ones reached only through shared code: a component other screens render, a helper other senders call. Say who meets it, and when a feature flag, role check, setting or platform gates it, name the gate in the audience. Say what they see or get differently. When shared code changes but a surface is meant to behave the same, list it as unchanged and say what to check. Name only surfaces you traced in the diff, a search or a read; never guess one. Skip tests, stories, docs and developer tooling.

Call the submit tool once with the result.`;

/** The affected call's own version, so changing it keeps the other calls' caches. */
export const AFFECTED_VERSION = hashOf({ AFFECTED_SYSTEM, TOTAL_BUDGET, FILE_BUDGET, schema: 3 }).slice(0, 12);

export const PROMPTS_VERSION = hashOf({
  DEFINE_SYSTEM,
  FOLLOWUP_SYSTEM,
  NOTES_SYSTEM,
  SKETCH_SYSTEM,
  WALKTHROUGH_SYSTEM,
  CALL_PATH_SYSTEM,
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

function budgetRank(file: FileChange): number {
  if (isGuidance(file)) {
    return 0;
  }
  if (looksLikeTest(file.path)) {
    return 3;
  }
  return file.status === 'removed' ? 2 : 1;
}

/** The change as the define-tier calls read it: a manifest of every file, then as many diffs as fit the budget. */
function changePrompt(meta: DiffMeta, files: readonly FileChange[]): string {
  const parts = [header(meta), '', `## Files (${files.length})`, ...files.map(manifestLine)];
  let remaining = TOTAL_BUDGET;
  const diffs: string[] = [];
  const omitted: string[] = [];
  // Guidance diffs go first so the budget never cuts the files that explain the change; then
  // the code that stays, so tests and deleted files are what a large change loses.
  const ordered = files.toSorted((a, b) => budgetRank(a) - budgetRank(b));
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
    parts.push('', `(Diffs omitted for budget: ${omitted.join(', ')}. Judge them by path and line counts.)`);
  }
  return parts.join('\n');
}

/** The prompt for defining groups. */
export function buildDefinePrompt(meta: DiffMeta, files: readonly FileChange[], withFiles: boolean): string {
  const ask = withFiles
    ? 'Define the review groups and assign every file id to exactly one group.'
    : 'Define the review groups. Do not list files; they are placed separately.';
  return `${changePrompt(meta, files)}\n\n${ask}`;
}

/** The prompt for the description check: the same view of the change as define. */
export function buildDescriptionCheckPrompt(
  meta: DiffMeta,
  files: readonly FileChange[],
  listed: readonly Pick<Decision, 'text'>[] = [],
): string {
  const already = listed.length
    ? `\n\n## Decisions the tour lists\n${listed.map((decision) => `- ${decision.text}`).join('\n')}`
    : '';
  return `${changePrompt(meta, files)}${already}\n\nCheck the change against what its title, description and commits say.`;
}

/** Importers found before the affected call, for one changed file or bumped package. */
export interface FoundCallers {
  label: string;
  lines: readonly string[];
}

/** Lines shown per file or package (import lines, gates and their importers); find_importers gives the rest. */
const CALLER_LINES = 40;

/**
 * The prompt for the affected call: the same view of the change as define, then who imports the
 * changed shared files and bumped packages, looked up in code so the model need not think to.
 */
export function buildAffectedPrompt(
  meta: DiffMeta,
  files: readonly FileChange[],
  callers: readonly FoundCallers[] = [],
): string {
  const found = callers.length
    ? `\n\n## Callers found\n${callers
        .map(({ label, lines }) => {
          const shown = lines.slice(0, CALLER_LINES);
          const more = lines.length > shown.length ? `\n... more; call find_importers for all of them` : '';
          return `### Importers of ${label}\n${shown.length ? shown.join('\n') + more : '(none outside this change)'}`;
        })
        .join('\n')}`
    : '';
  return `${changePrompt(meta, files)}${found}\n\nMap who meets this change differently.`;
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

/** The define prompt (header and diff) plus what the tour already says about the change. */
export function buildSketchPrompt(
  definePrompt: string,
  overallSummary: string,
  decisions: readonly { text: string }[],
): string {
  return [
    definePrompt,
    '',
    '## The tour so far',
    overallSummary,
    ...(decisions.length ? ['', 'Key decisions:', ...decisions.map((decision) => `- ${decision.text}`)] : []),
  ].join('\n');
}

/** Every code file's hunks with numbered lines, within the prompt budget. Guidance files define no calls. */
function numberedDiffs(files: readonly FileChange[]): string[] {
  const parts: string[] = [];
  let remaining = TOTAL_BUDGET;
  const omitted: string[] = [];
  for (const file of files) {
    if (collapsedReason(file) || isGuidance(file)) {
      continue;
    }
    let body = file.hunks.map(renderNumberedHunk).join('\n');
    const budget = Math.min(FILE_BUDGET, Math.max(remaining, 0));
    if (budget <= 500) {
      omitted.push(file.id);
      continue;
    }
    if (body.length > budget) {
      body = `${body.slice(0, budget)}\n... (truncated)`;
    }
    remaining -= body.length;
    parts.push(`### ${file.id} ${file.path}`, body);
  }
  if (omitted.length) {
    parts.push('', `(Diffs omitted for budget: ${omitted.join(', ')}.)`);
  }
  return parts;
}

/**
 * The change with numbered lines, so snippets and tree rows can point at them, plus the tour's
 * summary and its key decisions, numbered from 0.
 */
export function buildWalkthroughPrompt(
  meta: DiffMeta,
  files: readonly FileChange[],
  overallSummary: string,
  decisions: readonly Pick<Decision, 'text' | 'priority'>[],
): string {
  return [
    header(meta),
    '',
    `## Files (${files.length})`,
    ...files.map(manifestLine),
    '',
    '## Diffs',
    ...numberedDiffs(files),
    '',
    '## The tour so far',
    overallSummary,
    '',
    '## Key decisions',
    ...decisions.map((decision, index) => `${index}. (${decision.priority}) ${decision.text}`),
  ].join('\n');
}

/** The change with numbered lines, so the call tree and excerpts can point at them, plus the tour so far. */
export function buildCallPathPrompt(
  meta: DiffMeta,
  files: readonly FileChange[],
  overallSummary: string,
  decisions: readonly { text: string }[],
): string {
  return [
    header(meta),
    '',
    `## Files (${files.length})`,
    ...files.map(manifestLine),
    '',
    '## Diffs',
    ...numberedDiffs(files),
    '',
    '## The tour so far',
    overallSummary,
    ...(decisions.length ? ['', 'Key decisions:', ...decisions.map((decision) => `- ${decision.text}`)] : []),
  ].join('\n');
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
      body = budget > 500 ? `${body.slice(0, budget)}\n... (truncated)` : '(omitted for budget; read_file it)';
    }
    remaining -= body.length;
    parts.push(`### ${manifestLine(file)}`, body);
  }
  return parts.join('\n');
}

export const ASK_SYSTEM = `You are the senior engineer who wrote this guided review tour of a code change. A reviewer reading the tour asks you questions about the change. Answer from the diff, the tour and, when you need more, the whole files (call read_file).

Answer the question first, in a few short paragraphs or a short list. Say what the code does, not what it might do; if the diff does not show something, say so instead of guessing. Do not repeat the tour back.

Cite the lines you rely on as Markdown links whose target is the file id and line number from the numbered diff: [repos.ts:121](f1a2b3:121) for a line on the new side, [repos.ts:40](f1a2b3:-40) for a removed line. Cite only lines shown in the diff below or returned by read_file.`;

/** The context of one question: the tour, the numbered diff, the thread so far, then the question. */
export function buildAskPrompt(input: {
  meta: DiffMeta;
  files: readonly FileChange[];
  tour: {
    overallSummary?: string;
    decisions?: readonly Decision[];
    groups: readonly ResolvedGroup[];
    notes: Record<
      string,
      {
        fileNotes: readonly { fileId: string; text: string }[];
        lineNotes: readonly { fileId: string; side: string; line: number; text: string }[];
      }
    >;
  };
  history: readonly { question: string; context?: string; answer: string }[];
  question: string;
  context?: string;
}): string {
  // The tour and the diff come first and never change for a tour, so provider prompt caches hit on follow-ups.
  const parts = [header(input.meta)];
  if (input.tour.overallSummary) {
    parts.push('', '## Overall', input.tour.overallSummary);
  }
  if (input.tour.decisions?.length) {
    parts.push('', '## Decisions', ...input.tour.decisions.map((decision) => `- ${decision.text}`));
  }
  parts.push('', '## Tour groups');
  for (const group of input.tour.groups) {
    parts.push('', `### ${group.key}: ${group.label}`, group.summary, `Files: ${group.fileIds.join(', ')}`);
    const notes = input.tour.notes[group.key];
    for (const note of notes?.fileNotes ?? []) {
      parts.push(`- ${note.fileId}: ${note.text}`);
    }
    for (const note of notes?.lineNotes ?? []) {
      parts.push(`- ${note.fileId}:${note.side === 'deletions' ? '-' : ''}${note.line}: ${note.text}`);
    }
  }
  let remaining = TOTAL_BUDGET;
  parts.push('', '## Files');
  for (const file of input.files) {
    const reason = collapsedReason(file);
    if (reason) {
      parts.push(`### ${manifestLine(file)}`);
      continue;
    }
    let body = file.hunks.map(renderNumberedHunk).join('\n');
    const budget = Math.min(FILE_BUDGET, Math.max(remaining, 0));
    if (body.length > budget) {
      body =
        budget > 500
          ? `${body.slice(0, budget)}\n... (truncated; call read_file for the rest)`
          : '(omitted for budget; call read_file)';
    }
    remaining -= body.length;
    parts.push(`### ${manifestLine(file)}`, body);
  }
  if (input.history.length) {
    parts.push('', '## Conversation so far');
    for (const turn of input.history) {
      parts.push(
        '',
        `Reviewer${turn.context ? ` (about ${turn.context})` : ''}: ${turn.question}`,
        '',
        `You: ${turn.answer}`,
      );
    }
  }
  parts.push('', `## Question${input.context ? ` about ${input.context}` : ''}`, input.question);
  return parts.join('\n');
}
