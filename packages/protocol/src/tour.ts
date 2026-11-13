import * as v from 'valibot';
import { DiffMetaSchema, DiffSideSchema, FileSummarySchema } from './diff.ts';
import { SourceRefSchema } from './source-ref.ts';

/**
 * Which part of the system a group touches: one language-agnostic axis so every group
 * gets a recognizable icon (taken from pulls.review).
 */
export const CATEGORIES = [
  'ui',
  'api',
  'core',
  'data',
  'cli',
  'security',
  'tests',
  'docs',
  'examples',
  'deps',
  'build',
  'scripts',
  'config',
  'i18n',
  'assets',
  'other',
] as const;
export const CategorySchema = v.picklist(CATEGORIES);
export type Category = v.InferOutput<typeof CategorySchema>;

export const CATEGORY_GUIDE: Record<Category, string> = {
  ui: 'components, views, styles, layout.',
  api: 'endpoints, handlers, contracts between services or packages, third-party integrations.',
  core: "domain/business logic and internal modules; use only when ui/api/data/cli don't fit.",
  data: 'schemas, migrations, models, queries, storage.',
  cli: 'command-line entry points, arg parsing, terminal output.',
  security: 'auth, permissions, secrets handling, input validation.',
  tests: 'tests, fixtures, snapshots, stories, benchmarks.',
  docs: 'README, guides, changelog, comment-only edits.',
  examples: 'examples, playgrounds, demos.',
  deps: 'dependency bumps, lockfiles.',
  build: 'bundler/compiler/toolchain config, package manifests.',
  scripts: 'dev and one-off scripts, automation under bin/ or tools/.',
  config: 'runtime config, env, feature flags, linter config, CI/CD, deployment, containers, IaC.',
  i18n: 'translations, locales.',
  assets: 'images, fonts, static files.',
  other: 'generated/vendored code or anything that fits nothing above.',
};

/** A review group as the LLM defined it, without its files (Jev and code place those). */
export const GroupDefinitionSchema = v.object({
  key: v.string(),
  label: v.string(),
  summary: v.string(),
  category: CategorySchema,
});
export type GroupDefinition = v.InferOutput<typeof GroupDefinitionSchema>;

/**
 * Groups code adds on its own. `guidance` leads the tour; the others sort after the
 * LLM's groups, in this order.
 */
export const SYNTHETIC_GROUPS = {
  guidance: {
    key: 'guidance',
    label: 'Docs & agent guidance',
    summary:
      'Documentation and instructions for agents and contributors. Read these first: they state the intent and the rules the code should follow.',
    category: 'docs',
  },
  tests: { key: 'tests', label: 'Tests', summary: 'Tests, fixtures and stories.', category: 'tests' },
  generated: {
    key: 'generated',
    label: 'Generated',
    summary: 'Files produced by tools rather than written by hand.',
    category: 'other',
  },
  uncategorized: {
    key: 'uncategorized',
    label: 'Other changes',
    summary: 'Files no other group claimed.',
    category: 'other',
  },
} as const satisfies Record<string, GroupDefinition>;

export const RISK_KEYS = ['authCheck', 'storedData', 'secretsSigning', 'personalData'] as const;
export type RiskKey = (typeof RISK_KEYS)[number];

export const RISK_LABELS: Record<RiskKey, string> = {
  authCheck: 'Changes an auth or permission check',
  storedData: 'Changes stored data or a schema',
  secretsSigning: 'Touches secrets or signing keys',
  personalData: 'Changes personal data handling',
};

const probability = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

/** Jev's per-file answers. Each is a probability; `group` is filled once groups are defined. */
export const FileJudgmentSchema = v.object({
  generated: v.optional(probability),
  testsOnly: v.optional(probability),
  authCheck: v.optional(probability),
  storedData: v.optional(probability),
  secretsSigning: v.optional(probability),
  personalData: v.optional(probability),
  group: v.optional(
    v.object({
      choice: v.string(),
      confidence: probability,
      probabilities: v.record(v.string(), v.number()),
    }),
  ),
  fitsAnyGroup: v.optional(probability),
});
export type FileJudgment = v.InferOutput<typeof FileJudgmentSchema>;

export const PlacementReasonSchema = v.picklist([
  'heuristic',
  'guidance',
  'gitattributes',
  'jev',
  'llm',
  'llm-followup',
  'uncategorized',
]);
export type PlacementReason = v.InferOutput<typeof PlacementReasonSchema>;

