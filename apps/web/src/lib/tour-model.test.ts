import type { DiffPayload, FileSummary, TourState } from '@gloss/protocol';
import { initialTourState } from '@gloss/protocol';
import { describe, expect, test } from 'vitest';
import { groupNode, isNodeOpen } from './sidebar-tree.ts';
import { type Cmd, init, initialModel, keyToMsg, type Model, type Msg, update } from './tour-model.ts';
import { OVERVIEW } from './tour-view.ts';

const REF = { kind: 'github-pr', owner: 'o', repo: 'r', number: 1 } as const;

function file(id: string): FileSummary {
  return { id, path: `src/${id}.ts`, additions: 1, deletions: 0, isBinary: false, truncated: false } as FileSummary;
}

/** Two resolved groups: `a` holds f1, f2; `b` holds f3. */
function tour(overrides: Partial<TourState> = {}): TourState {
  return {
    ...initialTourState(),
    status: 'running',
    diffId: 'd1',
    files: ['f1', 'f2', 'f3'].map(file),
    resolved: [
      { key: 'a', label: 'Alpha', category: 'core', critical: false, fileIds: ['f1', 'f2'] },
      { key: 'b', label: 'Beta', category: 'tests', critical: false, fileIds: ['f3'] },
    ],
    ...overrides,
  } as TourState;
}

const DIFF = { id: 'd1', files: [] } as unknown as DiffPayload;

function model(overrides: Partial<Model> = {}): Model {
  return {
    ...initialModel(REF, {}),
    connection: 'streaming',
    tour: tour(),
    diff: DIFF,
    diffRequested: 'd1',
    ...overrides,
  };
}

/** Runs messages through `update`, returning the final model and every command along the way. */
function run(start: Model, ...msgs: Msg[]): [Model, Cmd[]] {
  let current = start;
  const cmds: Cmd[] = [];
  for (const msg of msgs) {
    const [next, out] = update(current, msg);
    current = next;
    cmds.push(...out);
  }
  return [current, cmds];
}

const types = (cmds: readonly Cmd[]) => cmds.map((cmd) => cmd.type);

describe('init', () => {
  test('starts the tour and holds the file from the URL until it can be shown', () => {
    const [start, cmds] = init(REF, { g: 'a', f: 'f2' });
    expect(cmds[0]).toEqual({ type: 'StartTour', ref: REF, force: false });
    expect(types(cmds)).toContain('SetTitle');
    expect(start.restoring).toBe('f2');
    expect(start.connection).toBe('connecting');
  });
});

describe('selection', () => {
  test('a group change pushes history, starts at the top and unfolds the sidebar to it', () => {
    const [next, cmds] = run(model({ activeFileId: 'f1' }), { type: 'GroupSelected', key: 'b' });
    expect(next.position).toEqual({ g: 'b', f: undefined });
    expect(next.activeFileId).toBeUndefined();
    expect(cmds).toContainEqual({ type: 'Navigate', position: { g: 'b', f: undefined }, replace: false });
    expect(types(cmds)).toEqual(expect.arrayContaining(['ScrollToTop', 'MeasureActiveFile', 'SetTitle']));
    expect(isNodeOpen(next.sidebar, groupNode('b'))).toBe(true);
  });

  test('j and k walk overview → groups and stop at the ends', () => {
    const [atA] = run(model(), { type: 'GroupStepped', by: 1 });
    expect(atA.position.g).toBe('a');
    const [atB] = run(atA, { type: 'GroupStepped', by: 1 }, { type: 'GroupStepped', by: 1 });
    expect(atB.position.g).toBe('b');
    const [back] = run(atA, { type: 'GroupStepped', by: -1 }, { type: 'GroupStepped', by: -1 });
    expect(back.position.g).toBeUndefined();
  });

  test('a file under another group opens that group at the file, not at its top', () => {
    const [next, cmds] = run(model({ position: { g: 'a' } }), { type: 'FileJumped', fileId: 'f3', groupKey: 'b' });
    expect(next.position.g).toBe('b');
    expect(next.activeFileId).toBe('f3');
    expect(types(cmds)).toContain('ScrollToFile');
    expect(types(cmds)).not.toContain('ScrollToTop');
    expect(types(cmds)).not.toContain('MeasureActiveFile');
  });

  test('a vanished group falls back to the overview', () => {
    const [stepped] = run(model({ position: { g: 'gone' } }), { type: 'GroupStepped', by: 1 });
    expect(stepped.position.g).toBe('a');
  });
});

