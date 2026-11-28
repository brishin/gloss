import type { DiffHunk, FileChange } from './diff.ts';
import { STAGES } from './events.ts';
import type { TourState } from './reducer.ts';
import { describeRef } from './source-ref.ts';
import type { CallFrame, Decision, DecisionPriority, DecisionWalk, SectionPoint, Snippet, Tour } from './tour.ts';
import { RISK_LABELS } from './tour.ts';

/** `brief`: what the change decides and where it lives. `full` adds every note, walk and code path. */
export type TourTextDetail = 'brief' | 'full';

export interface TourTextOptions {
  detail?: TourTextDetail;
  /** The diff's files with hunk bodies: each snippet's lines are printed under it. Without it, snippets are `path:from-to`. */
  files?: readonly Pick<FileChange, 'id' | 'hunks'>[];
}

const PRIORITY: Record<DecisionPriority, string> = { urgent: 'P0', high: 'P1', medium: 'P2', low: 'P3' };

/**
 * The finished tour as compact markdown for an agent to read: what the change decides, its groups
 * and files, and the notes, citing code as `path:line` (new side; `path:-line` for a removed line)
 * instead of copying the diff. Leaves out what only the page uses: Jev's judgments, placements,
 * visuals, ids, the PR body and models.
 */
export function renderTourMarkdown(tour: Tour, options: TourTextOptions = {}): string {
  const full = options.detail !== 'brief';
  const paths = new Map(tour.files.map((file) => [file.id, file.path]));
  const hunks = new Map(options.files?.flatMap((file) => file.hunks.map((hunk) => [hunk.id, hunk] as const)));
  const pathOf = (fileId: string) => paths.get(fileId) ?? fileId;
  const at = (place: { fileId?: string; line?: number; side?: string }) =>
    place.fileId
      ? `${pathOf(place.fileId)}${place.line === undefined ? '' : `:${place.side === 'deletions' ? '-' : ''}${place.line}`}`
      : undefined;
  const decision = (item: Decision) => {
    const where = at(item);
    return `- ${PRIORITY[item.priority]} ${item.source === 'description' ? 'Description: ' : ''}${item.text}${where ? ` (${where})` : ''}`;
  };
  const snippetAt = (snippet: Snippet) => `${pathOf(snippet.fileId)}:${snippet.from}-${snippet.to}`;
  const code = (snippets: readonly Snippet[]) => {
    if (!snippets.length) {
      return [];
    }
    const blocks = snippets.flatMap((snippet) => {
      const hunk = hunks.get(snippet.hunkId);
      return hunk ? [`\`\`\`diff ${snippetAt(snippet)}`, ...newSideLines(hunk, snippet.from, snippet.to), '```'] : [];
    });
    return blocks.length ? blocks : [`Code: ${snippets.map(snippetAt).join(', ')}`];
  };
  const walk = (
    title: string,
    item: Pick<DecisionWalk, 'why' | 'instead' | 'check' | 'snippets'>,
    priority?: DecisionPriority,
  ) => [
    `### ${title}${priority ? ` (${PRIORITY[priority]})` : ''}`,
    item.why,
    ...(item.instead ? [`Instead: ${item.instead}`] : []),
    ...(item.check ? [`Check: ${item.check}`] : []),
    ...code(item.snippets),
    '',
  ];

  const lines: string[] = [`# ${tour.meta.title}`];
  const source = tour.meta.url ?? describeRef(tour.ref);
  lines.push(tour.meta.headSha ? `${source} @ ${tour.meta.headSha.slice(0, 9)}` : source, '');
  if (tour.overallSummary) {
    lines.push(tour.overallSummary, '');
  }

  const wide = (tour.decisions ?? []).filter((item) => !item.groupKey);
  if (wide.length) {
    lines.push('## Decisions', ...wide.map(decision), '');
  }
  if (tour.affected?.length) {
    lines.push('## Affected');
    for (const item of tour.affected) {
      const what = item.effect === 'unchanged' ? `should not change: ${item.what}` : item.what;
      lines.push(`- ${item.surface} (${item.audience}): ${what}${item.evidence ? ` (${item.evidence})` : ''}`);
    }
    lines.push('');
  }

  // Tours from before a walkthrough part, and logs never parsed by valibot, lack its defaults.
  const walks = new Map((tour.walkthrough?.decisions ?? []).map((item) => [item.decision, item]));
  const steps = tour.walkthrough?.steps ?? [];
  const frames = tour.walkthrough?.frames ?? [];
  if (full && walks.size) {
    lines.push('## Walkthrough', '');
    for (const item of walks.values()) {
      lines.push(...walk(item.title, item, tour.decisions?.[item.decision]?.priority));
    }
  }
  if (full && steps.length) {
    lines.push('## Key code path');
    steps.forEach((step, index) => {
      const excerpts = step.excerpts.map((excerpt) => `${pathOf(excerpt.fileId)}:${excerpt.from}-${excerpt.to}`);
      lines.push(`${index + 1}. ${step.title}: ${step.text}${excerpts.length ? ` (${excerpts.join(', ')})` : ''}`);
    });
    if (frames.length) {
      lines.push('```', ...frames.map(frameLine), '```');
    }
    lines.push('');
  }

  const stop = (point: SectionPoint, decisions: readonly Decision[] = []): string[] => {
    if (point.kind === 'wide' && point.wide !== undefined && walks.has(point.wide)) {
      return [`### ${point.title}`, 'Read in the walkthrough above.', ''];
    }
    const priority = point.priority ?? (point.decision === undefined ? undefined : decisions[point.decision]?.priority);
    const body = walk(point.title, point, priority);
    if (point.see && !point.snippets.length) {
      body.splice(-1, 0, `Code: ${at(point.see)}`);
    }
    return body;
  };

  const files = new Map(tour.files.map((file) => [file.id, file]));
  for (const group of tour.groups) {
    const notes = tour.notes[group.key];
    const section = notes?.section;
    lines.push(`## ${group.label}${group.critical ? ' (critical)' : ''}`, group.summary);
    if (full && section?.intro) {
      lines.push(section.intro);
    }
    const list = group.fileIds.map((id) => {
      const file = files.get(id);
      return file ? `${file.path} +${file.additions}-${file.deletions}` : pathOf(id);
    });
    lines.push(`Files: ${list.join(', ')}`);
    if (section?.skim?.length) {
      lines.push(`Skim: ${section.skim.map(pathOf).join(', ')}`);
    }
    // A group decision a stop reads is printed as that stop; the rest stay one line each.
    const read = new Set(full ? (section?.points ?? []).flatMap((point) => point.decision ?? []) : []);
    lines.push(
      ...(tour.decisions ?? []).filter((item) => item.groupKey === group.key).map(decision),
      ...(notes?.decisions ?? []).filter((_, index) => !read.has(index)).map(decision),
    );
    for (const note of notes?.riskNotes ?? []) {
      lines.push(`- Risk (${RISK_LABELS[note.risk]}): ${pathOf(note.fileId)}: ${note.text}`);
    }
    if (full) {
      for (const note of [...(notes?.fileNotes ?? []), ...(notes?.lineNotes ?? [])]) {
        lines.push(`- ${note.critical ? 'Critical: ' : ''}${at(note)}: ${note.text}`);
      }
      for (const flag of section?.hunkFlags ?? []) {
        lines.push(`- ${at(flag)}: changes a contract other code relies on`);
      }
    }
    lines.push('');
    if (full) {
      for (const point of section?.points ?? []) {
        lines.push(...stop(point, notes?.decisions));
      }
      if (section?.rest) {
        lines.push(section.rest, '');
      }
    }
  }
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

/** One call-tree row: indented by depth, the call, and where it is defined; unchanged frames are marked. */
function frameLine(frame: CallFrame): string {
  const call = `${frame.receiver ? `${frame.receiver}.` : ''}${frame.name}(${frame.args ?? ''})`;
  const where = frame.path ? `  ${frame.path}${frame.line === undefined ? '' : `:${frame.line}`}` : '';
  return `${'  '.repeat(frame.depth)}${call}${where}${frame.status === 'same' ? '  (unchanged)' : ''}`;
}

/** The hunk's lines whose new-side number is in `from`..`to`, keeping their ` `/`+` prefixes. */
export function newSideLines(hunk: Pick<DiffHunk, 'newStart' | 'patch'>, from: number, to: number): string[] {
  const out: string[] = [];
  let line = hunk.newStart;
  for (const text of hunk.patch.split('\n')) {
    if (text.startsWith('-') || text.startsWith('\\')) {
      continue;
    }
    if (line >= from && line <= to) {
      out.push(text);
    }
    line++;
  }
  return out;
}

/** Where a running tour is, in one line: its current stage, and for notes how many groups are written. */
export function tourProgress(state: TourState): string {
  const stage = STAGES.find((name) => state.stages[name].state === 'running') ?? 'fetch';
  if (stage === 'notes' && state.resolved) {
    const written = state.resolved.filter((group) => state.notes[group.key]).length;
    return `Still running: notes, ${written}/${state.resolved.length} groups written.`;
  }
  return `Still running: ${stage}.`;
}
