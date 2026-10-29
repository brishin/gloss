import type { FileChange, GroupNotes, ResolvedGroup, Visual } from '@gloss/protocol';
import type * as v from 'valibot';
import type { DefineSchema, NotesSchema, SketchSchema } from './prompts.ts';
import { sanitizeSvg } from './svg-sanitize.ts';

/** Line numbers each side of a hunk actually shows, so a note can only land on a visible line. */
function visibleLines(hunk: FileChange['hunks'][number]): { additions: Set<number>; deletions: Set<number> } {
  const additions = new Set<number>();
  const deletions = new Set<number>();
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const line of hunk.patch.split('\n')) {
    const marker = line[0] ?? ' ';
    if (marker === '\\') {
      continue;
    }
    if (marker === '-') {
      deletions.add(oldLine++);
    } else if (marker === '+') {
      additions.add(newLine++);
    } else {
      additions.add(newLine++);
      deletions.add(oldLine++);
    }
  }
  return { additions, deletions };
}

/** The hunk that shows `line` on `side`, preferring the one the model named. */
function pinnedHunk(file: FileChange, hunkId: string, side: 'additions' | 'deletions', line: number) {
  const named = file.hunks.find((candidate) => candidate.id === hunkId);
  const hunk = named ?? file.hunks.find((candidate) => visibleLines(candidate)[side].has(line));
  return hunk && visibleLines(hunk)[side].has(line) ? hunk : undefined;
}

/**
 * The trust boundary for model-written notes. Notes for files outside the group are
 * dropped (with a warning); a line note whose hunk or line is not visible is demoted to a
 * file note, never discarded, so the text survives a model's off-by-one. Decisions follow
 * the same rule: one on an invisible line keeps its file and loses its line. A model that
 * names a file by its path instead of its id is understood.
 */
export function normalizeNotes(
  raw: v.InferOutput<typeof NotesSchema>,
  group: ResolvedGroup,
  files: readonly FileChange[],
): { notes: GroupNotes; warnings: string[] } {
  const members = files.filter((file) => group.fileIds.includes(file.id));
  const inGroup = new Map(members.flatMap((file) => [[file.id, file] as const, [file.path, file] as const]));
  const warnings: string[] = [];
  const notes: GroupNotes = { fileNotes: [], lineNotes: [], riskNotes: [], decisions: [] };
  const unknown = (fileId: string) => {
    warnings.push(`Dropped a note for unknown file ${fileId} in group ${group.key}.`);
  };
  for (const note of raw.fileNotes) {
    const file = inGroup.get(note.fileId);
    if (file) {
      notes.fileNotes.push({ ...note, fileId: file.id });
    } else {
      unknown(note.fileId);
    }
  }
  for (const note of raw.lineNotes) {
    const file = inGroup.get(note.fileId);
    if (!file) {
      unknown(note.fileId);
      continue;
    }
    const hunk = pinnedHunk(file, note.hunkId, note.side, note.line);
    if (hunk) {
      notes.lineNotes.push({ ...note, fileId: file.id, hunkId: hunk.id });
    } else {
      notes.fileNotes.push({ fileId: file.id, text: note.text, critical: note.critical });
    }
  }
  for (const note of raw.riskNotes) {
    const file = inGroup.get(note.fileId);
    if (file) {
      notes.riskNotes.push({ ...note, fileId: file.id });
    } else {
      unknown(note.fileId);
    }
  }
  for (const { fileId, hunkId, side, line, text, priority } of raw.decisions) {
    const file = inGroup.get(fileId);
    if (!file) {
      unknown(fileId);
      continue;
    }
    const hunk = pinnedHunk(file, hunkId, side, line);
    const id = file.id;
    notes.decisions!.push(
      hunk ? { text, priority, fileId: id, hunkId: hunk.id, side, line } : { text, priority, fileId: id },
    );
  }
  return { notes, warnings };
}

type RawVisuals = v.InferOutput<typeof DefineSchema>['visuals'];
type RawVisual = RawVisuals['first'];

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};
const clamp = (at: number) => (Number.isFinite(at) ? Math.min(100, Math.max(0, at)) : 0);

/** Mermaid diagram types the client draws; anything else (sequence, gantt, pie...) is dropped. */
const MERMAID_HEADER = /^(?:flowchart|graph)\s+(?:TD|TB|BT|LR|RL)\b|^stateDiagram(?:-v2)?\s*$/;