export const PlacementSchema = v.object({
  groupKey: v.string(),
  reason: PlacementReasonSchema,
  confidence: v.optional(v.number()),
});
export type Placement = v.InferOutput<typeof PlacementSchema>;

export const ResolvedGroupSchema = v.object({
  ...GroupDefinitionSchema.entries,
  critical: v.boolean(),
  fileIds: v.array(v.string()),
  synthetic: v.optional(v.boolean()),
});
export type ResolvedGroup = v.InferOutput<typeof ResolvedGroupSchema>;

export const FileNoteSchema = v.object({
  fileId: v.string(),
  text: v.string(),
  critical: v.optional(v.boolean()),
});
export type FileNote = v.InferOutput<typeof FileNoteSchema>;

export const LineNoteSchema = v.object({
  fileId: v.string(),
  hunkId: v.string(),
  side: DiffSideSchema,
  line: v.number(),
  text: v.string(),
  critical: v.optional(v.boolean()),
});
export type LineNote = v.InferOutput<typeof LineNoteSchema>;

export const RiskNoteSchema = v.object({
  fileId: v.string(),
  risk: v.picklist(RISK_KEYS),
  text: v.string(),
});
export type RiskNote = v.InferOutput<typeof RiskNoteSchema>;

/** Linear's priority scale, most urgent first. */
export const DECISION_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export const DecisionPrioritySchema = v.picklist(DECISION_PRIORITIES);
export type DecisionPriority = v.InferOutput<typeof DecisionPrioritySchema>;

/**
 * A choice the change makes that a reviewer should agree with on purpose. With no
 * `fileId` it is not tied to code: with `groupKey` it belongs to that group's section,
 * without it to the change as a whole. With `fileId` but no `line` it is about that file;
 * with all of them it sits on that line.
 */
export const DecisionSchema = v.object({
  text: v.string(),
  priority: DecisionPrioritySchema,
  fileId: v.optional(v.string()),
  hunkId: v.optional(v.string()),
  side: v.optional(DiffSideSchema),
  line: v.optional(v.number()),
  groupKey: v.optional(v.string()),
  /** `description`: a gap between the PR's description and its diff, from the description check. */
  source: v.optional(v.picklist(['description'])),
});
export type Decision = v.InferOutput<typeof DecisionSchema>;

/**
 * A screen, email, API or job that people meet differently after the change, found by following
 * the changed code to where it is used. `unchanged`: shared code under it changed but it is meant
 * to behave the same, so the reviewer checks that it does.
 */
export const AffectedSchema = v.object({
  surface: v.string(),
  /** Who meets it, with any flag, role or platform that gates it. */
  audience: v.string(),
  effect: v.picklist(['changes', 'unchanged']),
  /** What they see or get differently, or what to check when it should be unchanged. */
  what: v.string(),
  /** The file and line that tie the change to it, e.g. `SupportCompose.tsx:118`. */
  evidence: v.optional(v.string()),
});
export type Affected = v.InferOutput<typeof AffectedSchema>;

/** Where something sits on a timeline: 0 is its left edge, 100 its right. */
const position = v.pipe(v.number(), v.minValue(0), v.maxValue(100));

export const TimelineSpanSchema = v.object({
  from: position,
  to: position,
  text: v.string(),
  tone: v.optional(v.picklist(['accent', 'muted', 'bad'])),
});
export const TimelineLaneSchema = v.object({
  label: v.string(),
  spans: v.array(TimelineSpanSchema),
  outcome: v.optional(v.object({ at: position, text: v.string(), tone: v.picklist(['good', 'bad']) })),
});

/**
 * One function on a call path, in a call tree read top down: a frame's callees follow it,
 * one level deeper. `path` and `line` point at its definition, when the diff shows it.
 */
export const CallFrameSchema = v.object({
  /** 0 for an entry point; never more than one deeper than the frame before. */
  depth: v.number(),
  /** What it is called on, e.g. `ScheduleCheck` or `this.tools`; absent for a plain function. */
  receiver: v.optional(v.string()),
  name: v.string(),
  /** Its parameters, short, e.g. `session, check` or `...`. */
  args: v.optional(v.string()),
  path: v.optional(v.string()),
  line: v.optional(v.number()),
  /** `same` frames are unchanged callers, shown only to connect the path to an entry point. */
  status: v.picklist(['new', 'changed', 'same']),
});
export type CallFrame = v.InferOutput<typeof CallFrameSchema>;

/** A slice of one hunk: its new-side lines `from`..`to`, both shown in the hunk. */
export const ExcerptSchema = v.object({
  fileId: v.string(),
  hunkId: v.string(),
  from: v.number(),
  to: v.number(),
});
export type Excerpt = v.InferOutput<typeof ExcerptSchema>;

