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
    'Key decisions about the change as a whole: product behavior, scope, rollout, and tradeoffs that span several files. Most changes have 1-4. Leave out choices that one line or one function makes; a later pass pins those to their lines.',
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
 * The call-tree candidate, from its own call: it needs line numbers, which only a numbered
 * diff gives, and a path read end to end rather than a summary. Flat rows with a depth,
 * because tool schemas draw recursion poorly.
 */
export const CallstackSchema = v.pipe(
  v.object({
    caption: short('One sentence under 25 words saying what path the tree shows. No Markdown. Empty when frames is.'),
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
        'The call tree, top down: each frame is followed by what it calls, one level deeper, in call order. 4-14 frames. Empty when the change adds or alters no call path.',
      ),
    ),
  }),
  v.description('The call path the change adds or alters, as an indented call tree.'),
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

/**
 * How to draw the sketch, from the bake-off's hand-drawn figures (the style Brian liked) and
 * the artifact diagramming guidance.
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

Split the change into review groups a reviewer can read one at a time. Group by intention (one feature, fix or refactor per group), not by file type or directory. Keep groups few: 2-7 for most changes, one for a small focused change. Fold small supporting edits (formatting, field order, a dependency added for the feature, styles for a component) into the group they support instead of giving them their own group. Tests belong with the code they test unless they are the point of the change; generated files may be their own group.

Documentation and agent guidance (files marked [guidance]: AGENTS.md, CLAUDE.md, .agents/, agent skills and SKILL.md, editor and agent rules, docs/, READMEs) are important. They state the intent of the change and the rules the code is meant to follow, so a reviewer reads them first. Put them together in one group with category "docs", first in the order, and summarize the intent or rules they establish, not just that docs changed.

Write labels and summaries for a reviewer who has not seen the change. Explain why, not what. After the docs group, order groups so the core change comes first.

Also list the key decisions the change makes as a whole. A decision is a choice that a reasonable engineer could have made differently, and that a reviewer should agree with on purpose: product behavior, scope, a tradeoff, or what is deferred. Take them from the description where it states them, and infer the rest from the diff. List only choices that span several files or no file: if one file makes the choice, leave it out, because a later pass pins it to its line. Skip styling, layout, naming and dependency versions. Do not describe what the code does. Give each decision the key of the group it is mostly about; leave the key out only for a decision about the change as a whole.

Then propose two candidate visuals of the main decision, drawn from data; only one picture will be shown. Make them differ in kind or angle so there is a real choice. Add them whenever the change has any of these: a design replaced by another (before-after: a small diagram of the old flow or structure next to one of the new), events whose order or timing matters (timeline: a timer, a lifecycle event, a race, a retry, a walk that now stops somewhere), or a flow or state machine of three or more steps that the change adds or alters (mermaid). Most features and behavior fixes have one of these. Draw the decision, not the file list or the call graph, and use the reviewer's words, not code dumps. A picture must show structure (flow, branching, order or timing) that a bulleted list would lose; never restate the summary as rows of text. Use kind "none" in a slot only when you have nothing different to draw, and in both only when none of these applies, such as a rename, a styling tweak, a dependency bump or a docs-only change.

Call the submit tool once with the complete result.`;

export const SKETCH_SYSTEM = `You are a senior engineer drawing the one figure a reviewer sees first in a guided review tour of a code change: an explainer of its main decision, like a figure in a design doc. Read the change and the tour's summary and decisions, find the mechanism the decision changes, then draw it.

${SKETCH_GUIDE}

Call the submit tool once with the caption and the svg.`;

export const CALLSTACK_SYSTEM = `You are a senior engineer drawing the call path a code change adds or alters, as an indented call tree a reviewer reads before the diff: the entry point at the top, and under each function what it calls, in the order it calls them, one level deeper.

Follow the path the change is about from an entry point a reviewer knows (a route or RPC handler, a job, a command, a component, an event listener) down to the new or changed functions it reaches. Include every new or changed function on that path, and the unchanged callers needed to connect them (status same). Leave out logging, error helpers, framework plumbing and small getters, and functions the change does not touch unless they connect the path. Use two or three entry points only when the change adds separate paths, such as one that creates a record and one that fires it later; each starts again at depth 0.

Name functions as the code calls them: the receiver the call is made on ("ScheduleCheck", "permission", "this.tools"), the method name, and its parameters as short names. Point each frame at the file id and line number printed before its definition in the diff; use line 0 when the diff does not show the definition.

Return no frames when the change has no call path to draw: styling, copy, config, a dependency bump, docs, tests only, a schema or data change with no new callers, or a change inside one function. A tree with one frame is a list; draw at least two levels.

Call the submit tool once with the caption and the frames.`;

export const FOLLOWUP_SYSTEM = `You are placing the remaining files of a code change into review groups that already exist. Put every listed file into the existing group it fits best. Call the submit tool once with all placements.`;

export const NOTES_SYSTEM = `You are a senior engineer annotating one group of a code change for a reviewer.

Write a few precise notes where they save the reviewer real effort: non-obvious logic, subtle behavior changes, edge cases, risks, and things that look wrong but are not. Skip anything the code already says plainly. Most groups need 0-6 notes; quality over quantity.

Only reference file ids listed under "## Files"; other files belong to other groups. Line notes reference a file id, the hunk id from the hunk header, and the line number printed before the line. Lines starting with "+" or " " use side "additions"; lines starting with "-" use side "deletions".

For documentation and agent guidance, note the rules or intent each change establishes or alters, so the reviewer can hold the code to them; flag instructions that are ambiguous or contradict each other.

When the prompt lists flagged risks, check each against the diff and write a risk note only for those the diff confirms.

Separately from notes, list the key decisions this group makes in code, each on the line that makes it. A decision is a choice that a reasonable engineer could have made differently, and that a reviewer should agree with on purpose: an approach, a default, a data shape, a check or an ordering. Include ones the description states and ones you infer. Skip CSS and visual styling, layout, naming, refactors, error handling details and anything that only describes what the code does. Never put a decision on a test, fixture or story file: record it where the code makes it. Skip any choice the change-wide list already covers, even when you can point at its line. Before you submit, remove each decision that restates a change-wide one.

Call the submit tool once with the result.`;

/** Bump when a result schema above changes shape or field descriptions. */
const SCHEMA_VERSION = 16;

export const PROMPTS_VERSION = hashOf({
  DEFINE_SYSTEM,
  FOLLOWUP_SYSTEM,
  NOTES_SYSTEM,
  SKETCH_SYSTEM,
  CALLSTACK_SYSTEM,
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

/**
 * The change with numbered lines, so frames can point at definitions, plus what the tour
 * already says about it. Guidance files are left out: they define no calls.
 */
export function buildCallstackPrompt(
  meta: DiffMeta,
  files: readonly FileChange[],
  overallSummary: string,
  decisions: readonly { text: string }[],
): string {
  const parts = [header(meta), '', `## Files (${files.length})`, ...files.map(manifestLine)];
  let remaining = TOTAL_BUDGET;
  const omitted: string[] = [];
  parts.push('', '## Diffs');
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
  parts.push(
    '',
    '## The tour so far',
    overallSummary,
    ...(decisions.length ? ['', 'Key decisions:', ...decisions.map((decision) => `- ${decision.text}`)] : []),
  );
  return parts.join('\n');
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
