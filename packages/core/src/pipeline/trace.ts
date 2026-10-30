import type { StepKind, TraceStep } from '@gloss/protocol';
import type { JudgeQuestion } from '../adapters/types.ts';

/**
 * Records what each pipeline step read and returned, for the pipeline debug view. Every
 * change is handed to `onStep` as a fresh copy; `steps()` is the whole trace in start order.
 */
export interface Tracer {
  begin(id: string, kind: StepKind, fields: Omit<Partial<TraceStep>, 'id' | 'kind'> & { inputs: string[] }): void;
  /** Adds fields to a step without ending it, e.g. a call's usage. */
  patch(id: string, fields: Partial<TraceStep>): void;
  end(id: string, fields?: Partial<TraceStep>, state?: 'done' | 'failed'): void;
  steps(): TraceStep[];
}

export function createTracer(onStep: (step: TraceStep) => void = () => {}, now: () => number = Date.now): Tracer {
  const started = now();
  const steps = new Map<string, TraceStep>();
  const set = (step: TraceStep) => {
    steps.set(step.id, step);
    onStep(step);
  };
  return {
    begin: (id, kind, fields) => set({ ...fields, id, kind, state: 'running', startMs: now() - started }),
    patch: (id, fields) => {
      const step = steps.get(id);
      if (step) {
        set({ ...step, ...fields });
      }
    },
    end: (id, fields = {}, state = 'done') => {
      const step = steps.get(id);
      if (step) {
        set({ ...step, ...fields, state, endMs: now() - started });
      }
    },
    steps: () => [...steps.values()],
  };
}

/**
 * Which step each `## ` section of a prompt came from, by heading prefix; the rest (title,
 * description, commits, diffs) came from the fetch. Adjacent sections from one step merge.
 */
export function promptSections(prompt: string, from: Record<string, string> = {}): { line: number; from: string }[] {
  const sections: { line: number; from: string }[] = [];
  prompt.split('\n').forEach((text, line) => {
    if (line > 0 && !text.startsWith('## ')) {
      return;
    }
    const source = Object.entries(from).find(([prefix]) => text.startsWith(`## ${prefix}`))?.[1] ?? 'fetch';
    if (sections.at(-1)?.from !== source) {
      sections.push({ line, from: source });
    }
  });
  return sections;
}

/** A Jev request as text: the questions, then what each state was about. */
export function judgePrompt(questions: Record<string, JudgeQuestion>, subjects: readonly string[]): string {
  const asked = Object.entries(questions).map(([name, question]) => {
    const text =
      typeof question.instructions === 'string' ? question.instructions : JSON.stringify(question.instructions);
    const options =
      question.type === 'choice' && question.criteria && typeof question.criteria === 'object'
        ? Object.entries(question.criteria).map(([key, value]) => `    ${key}: ${String(value)}`)
        : [];
    return [`- ${name} (${question.type}): ${text}`, ...options].join('\n');
  });
  return ['## Questions', ...asked, '', `## States (${subjects.length})`, ...subjects.map((s) => `- ${s}`)].join('\n');
}