/** One stop on a call path: a sentence, the call-tree frames it covers, and short excerpts from any files. */
export const WalkStepSchema = v.object({
  title: v.string(),
  text: v.string(),
  /** Indexes into the walkthrough's `frames`. */
  frames: v.array(v.number()),
  excerpts: v.array(ExcerptSchema),
});
export type WalkStep = v.InferOutput<typeof WalkStepSchema>;

/**
 * A few lines of one hunk that show how a decision is built: new-side lines `from`..`to`, the
 * line `focus` among them where the choice is made, a one-sentence `caption` on what the lines
 * show, and at most one `note` pinned under `focus`.
 */
export const SnippetSchema = v.object({
  fileId: v.string(),
  hunkId: v.string(),
  from: v.number(),
  to: v.number(),
  focus: v.number(),
  caption: v.string(),
  note: v.optional(v.string()),
});
export type Snippet = v.InferOutput<typeof SnippetSchema>;

/**
 * A row of a decision's tree, read top down like a call tree: a call (a `CallFrame`) when the
 * decision sits on a call path, or a concept when it is a hierarchy (what counts, which case
 * resolves how). `snippet` indexes the decision's snippets: it shows under this row.
 */
export const DecisionNodeSchema = v.variant('kind', [
  v.object({
    kind: v.literal('call'),
    ...CallFrameSchema.entries,
    note: v.optional(v.string()),
    snippet: v.optional(v.number()),
  }),
  v.object({
    kind: v.literal('concept'),
    depth: v.number(),
    label: v.string(),
    note: v.optional(v.string()),
    path: v.optional(v.string()),
    line: v.optional(v.number()),
    snippet: v.optional(v.number()),
  }),
]);
export type DecisionNode = v.InferOutput<typeof DecisionNodeSchema>;

/**
 * One change-wide decision read in code: why it was made, what it chose against, what to check,
 * then the snippets that build it, hung under a tree when the decision has one. `refs` are the
 * rest of its reach, one line each; `links` tie it to other decisions.
 */
export const DecisionWalkSchema = v.object({
  /** Index into the tour's `decisions`. */
  decision: v.number(),
  title: v.string(),
  why: v.string(),
  instead: v.optional(v.string()),
  check: v.optional(v.string()),
  tree: v.optional(v.array(DecisionNodeSchema)),
  snippets: v.array(SnippetSchema),
  refs: v.array(v.object({ label: v.string(), fileId: v.string(), line: v.optional(v.number()) })),
  /** `to` indexes the tour's `decisions`. */
  links: v.array(v.object({ to: v.number(), text: v.string() })),
});
export type DecisionWalk = v.InferOutput<typeof DecisionWalkSchema>;

/**
 * The change's key decisions read in code, in the order of the tour's `decisions`, then a call
 * tree (`frames`) read in `steps` for the important paths the decisions do not walk. Each part
 * may be empty, and tours from before either part read it as empty. Read-only; notes and
 * comments stay in the groups.
 */
export const WalkthroughSchema = v.object({
  decisions: v.optional(v.array(DecisionWalkSchema), []),
  frames: v.optional(v.array(CallFrameSchema), []),
  steps: v.optional(v.array(WalkStepSchema), []),
});
export type Walkthrough = v.InferOutput<typeof WalkthroughSchema>;

/**
 * One picture of the change's main decision, drawn by the client so every tour looks
 * the same: the old flow next to the new one (two small Mermaid diagrams), lanes over
 * time, one small Mermaid flowchart or state diagram, or a hand-drawn sanitized SVG. Never a text list: the
 * overview's prose already says that. `caption` is one sentence under it.
 */
export const VisualSchema = v.variant('kind', [
  v.object({
    kind: v.literal('before-after'),
    caption: v.optional(v.string()),
    /** Mermaid source of the old flow. */
    before: v.string(),
    /** Mermaid source of the new flow, laid out like `before` so the difference shows. */
    after: v.string(),
  }),
  v.object({
    kind: v.literal('timeline'),
    caption: v.optional(v.string()),
    markers: v.array(v.object({ at: position, text: v.string() })),
    lanes: v.array(TimelineLaneSchema),
  }),
  v.object({ kind: v.literal('mermaid'), caption: v.optional(v.string()), source: v.string() }),
  /** A hand-drawn picture, already sanitized to plain shapes and text; shown only as an image. */
  v.object({ kind: v.literal('svg'), caption: v.optional(v.string()), svg: v.string() }),
]);
export type Visual = v.InferOutput<typeof VisualSchema>;