/** A flowchart or state diagram without fences, styling, init blocks or click handlers. */
function mermaidSource(raw: string | undefined): string | { why: string } {
  const lines = (raw ?? '')
    .replace(/^\s*```(?:mermaid)?\s*\n?|\n?\s*```\s*$/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !/^\s*(?:%%|click\b|style\b|classDef\b|class\b|linkStyle\b)/.test(line));
  if (!MERMAID_HEADER.test(lines[0]?.trim() ?? '')) {
    return { why: 'only flowcharts and state diagrams are drawn' };
  }
  if (lines.length > 30) {
    return { why: 'it is too large to read in the overview' };
  }
  return lines.join('\n');
}

/**
 * Whether a diagram is one straight path (each node at most one edge in and out, no loop),
 * which a numbered list says just as well. Rough on purpose: edges only, labels ignored.
 */
export function isSinglePath(source: string): boolean {
  // Node text is dropped first, so a ";" or "&" left over is syntax: one statement per ";".
  const lines = source
    .split('\n')
    .slice(1)
    .map((line) =>
      line
        .replace(/\[(?!\*\])[^\]]*\]|\([^)]*\)|\{[^}]*\}|"[^"]*"/g, '')
        .replace(/\|[^|]*\|/g, '')
        .replace(/--\s[^-]*?\s*-->/g, '-->'),
    )
    .flatMap((line) => line.split(';'));
  // "A --> B & C" fans out and "A <--> B" goes both ways; not parsed, so never called a path.
  if (lines.some((line) => line.includes('&') || /<[-=.]/.test(line))) {
    return false;
  }
  const edges = lines
    .flatMap((line) => {
      const ids = line
        .split(/\s*(?:-{2,}>|-{3,}|-\.+->|={2,}>)\s*/)
        .map((part) => /^\s*(\[\*\]|[\w-]+)/.exec(part)?.[1]);
      return ids.length < 2 ? [] : ids.slice(1).map((to, i) => [ids[i], to] as const);
    })
    .filter((edge): edge is readonly [string, string] => !!edge[0] && !!edge[1]);
  const into = new Map<string, number>();
  const out = new Map<string, number>();
  for (const [from, to] of edges) {
    out.set(from, (out.get(from) ?? 0) + 1);
    into.set(to, (into.get(to) ?? 0) + 1);
  }
  // Nodes declared on their own line count too: a standalone node is not on the path.
  const declared = lines
    .filter((line) => !/-{2,}>|-{3,}|-\.+->|={2,}>/.test(line))
    .map((line) => /^\s*(\[\*\]|[\w-]+)/.exec(line)?.[1])
    .filter((id): id is string => !!id && !/^(?:end|subgraph|direction|state|note)$/.test(id));
  const nodes = new Set([...edges.flat(), ...declared]);
  if (![...out.values(), ...into.values()].every((n) => n <= 1) || edges.length !== nodes.size - 1) {
    return false;
  }
  // One walk from the only node with nothing in must reach every node; a cycle elsewhere breaks it.
  const next = new Map(edges);
  let node = [...nodes].find((id) => !into.has(id));
  let seen = 0;
  for (; node !== undefined && seen <= nodes.size; node = next.get(node)) {
    seen++;
  }
  return seen === nodes.size;
}

/**
 * The trust boundary for the tour's visual. It keeps only what the client can draw
 * legibly: two small diagrams side by side, a few lanes on a 0-100 axis, or a small flowchart or
 * state diagram without styling, init blocks or click handlers. Anything that does not
 * survive is dropped with a warning; a tour never fails over its picture.
 */
export function normalizeVisual(raw: RawVisual): { visual?: Visual; warnings: string[] } {
  if (raw.kind === 'none') {
    return { warnings: [] };
  }
  const caption = raw.caption ? clip(raw.caption, 200) || undefined : undefined;
  const drop = (why: string) => ({ warnings: [`Dropped the ${raw.kind} visual: ${why}.`] });
  if (raw.kind === 'before-after') {
    const before = mermaidSource(raw.before);
    const after = mermaidSource(raw.after);
    const why = typeof before === 'string' ? (typeof after === 'string' ? undefined : after.why) : before.why;
    if (why) {
      return drop(why);
    }
    if (isSinglePath(before as string) && isSinglePath(after as string)) {
      return drop('both sides are a single path, which a list says as well');
    }
    return {
      visual: { kind: 'before-after', caption, before: before as string, after: after as string },
      warnings: [],
    };
  }
  if (raw.kind === 'timeline') {
    const lanes = (raw.lanes ?? []).slice(0, 4).flatMap((lane) => {
      const spans = lane.spans.slice(0, 4).flatMap((span) => {
        const [from, to] = [clamp(span.from), clamp(span.to)].sort((a, b) => a - b) as [number, number];
        const text = clip(span.text, 40);
        return to > from ? [{ from, to, text, ...(span.tone ? { tone: span.tone } : {}) }] : [];
      });
      const outcome = lane.outcome && {
        at: clamp(lane.outcome.at),
        text: clip(lane.outcome.text, 60),
        tone: lane.outcome.tone,
      };
      const label = clip(lane.label, 24);
      return label && (spans.length || outcome) ? [{ label, spans, ...(outcome ? { outcome } : {}) }] : [];
    });
    const markers = (raw.markers ?? [])
      .slice(0, 5)
      .map((marker) => ({ at: clamp(marker.at), text: clip(marker.text, 30) }))
      .filter((marker) => marker.text);
    return lanes.length
      ? { visual: { kind: 'timeline', caption, markers, lanes }, warnings: [] }
      : drop('no lane has anything on it');
  }
  const source = mermaidSource(raw.mermaid);
  if (typeof source !== 'string') {
    return drop(source.why);
  }
  return isSinglePath(source)
    ? drop('it is a single path, which a list says as well')
    : { visual: { kind: 'mermaid', caption, source }, warnings: [] };
}