describe('URL', () => {
  test('the file in view replaces the URL entry; the first file of a group is left out', () => {
    const start = model({ position: { g: 'a' } });
    const [second, cmds] = run(start, { type: 'ActiveFileChanged', fileId: 'f2' });
    expect(second.position).toEqual({ g: 'a', f: 'f2' });
    expect(cmds).toContainEqual({ type: 'Navigate', position: { f: 'f2' }, replace: true });
    const [first, more] = run(second, { type: 'ActiveFileChanged', fileId: 'f1' });
    expect(first.position.f).toBeUndefined();
    expect(more).toContainEqual({ type: 'Navigate', position: { f: undefined }, replace: true });
  });

  test("a file from the last group doesn't write the URL", () => {
    const [next, cmds] = run(model({ position: { g: 'a' } }), { type: 'ActiveFileChanged', fileId: 'f3' });
    expect(next.position.f).toBeUndefined();
    expect(types(cmds)).not.toContain('Navigate');
  });

  test('back/forward to another file restores it', () => {
    const [next, cmds] = run(model({ position: { g: 'a' } }), { type: 'UrlChanged', position: { g: 'a', f: 'f2' } });
    expect(next.restoring).toBeUndefined();
    expect(next.activeFileId).toBe('f2');
    expect(cmds).toContainEqual({ type: 'RestoreFile', fileId: 'f2' });
  });

  test('the position the page wrote itself is a no-op', () => {
    const start = model({ position: { g: 'a', f: 'f2' } });
    const [next, cmds] = update(start, { type: 'UrlChanged', position: { g: 'a', f: 'f2' } });
    expect(next).toBe(start);
    expect(cmds).toEqual([]);
  });
});

describe('restoring a file', () => {
  test('waits for the diff, then scrolls to the file and opens it', () => {
    const start = model({ position: { g: 'a', f: 'f2' }, restoring: 'f2', diff: undefined });
    const [waiting, none] = run(start, { type: 'NavClosed' }, { type: 'ActiveFileChanged', fileId: 'f1' });
    expect(waiting.restoring).toBe('f2');
    expect(types(none)).not.toContain('Navigate');
    const [restored, cmds] = run(waiting, { type: 'DiffLoaded', diff: DIFF });
    expect(restored.restoring).toBeUndefined();
    expect(restored.activeFileId).toBe('f2');
    expect(restored.expanded.f2).toBe(true);
    expect(cmds).toContainEqual({ type: 'RestoreFile', fileId: 'f2' });
    expect(types(cmds)).not.toContain('MeasureActiveFile');
  });

  test('gives up once a finished tour turns out not to have it', () => {
    const start = model({ position: { g: 'a', f: 'gone' }, restoring: 'gone' });
    const [running] = run(start, { type: 'NavToggled' });
    expect(running.restoring).toBe('gone');
    const [done] = run(running, { type: 'EventReceived', event: aborted() });
    expect(done.restoring).toBeUndefined();
  });
});

describe('data', () => {
  test('fetches each diff once and loads its viewed files', () => {
    const start = model({ tour: tour({ diffId: undefined }), diff: undefined, diffRequested: undefined });
    const [next, cmds] = run(start, { type: 'EventReceived', event: diffReady('d2') }, { type: 'NavToggled' });
    expect(cmds.filter((cmd) => cmd.type === 'FetchDiff')).toEqual([{ type: 'FetchDiff', diffId: 'd2' }]);
    expect(cmds).toContainEqual({ type: 'LoadViewed', diffId: 'd2' });
    const [loaded] = run(next, { type: 'ViewedLoaded', diffId: 'd2', fileIds: ['f1'] });
    expect([...loaded.viewed]).toEqual(['f1']);
    const [stale] = run(loaded, { type: 'ViewedLoaded', diffId: 'old', fileIds: [] });
    expect([...stale.viewed]).toEqual(['f1']);
  });

  test('re-run restarts the session with force; stop aborts the job', () => {
    const [next, cmds] = run(model({ jobId: 'j1', connection: 'error' }), { type: 'RerunClicked' });
    expect(next.connection).toBe('connecting');
    expect(cmds).toContainEqual({ type: 'StartTour', ref: REF, force: true });
    expect(run(model({ jobId: 'j1' }), { type: 'StopClicked' })[1]).toContainEqual({ type: 'AbortTour', jobId: 'j1' });
    expect(run(model(), { type: 'StopClicked' })[1]).toEqual([]);
  });
});