/**
 * One stop of a group's walk: a decision the group makes, or a step that shows how a piece
 * works, read in a few lines of code like a walkthrough decision. `decision` indexes the
 * group's `decisions` when the stop reads one of them.
 */
export const SectionPointSchema = v.object({
  /** `wide`: a change-wide decision read here, the walkthrough entry for decision number `wide`. */
  kind: v.picklist(['decision', 'step', 'wide']),
  decision: v.optional(v.number()),
  wide: v.optional(v.number()),
  priority: v.optional(DecisionPrioritySchema),
  title: v.string(),
  why: v.string(),
  instead: v.optional(v.string()),
  check: v.optional(v.string()),
  /** A tree the snippets hang under, when the stop runs across calls or defines a hierarchy. */
  tree: v.optional(v.array(DecisionNodeSchema)),
  /** A stop read as its claim alone (no snippets): where its code is, already shown above or open below. */
  see: v.optional(v.object({ fileId: v.string(), line: v.number() })),
  snippets: v.array(SnippetSchema),
});
export type SectionPoint = v.InferOutput<typeof SectionPointSchema>;

/**
 * A group read like the overview and walkthrough, above its open diffs: an optional sentence
 * tying it to the tour so far, its stops in reading order, and what a reviewer can skip below.
 * The change-wide decisions and the key code path are read in the group that holds their code.
 */
export const SectionSchema = v.object({
  intro: v.optional(v.string()),
  points: v.array(SectionPointSchema),
  /** One sentence on what the walk leaves to the diffs below it. */
  rest: v.optional(v.string()),
  /** The key code path is read above this group's stops. */
  path: v.optional(v.boolean()),
  /** Files a reviewer can skip (mechanical, renames, generated); they start folded. */
  skim: v.optional(v.array(v.string())),
  /** Hunks a reviewer can skip inside files that stay open, folded under one line in their file. */
  skimHunks: v.optional(v.array(v.object({ fileId: v.string(), hunkId: v.string() }))),
  /** Hunks flagged where nothing else in the tour points at them, shown as a note on `line`. */
  hunkFlags: v.optional(
    v.array(
      v.object({
        fileId: v.string(),
        hunkId: v.string(),
        side: DiffSideSchema,
        line: v.number(),
        flag: v.picklist(['contract']),
      }),
    ),
  ),
});
export type Section = v.InferOutput<typeof SectionSchema>;

export const GroupNotesSchema = v.object({
  fileNotes: v.array(FileNoteSchema),
  lineNotes: v.array(LineNoteSchema),
  riskNotes: v.array(RiskNoteSchema),
  /** Decisions in this group's files. Absent in tours written before decisions existed. */
  decisions: v.optional(v.array(DecisionSchema)),
  /** The group's walk; absent until it is written, and in tours from before walks existed. */
  section: v.optional(SectionSchema),
});
export type GroupNotes = v.InferOutput<typeof GroupNotesSchema>;

export const ModelConfigSchema = v.object({
  define: v.string(),
  followup: v.string(),
  notes: v.string(),
  judge: v.optional(v.string()),
});
export type ModelConfig = v.InferOutput<typeof ModelConfigSchema>;

/** The finished tour. Everything a client needs to render it with no other events. */
export const TourSchema = v.object({
  diffId: v.string(),
  ref: SourceRefSchema,
  meta: DiffMetaSchema,
  files: v.array(FileSummarySchema),
  overallSummary: v.optional(v.string()),
  /** Decisions about the change as a whole, not tied to a file. */
  decisions: v.optional(v.array(DecisionSchema)),
  /**
   * Pictures of the change's main decision, when they help: usually one, two only when Jev
   * rates both highly and they differ in kind.
   */
  visuals: v.optional(v.array(VisualSchema)),
  /** The single picture of tours written before `visuals`; read as `visuals: [visual]`. */
  visual: v.optional(VisualSchema),
  /** The change-wide decisions read in code, and the call paths they do not walk, when there are any. */
  walkthrough: v.optional(WalkthroughSchema),
  /** What people meet differently after the change. Absent in tours written before it, or when the call failed. */
  affected: v.optional(v.array(AffectedSchema)),
  groups: v.array(ResolvedGroupSchema),
  placements: v.record(v.string(), PlacementSchema),
  judgments: v.record(v.string(), FileJudgmentSchema),
  notes: v.record(v.string(), GroupNotesSchema),
  models: ModelConfigSchema,
});
export type Tour = v.InferOutput<typeof TourSchema>;
