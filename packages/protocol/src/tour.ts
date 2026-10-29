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
  exportedSignature: v.optional(probability),
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
 * `fileId` it is about the change as a whole; with `fileId` but no `line` it is about
 * that file; with all of them it sits on that line.
 */
export const DecisionSchema = v.object({
  text: v.string(),
  priority: DecisionPrioritySchema,
  fileId: v.optional(v.string()),
  hunkId: v.optional(v.string()),
  side: v.optional(DiffSideSchema),
  line: v.optional(v.number()),
});
export type Decision = v.InferOutput<typeof DecisionSchema>;

export const GroupNotesSchema = v.object({
  fileNotes: v.array(FileNoteSchema),
  lineNotes: v.array(LineNoteSchema),
  riskNotes: v.array(RiskNoteSchema),
  /** Decisions in this group's files. Absent in tours written before decisions existed. */
  decisions: v.optional(v.array(DecisionSchema)),
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
  groups: v.array(ResolvedGroupSchema),
  placements: v.record(v.string(), PlacementSchema),
  judgments: v.record(v.string(), FileJudgmentSchema),
  notes: v.record(v.string(), GroupNotesSchema),
  models: ModelConfigSchema,
});
export type Tour = v.InferOutput<typeof TourSchema>;