/** The hand-drawn candidate, through the SVG allowlist. */
/** How near a box an arrow's end must be to count as touching it, in viewBox units. */
const TOUCH = 8;

/**
 * Ends of connectors (a `line` with a marker, and every `polyline` or `path` outside `defs`)
 * that touch no box, circle, ellipse or polygon. A connector into empty space is the commonest
 * failure of a model-drawn sketch: the loop or flow it was meant to show never closes, with or
 * without an arrowhead. Lines without a marker are dividers and axes. Paths count only when
 * made of absolute M, L, H and V. Skipped (0) when anything is transformed, since coordinates
 * are then not comparable.
 */
export function looseEnds(svg: string): number {
  if (/\stransform="/.test(svg)) {
    return 0;
  }
  // A marker's own shape sits in `defs`, in its own coordinates.
  const drawn = svg.replace(/<defs>[\s\S]*?<\/defs>/g, '');
  const tags = (name: string, within = svg) =>
    [...within.matchAll(new RegExp(`<${name}\\s[^>]*>`, 'g'))].map(([tag]) => tag);
  const text = (tag: string, key: string) => tag.match(new RegExp(`\\s${key}="([^"]*)"`))?.[1];
  const num = (tag: string, key: string, fallback = 0) => Number(text(tag, key) ?? fallback);
  const pairs = (list: string) => {
    const n = list
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    return Array.from({ length: Math.floor(n.length / 2) }, (_, i) => [n[i * 2]!, n[i * 2 + 1]!] as const);
  };
  const near = (a: number, b: number) => Math.abs(a - b) <= TOUCH;
  const within = (value: number, from: number, to: number) => value >= from - TOUCH && value <= to + TOUCH;
  const shapes: ((x: number, y: number) => boolean)[] = [
    ...tags('rect').map((tag) => {
      const [x, y, width, height] = [num(tag, 'x'), num(tag, 'y'), num(tag, 'width'), num(tag, 'height')];
      return (px: number, py: number) =>
        (within(px, x, x + width) && (near(py, y) || near(py, y + height))) ||
        (within(py, y, y + height) && (near(px, x) || near(px, x + width)));
    }),
    ...[...tags('circle'), ...tags('ellipse')].map((tag) => {
      const [cx, cy, r] = [num(tag, 'cx'), num(tag, 'cy'), num(tag, 'r')];
      const [rx, ry] = [Math.max(num(tag, 'rx', r), 1), Math.max(num(tag, 'ry', r), 1)];
      return (px: number, py: number) =>
        Math.abs(Math.hypot((px - cx) / rx, (py - cy) / ry) - 1) * Math.min(rx, ry) <= TOUCH;
    }),
    // A polygon, such as a decision diamond: touching is being near one of its sides.
    ...tags('polygon').map((tag) => {
      const corners = pairs(text(tag, 'points') ?? '');
      return (px: number, py: number) =>
        corners.some(([ax, ay], i) => {
          const [bx, by] = corners[(i + 1) % corners.length]!;
          const t = Math.min(
            1,
            Math.max(0, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / Math.max((bx - ax) ** 2 + (by - ay) ** 2, 1)),
          );
          return Math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay)) <= TOUCH;
        });
    }),
  ];
  const arrow = (tag: string) => /\smarker-(?:start|end)="/.test(tag);
  const ends = [
    ...tags('line')
      .filter(arrow)
      .flatMap((tag) => [
        [num(tag, 'x1'), num(tag, 'y1')],
        [num(tag, 'x2'), num(tag, 'y2')],
      ]),
    ...tags('polyline', drawn).flatMap((tag) => {
      const all = pairs(text(tag, 'points') ?? '');
      return all.length >= 2 ? [all[0]!, all.at(-1)!] : [];
    }),
    ...tags('path', drawn).flatMap((tag) => pathEnds(text(tag, 'd') ?? '')),
  ];
  return ends.filter(([x, y]) => !shapes.some((touches) => touches(x!, y!))).length;
}