describe('viewed', () => {
  test('v marks the current file viewed and moves to the next; again unmarks and stays', () => {
    const start = model({ position: { g: 'a' }, activeFileId: 'f1', expanded: { f1: true } });
    const [marked, cmds] = run(start, { type: 'ActiveFileViewed' });
    expect(marked.viewed.has('f1')).toBe(true);
    expect(marked.expanded.f1).toBeUndefined();
    expect(marked.activeFileId).toBe('f2');
    expect(cmds).toContainEqual({ type: 'SaveViewed', diffId: 'd1', fileIds: ['f1'] });
    const [unmarked] = run({ ...marked, activeFileId: 'f1' }, { type: 'ActiveFileViewed' });
    expect(unmarked.viewed.has('f1')).toBe(false);
    expect(unmarked.activeFileId).toBe('f1');
  });

  test('x flips a file away from its default', () => {
    const [collapsed] = run(model({ position: { g: 'a' } }), { type: 'ExpandedToggled', fileId: 'f1' });
    expect(collapsed.expanded.f1).toBe(false);
    const [viewed] = run(model({ position: { g: 'a' }, viewed: new Set(['f1']) }), {
      type: 'ExpandedToggled',
      fileId: 'f1',
    });
    expect(viewed.expanded.f1).toBe(true);
  });
});

describe('keyToMsg', () => {
  const base = model({ position: { g: 'a' } });
  test.each([
    ['j', base, { type: 'GroupStepped', by: 1 }],
    ['k', base, { type: 'GroupStepped', by: -1 }],
    ['o', base, { type: 'GroupSelected', key: OVERVIEW }],
    ['n', base, { type: 'FileStepped', by: 1 }],
    [']', base, { type: 'NoteStepped', by: 1 }],
    ['x', base, undefined],
    ['x', { ...base, activeFileId: 'f1' }, { type: 'ExpandedToggled', fileId: 'f1' }],
    ['v', base, undefined],
    ['Escape', base, undefined],
    ['Escape', { ...base, navOpen: true }, { type: 'NavClosed' }],
    ['j', { ...base, helpOpen: true }, undefined],
    ['?', { ...base, helpOpen: true }, { type: 'HelpToggled' }],
    ['q', base, undefined],
  ] as const)('%s', (key, state, expected) => {
    expect(keyToMsg(state, key)).toEqual(expected);
  });
});

describe('sidebar', () => {
  test('clicking the open selected group folds it; clicking again reopens it', () => {
    const [start] = run(model(), { type: 'GroupSelected', key: 'a' });
    expect(isNodeOpen(start.sidebar, groupNode('a'))).toBe(true);
    const [selected] = run(start, { type: 'SidebarActivated', node: groupNode('a'), key: 'a' });
    expect(isNodeOpen(selected.sidebar, groupNode('a'))).toBe(false);
    const [reopened, cmds] = run(selected, { type: 'SidebarActivated', node: groupNode('a'), key: 'a' });
    expect(isNodeOpen(reopened.sidebar, groupNode('a'))).toBe(true);
    expect(types(cmds)).toContain('Navigate');
  });

  test('a filter opens every node', () => {
    const [next] = run(model(), { type: 'QueryChanged', query: 'beta' });
    expect(isNodeOpen(next.sidebar, groupNode('b'))).toBe(true);
  });
});

function aborted() {
  return { seq: 9, jobId: 'j1', at: '', type: 'job.aborted', reason: 'client' } as never;
}

function diffReady(diffId: string) {
  return { seq: 2, jobId: 'j1', at: '', type: 'diff.ready', diffId, meta: undefined, files: tour().files } as never;
}

