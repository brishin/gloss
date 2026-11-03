import type { CallFrame, DecisionPriority, DiffPayload, Excerpt, FileChange } from '@gloss/protocol';
import { useEffect, useState } from 'react';

/** Mock only: `?mock=a-h` picks a decision walkthrough layout (f-h are round 2). */
export const MOCK = new URLSearchParams(globalThis.location?.search).get('mock') ?? '';
/** Round 2: each decision explained, then read in small snippets, with a tree when one helps. */
export const READ_MOCK = ['f', 'g', 'h'].includes(MOCK);
export const DECISION_MOCK = ['a', 'b', 'c', 'd', 'e'].includes(MOCK) || READ_MOCK;
/** Layouts that replace the overview's decisions table with their own stop. */
export const DECISION_STOP = ['a', 'b', 'c', 'd'].includes(MOCK) || READ_MOCK;

/** Where a decision shows in the code: where it is made, code it reaches, or a test that holds it. */
export type DecisionSite = {
  role: 'made' | 'reaches' | 'tested';
  layer: string;
  label: string;
  path: string;
  from: number;
  to: number;
};

export type DecisionLink = { to: number; text: string };

export type DecisionStop = {
  title: string;
  text: string;
  alt?: string;
  priority: DecisionPriority;
  /** Indexes into the walk's call-tree `frames`. */
  frames: number[];
  links: DecisionLink[];
  sites: DecisionSite[];
};

export type DecisionWalk = {
  number: number;
  layers: string[];
  frames: CallFrame[];
  decisions: DecisionStop[];
};

/** The PR number in a `/gh/:owner/:repo/pull/:number` path. */
export function pullNumber(): number | undefined {
  const match = /\/pull\/(\d+)/.exec(globalThis.location?.pathname ?? '');
  return match ? Number(match[1]) : undefined;
}

/** The hand-written fixture for this PR, served by the proof server. */
export function useDecisionWalk(): DecisionWalk | undefined {
  const [walk, setWalk] = useState<DecisionWalk>();
  useEffect(() => {
    const number = pullNumber();
    if (!DECISION_MOCK || number === undefined) {
      return;
    }
    void fetch(`/mock/decisions/${number}.json`)
      .then((response) => (response.ok ? response.json() : undefined))
      .then((data) => setWalk(data as DecisionWalk | undefined));
  }, []);
  return walk;
}

/** The site as an excerpt of the hunk that holds its first line. */
export function siteExcerpt(
  diff: DiffPayload | undefined,
  site: Pick<DecisionSite, 'path' | 'from' | 'to'>,
): Excerpt | undefined {
  const file = diff?.files.find((candidate) => candidate.path === site.path);
  const hunk = file?.hunks.find(
    (candidate) => site.from >= candidate.newStart && site.from < candidate.newStart + Math.max(candidate.newLines, 1),
  );
  return file && hunk ? { fileId: file.id, hunkId: hunk.id, from: site.from, to: site.to } : undefined;
}

export function filesById(diff: DiffPayload | undefined): Map<string, FileChange> {
  return new Map(diff?.files.map((file) => [file.id, file]));
}

export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export const siteRef = (site: Pick<DecisionSite, 'path' | 'from' | 'to'>) =>
  `${site.path.split('/').slice(-2).join('/')}:${site.from === site.to ? site.from : `${site.from}–${site.to}`}`;

/** Code places across decisions: sites in one file whose lines overlap are one place, so shared code shows. */
export type CodePlace = {
  key: string;
  layer: string;
  path: string;
  from: number;
  to: number;
  label: string;
  uses: { decision: number; role: DecisionSite['role'] }[];
};

export function codePlaces(walk: DecisionWalk): CodePlace[] {
  const places: CodePlace[] = [];
  walk.decisions.forEach((decision, index) => {
    for (const site of decision.sites) {
      const same = places.find(
        (place) => place.path === site.path && site.from <= place.to + 2 && site.to >= place.from - 2,
      );
      if (same) {
        same.from = Math.min(same.from, site.from);
        same.to = Math.max(same.to, site.to);
        if (!same.uses.some((use) => use.decision === index)) {
          same.uses.push({ decision: index, role: site.role });
        }
      } else {
        places.push({
          key: `${site.path}:${site.from}`,
          layer: site.layer,
          path: site.path,
          from: site.from,
          to: site.to,
          label: site.label,
          uses: [{ decision: index, role: site.role }],
        });
      }
    }
  });
  const order = (layer: string) => {
    const at = walk.layers.indexOf(layer);
    return at < 0 ? walk.layers.length : at;
  };
  return places
    .map((place, index) => ({ place, index }))
    .sort((a, b) => order(a.place.layer) - order(b.place.layer) || a.index - b.index)
    .map(({ place }) => place);
}

/** Each frame's decision numbers where that decision is made (a made site covers the frame's line). */
export function madeAt(walk: DecisionWalk): Map<number, number[]> {
  const marks = new Map<number, number[]>();
  walk.decisions.forEach((decision, index) => {
    for (const frameIndex of decision.frames) {
      const frame = walk.frames[frameIndex];
      const made = decision.sites.some(
        (site) =>
          site.role === 'made' &&
          frame?.path === site.path &&
          frame.line !== undefined &&
          frame.line >= site.from - 3 &&
          frame.line <= site.to,
      );
      if (made) {
        marks.set(frameIndex, [...(marks.get(frameIndex) ?? []), index]);
        break;
      }
    }
  });
  return marks;
}

/** Round 2: a few lines that show how a decision is built, one of them the line that matters. */
export type ReadSnippet = { path: string; from: number; to: number; focus: number; caption: string; note?: string };

/** A row of a decision's tree: a call (the walkthrough's geometry) or a concept in a hierarchy. */
export type ReadNode = {
  depth: number;
  kind: 'call' | 'concept';
  label?: string;
  receiver?: string;
  name?: string;
  args?: string;
  status?: CallFrame['status'];
  note?: string;
  /** Index into the decision's snippets. */
  snippet?: number;
  path?: string;
  line?: number;
};

export type ReadDecision = {
  title: string;
  priority: DecisionPriority;
  why: string;
  alt?: string;
  check?: string;
  tree?: { kind: 'calls' | 'concepts'; nodes: ReadNode[] };
  snippets: ReadSnippet[];
  refs: { label: string; path: string; line: number }[];
  links: DecisionLink[];
};

export type DecisionRead = { number: number; decisions: ReadDecision[] };

export function useDecisionRead(): DecisionRead | undefined {
  const [read, setRead] = useState<DecisionRead>();
  useEffect(() => {
    const number = pullNumber();
    if (!READ_MOCK || number === undefined) {
      return;
    }
    void fetch(`/mock/decisions2/${number}.json`)
      .then((response) => (response.ok ? response.json() : undefined))
      .then((data) => setRead(data as DecisionRead | undefined));
  }, []);
  return read;
}

/** Each snippet hangs under the last node of the first run of nodes that point at it. */
export function snippetHosts(nodes: readonly ReadNode[]): Map<number, number> {
  const hosts = new Map<number, number>();
  const done = new Set<number>();
  nodes.forEach((node, index) => {
    const snippet = node.snippet;
    if (snippet === undefined || done.has(snippet)) {
      return;
    }
    hosts.set(index, snippet);
    const previous = [...hosts].find(([at, s]) => s === snippet && at !== index);
    if (previous) {
      hosts.delete(previous[0]);
    }
    if (nodes[index + 1]?.snippet !== snippet) {
      done.add(snippet);
    }
  });
  return hosts;
}