/** Start and end of each subpath of an absolute M/L/H/V path; none for anything curved or relative. */
function pathEnds(d: string): number[][] {
  const commands = [...d.matchAll(/([A-Za-z])([^A-Za-z]*)/g)];
  if (!commands.length || commands.some(([, command]) => !'MLHV'.includes(command!))) {
    return [];
  }
  const ends: number[][] = [];
  let [x, y] = [0, 0];
  let start: number[] | undefined;
  for (const [, command, args] of commands) {
    const n = args!
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (command === 'M') {
      if (start) {
        ends.push(start, [x, y]);
      }
      [x, y] = [n[0] ?? x, n[1] ?? y];
      start = [x, y];
    } else if (command === 'L') {
      [x, y] = [n.at(-2) ?? x, n.at(-1) ?? y];
    } else if (command === 'H') {
      x = n.at(-1) ?? x;
    } else {
      y = n.at(-1) ?? y;
    }
  }
  return start ? [...ends, start, [x, y]] : [];
}

export function normalizeSketch(raw: Omit<v.InferOutput<typeof SketchSchema>, 'form'>): {
  visual?: Visual;
  warnings: string[];
} {
  if (!raw.svg.trim()) {
    return { warnings: [] };
  }
  const svg = sanitizeSvg(raw.svg);
  const caption = raw.caption ? clip(raw.caption, 200) || undefined : undefined;
  if (typeof svg !== 'string') {
    return { warnings: [`Dropped the svg visual: ${svg.why}.`] };
  }
  const loose = looseEnds(svg);
  const gap = loose
    ? `${loose} connector end${loose > 1 ? 's touch' : ' touches'} no box`
    : sketchGap(svg, caption ?? '');
  return gap
    ? { warnings: [`Dropped the svg visual: ${gap}.`] }
    : { visual: { kind: 'svg', caption, svg }, warnings: [] };
}

/**
 * What a sketch promises but does not draw, checked in code because the model skips these
 * rules often (eval rounds 9-10): a caption about "before" with no BEFORE band, or most
 * arrows without a label. Labels are texts outside every box (regions around boxes do not count), other than capitalised headings.
 */
export function sketchGap(svg: string, caption: string): string | undefined {
  if (/\bbefore\b/i.test(caption) && !/>\s*BEFORE\s*</i.test(svg)) {
    return 'its caption describes a before it does not draw';
  }
  const body = svg.replace(/<defs>[\s\S]*?<\/defs>/g, '');
  const arrows = [...body.matchAll(/<(?:line|polyline|path)\s[^>]*\smarker-(?:start|end)="/g)].length;
  const attr = (tag: string, key: string) => Number(tag.match(new RegExp(`\\s${key}="([^"]*)"`))?.[1] ?? 0);
  const rects = [...body.matchAll(/<rect\s[^>]*>/g)].map(([tag]) => [
    attr(tag, 'x'),
    attr(tag, 'y'),
    attr(tag, 'x') + attr(tag, 'width'),
    attr(tag, 'y') + attr(tag, 'height'),
  ]);
  // A rect around other rects is a region (a boundary figure's place), and its arrow labels sit inside it.
  const boxes = rects.filter(
    ([left, top, right, bottom], i) =>
      !rects.some(
        (inner, j) => j !== i && inner[0]! >= left! && inner[1]! >= top! && inner[2]! <= right! && inner[3]! <= bottom!,
      ),
  );
  const labels = [...body.matchAll(/(<text\s[^>]*>)([^<]*)/g)].filter(([, tag, words]) => {
    const [x, y] = [attr(tag!, 'x'), attr(tag!, 'y')];
    const inside = boxes.some(([left, top, right, bottom]) => x >= left! && x <= right! && y >= top! && y <= bottom!);
    return !inside && !/^[A-Z\s]+$/.test(words!.trim());
  }).length;
  return labels * 2 >= arrows
    ? undefined
    : arrows === 1
      ? 'its arrow has no label'
      : `${arrows - labels} of its ${arrows} arrows have no label`;
}

/** The define call's candidates that survive, in the model's order. */
export function normalizeVisuals(raw: RawVisuals | undefined): { visuals: Visual[]; warnings: string[] } {
  const results = raw ? [normalizeVisual(raw.first), normalizeVisual(raw.second)] : [];
  return {
    visuals: results.flatMap((result) => (result.visual ? [result.visual] : [])),
    warnings: results.flatMap((result) => result.warnings),
  };
}