describe('review', () => {
  const META = { title: 't', baseRef: 'main', headRef: 'f', headSha: 'head1', commits: [] };
  const reviewable = () => model({ tour: tour({ meta: META } as Partial<TourState>) });
  /** Presses keys as the keyboard subscription sends them. */
  const press = (start: Model, ...keys: string[]) =>
    run(start, ...keys.map((key): Msg => ({ type: 'KeyPressed', key })));
  const submitted = (cmds: readonly Cmd[]) => cmds.flatMap((cmd) => (cmd.type === 'SubmitReview' ? [cmd.request] : []));

  test.each([
    ['a', 'APPROVE'],
    ['n', 'REQUEST_CHANGES'],
    ['c', 'COMMENT'],
  ])('r %s opens the review on that verdict', (key, verdict) => {
    const [next] = press(reviewable(), 'r', key);
    expect(next.review).toMatchObject({ open: true, verdict });
    expect(next.chord).toBeUndefined();
  });

  test('r y approves at once, with the pending comments, at the head the diff was read at', () => {
    const [drafted] = run(
      reviewable(),
      { type: 'CommentStarted', anchor: { fileId: 'f2', side: 'additions', line: 4, startLine: 2 } },
      { type: 'CommentBodyChanged', body: 'why?' },
      { type: 'CommentSaved' },
    );
    const [sending, cmds] = press(drafted, 'r', 'y');
    expect(sending.review.open).toBe(false);
    expect(submitted(cmds)).toEqual([
      {
        owner: 'o',
        repo: 'r',
        number: 1,
        verdict: 'APPROVE',
        body: '',
        comments: [{ path: 'src/f2.ts', side: 'additions', line: 4, startLine: 2, body: 'why?' }],
        commitId: 'head1',
      },
    ]);
    // A second r y while the first is in flight sends nothing.
    expect(submitted(press(sending, 'r', 'y')[1])).toEqual([]);

    const [sent, saved] = run(sending, { type: 'ReviewSent', verdict: 'APPROVE', url: 'u' });
    expect(sent.review).toMatchObject({ comments: [], body: '', sending: false, sent: { verdict: 'APPROVE' } });
    expect(saved).toContainEqual({ type: 'SaveReview', diffId: 'd1', saved: { body: '', comments: [] } });
  });

  test.each(['j', 'z', 'Escape'])('%s after r drops the chord and does nothing else', (key) => {
    const [next, cmds] = press(reviewable(), 'r', key);
    expect(next.chord).toBeUndefined();
    expect(next.position.g).toBeUndefined();
    expect(cmds).toEqual([]);
    expect(press(next, 'a')[0].review.open).toBe(false);
  });

  test('a local diff, or a PR before its diff arrives, cannot be reviewed', () => {
    expect(keyToMsg(model(), 'r')).toBeUndefined();
    const local = { ...reviewable(), ref: { kind: 'local', repo: '/r', target: '' } as const };
    expect(keyToMsg(local, 'r')).toBeUndefined();
    expect(run(local, { type: 'ReviewOpened' })[0].review.open).toBe(false);
  });

  test('request changes without a word opens the dialog with the reason instead of sending', () => {
    const [next, cmds] = run(
      reviewable(),
      { type: 'ReviewVerdictChanged', verdict: 'REQUEST_CHANGES' },
      {
        type: 'ReviewSubmitted',
      },
    );
    expect(submitted(cmds)).toEqual([]);
    expect(next.review.open).toBe(true);
    expect(next.review.error).toBeDefined();
  });

  test('shortcuts stay off while the review panel is open', () => {
    const [open] = run(reviewable(), { type: 'ReviewOpened' });
    expect(keyToMsg(open, 'j')).toBeUndefined();
  });

  test('a failed send keeps the words and reopens the dialog with GitHub’s reason', () => {
    const [failed] = run(
      reviewable(),
      { type: 'ReviewBodyChanged', body: 'lgtm' },
      { type: 'ReviewSubmitted', verdict: 'APPROVE' },
      { type: 'ReviewFailed', error: 'Can not approve your own pull request' },
    );
    expect(failed.review).toMatchObject({
      open: true,
      sending: false,
      body: 'lgtm',
      error: 'Can not approve your own pull request',
    });
  });

  test('editing a comment replaces it; an empty comment is not kept', () => {
    const [one] = run(
      reviewable(),
      { type: 'CommentStarted', anchor: { fileId: 'f1', side: 'deletions', line: 7 } },
      { type: 'CommentSaved' },
      { type: 'CommentBodyChanged', body: 'first' },
      { type: 'CommentSaved' },
    );
    expect(one.review.comments.map((comment) => comment.body)).toEqual(['first']);
    const id = one.review.comments[0]!.id;
    const [edited] = run(
      one,
      { type: 'CommentEdited', id },
      { type: 'CommentBodyChanged', body: 'second' },
      { type: 'CommentSaved' },
    );
    expect(edited.review.comments).toMatchObject([{ id, body: 'second', side: 'deletions', line: 7 }]);
    expect(run(edited, { type: 'CommentRemoved', id })[0].review.comments).toEqual([]);
  });

  test('a re-run on a new diff sets the old draft aside instead of sending it against new lines', () => {
    const [drafted] = run(
      reviewable(),
      { type: 'ReviewBodyChanged', body: 'old' },
      { type: 'CommentStarted', anchor: { fileId: 'f1', side: 'additions', line: 3 } },
      { type: 'CommentBodyChanged', body: 'x' },
      { type: 'CommentSaved' },
    );
    const [rerun, cmds] = run(drafted, {
      type: 'EventReceived',
      event: { type: 'diff.ready', seq: 9, at: '', diffId: 'd2', meta: META, files: [] } as never,
    });
    expect(rerun.tour.diffId).toBe('d2');
    expect(rerun.review).toMatchObject({ body: '', comments: [] });
    expect(cmds).toContainEqual({ type: 'LoadReview', diffId: 'd2' });
    expect(types(cmds)).not.toContain('SaveReview');
  });

  test('a new diff loads its saved review; a stale load is ignored', () => {
    const saved = { body: 'draft', comments: [] };
    expect(run(reviewable(), { type: 'ReviewLoaded', diffId: 'd1', saved })[0].review.body).toBe('draft');
    expect(run(reviewable(), { type: 'ReviewLoaded', diffId: 'old', saved })[0].review.body).toBe('');
  });
});
