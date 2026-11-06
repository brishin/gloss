import { Effect } from 'effect';
import { fileImportQuery, type ImportQuery } from '../sources/importers.ts';
import { looksLikeTest } from './heuristics.ts';

/** A file that imports changed code, the gate lines it holds, and who imports it in turn. */
export interface CallerNode {
  /** The import line, as `path:line: text`. */
  line: string;
  path: string;
  /** Lines that look like a flag, role or permission check, as `line: text`. */
  gates: string[];
  callers: CallerNode[];
}

export interface CallerLookup<E> {
  importers(query: ImportQuery): Effect.Effect<string[], E>;
  /** The file's text at the head, or undefined when it cannot be read. */
  read(path: string): Effect.Effect<string | undefined, E>;
}

/**
 * A feature flag, role, permission or platform check: where a screen is gated. Bare words such as
 * "admin" match too much (imports, copy, mocks), so only reads and comparisons count.
 */
const GATE =
  /use\w*Flags?\b|\bflags?\s*\[|\bflags?\.\w|featureFlag|isFeatureEnabled|\bis(Admin|Staff|Internal|Employee)\b|\brole\s*(===|!==|==|!=|in\b)|\bhas(Role|Permission|Access)\b|\bcan[A-Z]\w*\s*(&&|\?|\))|Platform\.OS|\bplatform\s*===/;
const GATES_PER_FILE = 3;
const GATE_CHARS = 160;

/** The lines of a file that look like a gate, numbered. */
export function gateLines(text: string): string[] {
  const out: string[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length && out.length < GATES_PER_FILE; index++) {
    const line = lines[index]!.trim();
    // An import of a flag helper says nothing about what it gates.
    if (GATE.test(line) && !/^(import|from|export \{|\/\/|\*|#)/.test(line)) {
      out.push(`${index + 1}: ${line.length > GATE_CHARS ? `${line.slice(0, GATE_CHARS)}...` : line}`);
    }
  }
  return out;
}

export interface TreeLimits {
  /** Levels of importers: 1 is the direct ones. */
  depth: number;
  /** Importers followed per file. */
  fanout: number;
  /** Files looked at in all. */
  budget: number;
}

/**
 * Who imports what `query` names, and who imports those, up to `depth` levels, each with its
 * gate lines, so the model sees where shared code is mounted and what gates it. A file appears
 * once; the walk stops at the budget.
 */
export function callerTree<E>(
  lookup: CallerLookup<E>,
  query: ImportQuery,
  limits: TreeLimits,
  seen = new Set<string>(),
): Effect.Effect<CallerNode[], E> {
  let left = limits.budget;
  const walk = Effect.fnUntraced(function* (current: ImportQuery, level: number): Effect.fn.Return<CallerNode[], E> {
    const lines = yield* lookup.importers(current);
    const nodes: CallerNode[] = [];
    for (const line of lines) {
      const path = line.slice(0, line.indexOf(':'));
      // Tests and stories import shared code too, but no one meets them.
      if (
        !path ||
        seen.has(path) ||
        looksLikeTest(path) ||
        /\.stories\.\w+$/.test(path) ||
        left <= 0 ||
        nodes.length >= limits.fanout
      ) {
        continue;
      }
      seen.add(path);
      left--;
      const text = yield* lookup.read(path);
      const next = level < limits.depth ? fileImportQuery(path) : undefined;
      nodes.push({
        line,
        path,
        gates: text ? gateLines(text) : [],
        callers: next ? yield* walk(next, level + 1) : [],
      });
    }
    return nodes;
  });
  return walk(query, 1);
}

/** The tree as indented prompt lines: an import line, its gates, then its own importers. */
export function renderCallerTree(nodes: readonly CallerNode[], indent = ''): string[] {
  return nodes.flatMap((node) => [
    `${indent}${node.line}`,
    ...node.gates.map((gate) => `${indent}  gate ${node.path}:${gate}`),
    ...renderCallerTree(node.callers, `${indent}  `),
  ]);
}

/** How many files a tree holds, for the trace. */
export function countCallers(nodes: readonly CallerNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countCallers(node.callers), 0);
}
