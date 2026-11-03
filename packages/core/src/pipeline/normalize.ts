import type {
  Decision,
  DecisionNode,
  DecisionWalk,
  FileChange,
  GroupNotes,
  ResolvedGroup,
  Snippet,
  Visual,
  Walkthrough,
} from '@gloss/protocol';
import { sanitizeSvg } from '@gloss/protocol';
import type * as v from 'valibot';
import type { DefineSchema, NotesSchema, SketchSchema, WalkthroughResultSchema } from './prompts.ts';

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
 * Change-wide decisions from the define call, with each `groupKey` checked against the
 * defined groups: an unknown key is dropped, so the decision stays change-wide.
 */
export function normalizeDecisionGroups(decisions: readonly Decision[], groupKeys: readonly string[]): Decision[] {
  const known = new Set(groupKeys);
  return decisions.map(({ groupKey, ...decision }) =>
    groupKey !== undefined && known.has(groupKey) ? { ...decision, groupKey } : decision,
  );
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
 * rules often (eval rounds 9-10): a caption that compares a before with no BEFORE band, or most
 * arrows without a label. Labels are texts outside every box (regions around boxes do not count), other than bold capitalised headings.
 */
export function sketchGap(svg: string, caption: string): string | undefined {
  // "Before, ..." or "Before: ..." compares old and new; "checks the cache before the query" is order.
  if (/\bbefore\s*[,:;]|\bbefore and after\b/i.test(caption) && !/>\s*BEFORE\s*</i.test(svg)) {
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
    // A heading is bold capitals ("BEFORE", "SERVER"); a capital arrow label ("HTTP") is not bold.
    const heading = /^[A-Z\s]+$/.test(words!.trim()) && /\sfont-weight="(?:[6-9]00|bold)"/.test(tag!);
    return !inside && !heading;
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

type RawWalk = v.InferOutput<typeof WalkthroughResultSchema>['decisions'][number];

/** Most rows a decision's tree keeps, and how deep it nests, before it stops reading at a glance. */
const MAX_NODES = 14;
const MAX_DEPTH = 6;
const MAX_SNIPPETS = 3;
/** Most rows a snippet shows, removed ones too: a snippet is a few lines, never a hunk. */
const MAX_SNIPPET_ROWS = 16;
const MAX_REFS = 6;
const MAX_LINKS = 3;

const whole = (value: unknown) => (Number.isFinite(value) ? Math.floor(value as number) : 0);

/**
 * Each row of a hunk by new-side position: a removed row sits at the new line after it.
 * A snippet `from`..`to` shows the rows at `from`..`to`, plus removed rows at `to + 1`, so
 * lines removed at the end of a hunk still show (`sliceHunk` in the web app does the same).
 */
function hunkRows(hunk: FileChange['hunks'][number]): { at: number; kind: '+' | '-' | ' ' }[] {
  const rows: { at: number; kind: '+' | '-' | ' ' }[] = [];
  let newLine = hunk.newStart;
  for (const line of hunk.patch.split('\n')) {
    const marker = line[0] ?? ' ';
    if (marker === '\\') {
      continue;
    }
    if (marker === '-') {
      rows.push({ at: newLine, kind: '-' });
    } else {
      rows.push({ at: newLine++, kind: marker === '+' ? '+' : ' ' });
    }
  }
  return rows;
}

const shows = (row: { at: number; kind: string }, from: number, to: number) =>
  row.at >= from && row.at <= (row.kind === '-' ? to + 1 : to);

/**
 * A snippet the diff can show: a known file and the hunk that holds its focus (the id is only a
 * hint), its range clamped to that hunk and grown to hold the focus, then narrowed around the
 * focus to at most `MAX_SNIPPET_ROWS` rows (or dropped, when the focus alone shows more). A focus
 * the hunk does not show moves to the first added line in range, so the marked line is always one
 * the reviewer sees. A dropped snippet returns why.
 */
function normalizeSnippet(
  raw: Partial<RawWalk['snippets'][number]>,
  byKey: ReadonlyMap<string, FileChange>,
): Snippet | string {
  const file = byKey.get(String(raw.fileId ?? ''));
  if (!file) {
    return 'is not in the diff';
  }
  let from = whole(raw.from);
  let to = whole(raw.to);
  if (from > to) {
    [from, to] = [to, from];
  }
  let focus = whole(raw.focus);
  const holds = (hunk: FileChange['hunks'][number], line: number) =>
    hunkRows(hunk).some((row) => row.kind !== '-' && row.at === line);
  // The focus wins over the id: a hint that names another hunk would move the marked line.
  const hinted = (candidate: FileChange['hunks'][number]) => candidate.id === raw.hunkId;
  const hunk =
    file.hunks.find((candidate) => hinted(candidate) && holds(candidate, focus)) ??
    file.hunks.find((candidate) => holds(candidate, focus)) ??
    file.hunks.find((candidate) => hinted(candidate) && holds(candidate, from)) ??
    file.hunks.find((candidate) => holds(candidate, from));
  if (!hunk) {
    return 'is not in the diff';
  }
  const rows = hunkRows(hunk);
  const lines = rows.filter((row) => row.kind !== '-').map((row) => row.at);
  const first = lines[0]!;
  const last = lines.at(-1)!;
  from = Math.min(Math.max(from, first), last);
  to = Math.max(Math.min(to, last), from);
  if (!lines.includes(focus)) {
    focus = rows.find((row) => row.kind === '+' && row.at >= from && row.at <= to)?.at ?? from;
  }
  from = Math.max(Math.min(from, focus), focus - MAX_SNIPPET_ROWS);
  to = Math.min(Math.max(to, focus), focus + MAX_SNIPPET_ROWS);
  // New-side lines in a hunk are consecutive, so narrowing is a step from the end farther from the focus.
  const count = () => rows.filter((row) => shows(row, from, to)).length;
  while (count() > MAX_SNIPPET_ROWS && (from < focus || to > focus)) {
    if (to - focus >= focus - from) {
      to--;
    } else {
      from++;
    }
  }
  if (count() > MAX_SNIPPET_ROWS) {
    // The focus alone sits beside more removed rows than a snippet shows.
    return `shows more than ${MAX_SNIPPET_ROWS} rows at its focus`;
  }
  const note = clip(String(raw.note ?? ''), 200);
  return {
    fileId: file.id,
    hunkId: hunk.id,
    from,
    to,
    focus,
    caption: clip(String(raw.caption ?? ''), 200),
    ...(note ? { note } : {}),
  };
}

/**
 * A decision's tree as the client may show it. Depths are made a tree (the first row is a root,
 * none is more than one deeper than the row before); a row is a call when it names a function,
 * else a concept with a label. A file is a known id and a line stays only where the diff shows it
 * on the new side, so a guess at an unseen definition is never shown as fact. `snippets` maps the
 * model's snippet indexes to the kept ones. Returns no tree when it is not worth drawing: one with
 * no child is a list, and a call path that touches nothing the change adds is plumbing.
 */
function normalizeTree(
  kind: unknown,
  raw: readonly Partial<RawWalk['nodes'][number]>[],
  byKey: ReadonlyMap<string, FileChange>,
  snippets: ReadonlyMap<number, number>,
): DecisionNode[] | undefined {
  if (kind !== 'calls' && kind !== 'concepts') {
    return undefined;
  }
  const nodes: DecisionNode[] = [];
  for (const node of raw.slice(0, MAX_NODES)) {
    const name = clip(String(node.name ?? ''), 48).replace(/\(.*$/, '');
    const label = clip(String(node.label ?? ''), 60);
    if (!name && !label) {
      continue;
    }
    const depth = Math.min(Math.max(0, whole(node.depth)), nodes.length ? nodes.at(-1)!.depth + 1 : 0, MAX_DEPTH);
    const file = byKey.get(String(node.fileId ?? ''));
    const line = whole(node.line);
    const shown = file?.hunks.some((hunk) => visibleLines(hunk).additions.has(line));
    const place = { ...(file ? { path: file.path } : {}), ...(file && shown ? { line } : {}) };
    const note = clip(String(node.note ?? ''), 80);
    const snippet = snippets.get(whole(node.snippet));
    const extra = { ...(note ? { note } : {}), ...(snippet === undefined ? {} : { snippet }) };
    if (name) {
      const receiver = clip(String(node.receiver ?? ''), 40).replace(/\.$/, '');
      const args = clip(String(node.args ?? ''), 60).replace(/^\((.*)\)$/, '$1');
      const status = node.status === 'new' || node.status === 'changed' ? node.status : 'same';
      nodes.push({
        kind: 'call',
        depth,
        ...(receiver ? { receiver } : {}),
        name,
        ...(args ? { args } : {}),
        ...place,
        status,
        ...extra,
      });
    } else {
      nodes.push({ kind: 'concept', depth, label, ...place, ...extra });
    }
  }
  if (!nodes.some((node) => node.depth > 0)) {
    return undefined;
  }
  const calls = nodes.filter((node) => node.kind === 'call');
  if (kind === 'calls' && !calls.some((node) => node.status !== 'same')) {
    return undefined;
  }
  return nodes;
}

/**
 * The walkthrough as the client may show it: each entry names a real, unclaimed decision (of
 * `decisions` listed in the prompt), shows at least one snippet the diff holds, and keeps a
 * tree only where `normalizeTree` does. Refs and links that point nowhere are dropped. Entries
 * follow the decisions' order; a decision with no code to show is left to its overview line.
 */
export function normalizeWalkthrough(
  raw: Partial<v.InferOutput<typeof WalkthroughResultSchema>>,
  files: readonly FileChange[],
  decisions: number,
): { walkthrough?: Walkthrough; warnings: string[] } {
  if (!Array.isArray(raw.decisions) || raw.decisions.length === 0) {
    return { warnings: [] };
  }
  const byKey = new Map(files.flatMap((file) => [[file.id, file] as const, [file.path, file] as const]));
  const warnings: string[] = [];
  const walks = new Map<number, DecisionWalk>();
  for (const entry of raw.decisions) {
    const decision = whole(entry.decision);
    const title = clip(String(entry.title ?? ''), 80);
    if (decision < 0 || decision >= decisions || walks.has(decision) || !title) {
      warnings.push(`Dropped a walkthrough entry: decision ${entry.decision} is not listed, repeated or untitled.`);
      continue;
    }
    const snippets: Snippet[] = [];
    const kept = new Map<number, number>();
    for (const [index, rawSnippet] of (Array.isArray(entry.snippets) ? entry.snippets : []).entries()) {
      const snippet = normalizeSnippet(rawSnippet, byKey);
      if (typeof snippet === 'string') {
        warnings.push(`Dropped a snippet of decision ${decision}: ${rawSnippet.fileId}:${rawSnippet.from} ${snippet}.`);
        continue;
      }
      const same = snippets.findIndex(
        (other) => other.hunkId === snippet.hunkId && other.from <= snippet.to && snippet.from <= other.to,
      );
      if (same >= 0) {
        kept.set(index, same);
      } else if (snippets.length < MAX_SNIPPETS) {
        kept.set(index, snippets.length);
        snippets.push(snippet);
      }
    }
    if (snippets.length === 0) {
      warnings.push(`Dropped the walkthrough of decision ${decision}: none of its code is in the diff.`);
      continue;
    }
    const tree = normalizeTree(entry.tree, Array.isArray(entry.nodes) ? entry.nodes : [], byKey, kept);
    const refs: DecisionWalk['refs'] = [];
    for (const ref of Array.isArray(entry.refs) ? entry.refs : []) {
      const file = byKey.get(String(ref.fileId ?? ''));
      const label = clip(String(ref.label ?? ''), 60);
      if (!file || !label || refs.length >= MAX_REFS) {
        continue;
      }
      const line = whole(ref.line);
      const shown = file.hunks.some((hunk) => visibleLines(hunk).additions.has(line));
      if (!refs.some((other) => other.fileId === file.id && other.line === (shown ? line : undefined))) {
        refs.push({ label, fileId: file.id, ...(shown ? { line } : {}) });
      }
    }
    const links: DecisionWalk['links'] = [];
    for (const link of Array.isArray(entry.links) ? entry.links : []) {
      const to = whole(link.to);
      const text = clip(String(link.text ?? ''), 200);
      if (to >= 0 && to < decisions && to !== decision && text && !links.some((other) => other.to === to)) {
        links.push({ to, text });
      }
    }
    const instead = clip(String(entry.instead ?? ''), 160);
    const check = clip(String(entry.check ?? ''), 300);
    walks.set(decision, {
      decision,
      title,
      why: clip(String(entry.why ?? ''), 400),
      ...(instead ? { instead } : {}),
      ...(check ? { check } : {}),
      ...(tree ? { tree } : {}),
      snippets,
      refs,
      links: links.slice(0, MAX_LINKS),
    });
  }
  if (walks.size === 0) {
    return { warnings };
  }
  return { walkthrough: { decisions: [...walks.values()].toSorted((a, b) => a.decision - b.decision) }, warnings };
}
