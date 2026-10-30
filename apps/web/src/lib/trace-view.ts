import type { StepKind, Trace, TraceStep } from '@gloss/protocol';

/** What a step is called, and who does it (colors the dot): the define-tier LLM, Jev, code, or the notes LLM. */
export const STEP_KINDS: Record<StepKind, { label: string; tag: string; actor: 'code' | 'llm' | 'jev' | 'notes' }> = {
  fetch: { label: 'Diff', tag: 'Diff', actor: 'code' },
  define: { label: 'Define', tag: 'Define', actor: 'llm' },
  sketch: { label: 'Sketch', tag: 'Sketch', actor: 'llm' },
  callstack: { label: 'Call stack', tag: 'Calls', actor: 'llm' },
  'judge-files': { label: 'Judge files', tag: 'Jev', actor: 'jev' },
  'judge-groups': { label: 'Judge groups', tag: 'Jev', actor: 'jev' },
  'judge-visual': { label: 'Pick visual', tag: 'Jev', actor: 'jev' },
  place: { label: 'Place', tag: 'Place', actor: 'code' },
  followup: { label: 'Follow-up', tag: 'Follow-up', actor: 'llm' },
  notes: { label: 'Notes', tag: 'Notes', actor: 'notes' },
};

export interface GraphNode {
  step: TraceStep;
  x: number;
  y: number;
}

export interface GraphLayout {
  nodes: GraphNode[];
  width: number;
  height: number;
}

export const NODE = { width: 132, height: 46, gapX: 12, gapY: 34, perRow: 3 } as const;

/**
 * Layers the DAG top to bottom: a step sits one layer below its deepest input. A layer
 * wider than `perRow` wraps, so a tour with many groups grows down, not sideways.
 */
export function layoutGraph(steps: readonly TraceStep[], width: number): GraphLayout {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const depth = new Map<string, number>();
  const depthOf = (step: TraceStep, seen: Set<string>): number => {
    const known = depth.get(step.id);
    if (known !== undefined) {
      return known;
    }
    seen.add(step.id);
    const inputs = step.inputs.map((id) => byId.get(id)).filter((input) => input && !seen.has(input.id));
    const value = inputs.length ? 1 + Math.max(...inputs.map((input) => depthOf(input!, seen))) : 0;
    depth.set(step.id, value);
    return value;
  };
  const layers: TraceStep[][] = [];
  for (const step of steps) {
    (layers[depthOf(step, new Set())] ??= []).push(step);
  }
  const nodes: GraphNode[] = [];
  let y = 0;
  for (const layer of layers.filter(Boolean)) {
    for (let start = 0; start < layer.length; start += NODE.perRow) {
      const row = layer.slice(start, start + NODE.perRow);
      const rowWidth = row.length * NODE.width + (row.length - 1) * NODE.gapX;
      let x = Math.max(0, (width - rowWidth) / 2);
      for (const step of row) {
        nodes.push({ step, x, y });
        x += NODE.width + NODE.gapX;
      }
      y += NODE.height + NODE.gapY;
    }
  }
  return { nodes, width, height: Math.max(0, y - NODE.gapY) };
}

/** The step the inspector opens on: the one asked for, else the first notes call, else the last step. */
export function selectedStep(steps: readonly TraceStep[], id: string | undefined): TraceStep | undefined {
  return steps.find((step) => step.id === id) ?? steps.find((step) => step.kind === 'notes') ?? steps.at(-1);
}

export function stepTitle(step: TraceStep): string {
  const { label } = STEP_KINDS[step.kind];
  return step.subject ? `${label} · ${step.subject}` : label;
}

export function duration(step: TraceStep): string | undefined {
  if (step.endMs === undefined) {
    return undefined;
  }
  const ms = step.endMs - step.startMs;
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const tokens = (count: number) => (count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count));

/** The inspector's one-line facts about a call: model, time, tokens, and whether it was fresh. */
export function stepFacts(step: TraceStep): string {
  return [
    step.model,
    duration(step),
    step.usage && `${tokens(step.usage.input)} in / ${tokens(step.usage.output)} out`,
    step.cached === undefined ? undefined : step.cached ? 'cached' : 'fresh',
  ]
    .filter(Boolean)
    .join(' · ');
}

export interface PromptLine {
  text: string;
  /** The step this line came from, when it is not the step's own instruction. */
  from?: string;
  /** Set on the first line of a section, where its source is named. */
  tag?: string;
}

/** The prompt's lines, each marked with the input step it came from (`sections` from the backend). */
export function promptLines(step: TraceStep, steps: readonly TraceStep[]): PromptLine[] {
  const kindOf = new Map(steps.map((other) => [other.id, other.kind]));
  const sections = step.sections ?? [];
  let next = 0;
  let from: string | undefined;
  return (step.prompt ?? '').split('\n').map((text, line) => {
    let tag: string | undefined;
    while (next < sections.length && sections[next]!.line <= line) {
      const source = sections[next]!.from;
      from = source === step.id ? undefined : source;
      const kind = from ? kindOf.get(from) : undefined;
      tag = kind ? STEP_KINDS[kind].tag : undefined;
      next++;
    }
    return { text, from, tag };
  });
}

/** Once the job has ended, a step still marked running was interrupted: show it as stopped, not running. */
export function settled(trace: Trace): Trace {
  if (!trace.done) {
    return trace;
  }
  return {
    ...trace,
    steps: trace.steps.map((step) =>
      step.state === 'running'
        ? { ...step, state: 'failed', warnings: [...(step.warnings ?? []), 'Stopped before it finished.'] }
        : step,
    ),
  };
}
