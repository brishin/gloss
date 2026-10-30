import type { DiffPayload, FileSummary, Stack, TourState } from '@gloss/protocol';
import { initialTourState } from '@gloss/protocol';
import { describe, expect, test } from 'vitest';
import { groupNode, isNodeOpen } from './sidebar-tree.ts';
import { type Cmd, init, initialModel, keyToMsg, type Model, type Msg, type Spied, update } from './tour-model.ts';
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
  test('starts the tour and holds the position from the URL until it can be shown', () => {
    const [start, cmds] = init(REF, { g: 'a', f: 'f2' });
    expect(cmds[0]).toEqual({ type: 'StartTour', ref: REF, force: false });
    expect(types(cmds)).toContain('SetTitle');
    expect(start.restoring).toEqual({ g: 'a', f: 'f2' });
    expect(start.connection).toBe('connecting');
    expect(init(REF, {})[0].restoring).toBeUndefined();
  });

  test('a PR fetches its stack; a local diff has none', () => {
    expect(init(REF, {})[1]).toContainEqual({ type: 'FetchStack', ref: REF });
    expect(types(init({ kind: 'local', repo: '/r', target: '' }, {})[1])).not.toContain('FetchStack');
  });
});

const scrolled = (spied: Spied): Msg => ({ type: 'Scrolled', spied });

describe('jumping', () => {
  test('a group jump pushes history, scrolls to the group and unfolds the sidebar to it', () => {
    const [next, cmds] = run(model({ activeFileId: 'f1' }), { type: 'GroupSelected', key: 'b' });
    expect(next.position).toEqual({ g: 'b', f: undefined });
    expect(next.activeFileId).toBeUndefined();
    expect(cmds.filter((cmd) => cmd.type === 'Navigate')).toEqual([
      { type: 'Navigate', position: { g: 'b', f: undefined }, replace: false },
    ]);
    expect(cmds).toContainEqual({ type: 'ScrollToGroup', key: 'b' });
    expect(isNodeOpen(next.sidebar, groupNode('b'))).toBe(true);
    expect(run(next, { type: 'GroupSelected', key: OVERVIEW })[1]).toContainEqual({ type: 'ScrollToTop' });
  });

  test('jumping to where the reader already is scrolls there without a new history entry', () => {
    const [, cmds] = run(model({ position: { g: 'a' } }), { type: 'GroupSelected', key: 'a' });
    expect(cmds).toContainEqual({ type: 'ScrollToGroup', key: 'a' });
    expect(types(cmds)).not.toContain('Navigate');
  });

  test('j and k walk overview → groups and stop at the ends', () => {
    const [atA] = run(model(), { type: 'GroupStepped', by: 1 });
    expect(atA.position.g).toBe('a');
    const [atB] = run(atA, { type: 'GroupStepped', by: 1 }, { type: 'GroupStepped', by: 1 });
    expect(atB.position.g).toBe('b');
    const [back] = run(atA, { type: 'GroupStepped', by: -1 }, { type: 'GroupStepped', by: -1 });
    expect(back.position.g).toBeUndefined();
  });

  test('a file in another group moves there at the file, with one history entry', () => {
    const [next, cmds] = run(model({ position: { g: 'a' } }), { type: 'FileJumped', fileId: 'f3' });
    expect(next.position.g).toBe('b');
    expect(next.activeFileId).toBe('f3');
    expect(types(cmds)).toContain('ScrollToFile');
    expect(types(cmds)).not.toContain('ScrollToGroup');
    expect(cmds.filter((cmd) => cmd.type === 'Navigate')).toEqual([
      { type: 'Navigate', position: { g: 'b', f: undefined }, replace: false },
    ]);
  });

  test('n and p walk every file down the page, across groups', () => {
    const [atF2] = run(model({ position: { g: 'a' }, activeFileId: 'f1' }), { type: 'FileStepped', by: 1 });
    expect(atF2.activeFileId).toBe('f2');
    const [atF3, cmds] = run(atF2, { type: 'FileStepped', by: 1 });
    expect(atF3.activeFileId).toBe('f3');
    expect(atF3.position.g).toBe('b');
    expect(cmds.filter((cmd) => cmd.type === 'Navigate').every((cmd) => cmd.type === 'Navigate' && cmd.replace)).toBe(
      true,
    );
    expect(run(atF3, { type: 'FileStepped', by: 1 })[0].activeFileId).toBe('f3');
    expect(run(model(), { type: 'FileStepped', by: 1 })[0].activeFileId).toBe('f1');
  });

  test('a vanished group falls back to the overview', () => {
    const [stepped] = run(model({ position: { g: 'gone' } }), { type: 'GroupStepped', by: 1 });
    expect(stepped.position.g).toBe('a');
  });
});

describe('scrolling', () => {
  test('the position follows the page and replaces the URL entry; a group starts at its first file', () => {
    const [inA, cmds] = run(model(), scrolled({ groupKey: 'a' }));
    expect(inA.position).toEqual({ g: 'a', f: undefined });
    expect(inA.activeFileId).toBe('f1');
    expect(cmds).toContainEqual({ type: 'Navigate', position: { g: 'a', f: undefined }, replace: true });
    expect(types(cmds)).not.toContain('ScrollToGroup');
    const [atF2, more] = run(inA, scrolled({ groupKey: 'a', fileId: 'f2' }));
    expect(atF2.position).toEqual({ g: 'a', f: 'f2' });
    expect(more).toContainEqual({ type: 'Navigate', position: { g: 'a', f: 'f2' }, replace: true });
    const [top] = run(atF2, scrolled({}));
    expect(top.position).toEqual({ g: undefined, f: undefined });
    expect(top.activeFileId).toBeUndefined();
  });

  test('a file still above the next group header is not that group’s current file', () => {
    const [next] = run(model({ position: { g: 'a' } }), scrolled({ groupKey: 'b', fileId: 'f2' }));
    expect(next.position.g).toBe('b');
    expect(next.activeFileId).toBe('f3');
  });

  test('at the bottom of the page, a stop just jumped to stays current while it is on screen', () => {
    const [jumped] = run(model(), { type: 'GroupSelected', key: 'a' });
    const bottom = { groupKeys: ['a', 'b'], fileIds: ['f2', 'f3'] };
    const [kept] = run(jumped, scrolled({ visible: bottom }));
    expect(kept.position.g).toBe('a');
    const [last] = run(model({ position: { g: 'gone' } }), scrolled({ visible: bottom }));
    expect(last.position.g).toBe('b');
    const [file] = run(
      model({ position: { g: 'a' }, activeFileId: 'f2' }),
      scrolled({ groupKey: 'a', visible: bottom }),
    );
    expect(file.activeFileId).toBe('f2');
  });

  test('back/forward to another file restores it', () => {
    const [next, cmds] = run(model({ position: { g: 'a' } }), { type: 'UrlChanged', position: { g: 'a', f: 'f2' } });
    expect(next.restoring).toBeUndefined();
    expect(next.activeFileId).toBe('f2');
    expect(cmds).toContainEqual({ type: 'RestoreFile', fileId: 'f2' });
    expect(types(cmds)).not.toContain('Navigate');
  });

  test('back/forward to another group or the overview scrolls there', () => {
    const [inB, cmds] = run(model({ position: { g: 'a' } }), { type: 'UrlChanged', position: { g: 'b' } });
    expect(inB.position.g).toBe('b');
    expect(cmds).toContainEqual({ type: 'RestoreGroup', key: 'b' });
    expect(run(inB, { type: 'UrlChanged', position: {} })[1]).toContainEqual({ type: 'ScrollToTop' });
  });

  test('the position the page wrote itself is a no-op', () => {
    const start = model({ position: { g: 'a', f: 'f2' } });
    const [next, cmds] = update(start, { type: 'UrlChanged', position: { g: 'a', f: 'f2' } });
    expect(next).toBe(start);
    expect(cmds).toEqual([]);
  });
});

describe('restoring', () => {
  test('waits for the diff, then scrolls to the file and opens it; scrolling meanwhile does not move it', () => {
    const start = model({ position: { g: 'a', f: 'f2' }, restoring: { g: 'a', f: 'f2' }, diff: undefined });
    const [waiting, none] = run(start, { type: 'NavClosed' }, scrolled({}));
    expect(waiting.restoring).toEqual({ g: 'a', f: 'f2' });
    expect(waiting.position).toEqual({ g: 'a', f: 'f2' });
    expect(types(none)).not.toContain('Navigate');
    const [restored, cmds] = run(waiting, { type: 'DiffLoaded', diff: DIFF });
    expect(restored.restoring).toBeUndefined();
    expect(restored.activeFileId).toBe('f2');
    expect(restored.expanded.f2).toBe(true);
    expect(cmds).toContainEqual({ type: 'RestoreFile', fileId: 'f2' });
    expect(types(cmds)).not.toContain('MeasurePosition');
  });

  test('a group waits for the diff too', () => {
    const start = model({ position: { g: 'b' }, restoring: { g: 'b' }, diff: undefined });
    const [restored, cmds] = run(start, { type: 'DiffLoaded', diff: DIFF });
    expect(restored.restoring).toBeUndefined();
    expect(cmds).toContainEqual({ type: 'RestoreGroup', key: 'b' });
  });

  test('gives up once a finished tour turns out not to have it', () => {
    const start = model({ position: { g: 'a', f: 'gone' }, restoring: { g: 'a', f: 'gone' } });
    const [running] = run(start, { type: 'NavToggled' });
    expect(running.restoring).toEqual({ g: 'a', f: 'gone' });
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
    ['J', base, { type: 'StackStepped', by: 1 }],
    ['K', base, { type: 'StackStepped', by: -1 }],
    ['q', base, undefined],
    ['d', base, { type: 'PipelineOpened' }],
  ] as const)('%s', (key, state, expected) => {
    expect(keyToMsg(state, key)).toEqual(expected);
  });

  test('d opens the pipeline view for the tour', () => {
    expect(update(base, { type: 'PipelineOpened' })[1]).toEqual([{ type: 'OpenPipeline', ref: base.ref }]);
  });
});

describe('stack', () => {
  const stack = {
    owner: 'o',
    repo: 'r',
    base: 'main',
    members: [0, 1, 2].map((number) => ({ number, title: `PR ${number}`, state: 'open', baseRef: 'x', headRef: 'y' })),
  } as Stack;
  const pr = (number: number) => ({ kind: 'github-pr', owner: 'o', repo: 'r', number }) as const;

  test.each([
    [1, 'J opens the PR above', { by: 1 }, [{ type: 'OpenRef', ref: pr(2) }]],
    [1, 'K opens the PR below', { by: -1 }, [{ type: 'OpenRef', ref: pr(0) }]],
    [2, 'J at the top does nothing', { by: 1 }, []],
    [0, 'K at the bottom does nothing', { by: -1 }, []],
  ] as const)('from #%i, %s', (number, _, { by }, expected) => {
    const [, cmds] = run({ ...model(), ref: pr(number), stack }, { type: 'StackStepped', by });
    expect(cmds).toEqual(expected);
  });

  test('does nothing before the stack loads', () => {
    expect(run(model(), { type: 'StackStepped', by: 1 })[1]).toEqual([]);
  });
});

describe('sidebar', () => {
  test('clicking a group row jumps to it, even when it is the current one', () => {
    const [start] = run(model(), { type: 'GroupSelected', key: 'a' });
    expect(isNodeOpen(start.sidebar, groupNode('a'))).toBe(true);
    const [again, cmds] = run(start, { type: 'SidebarActivated', node: groupNode('a'), key: 'a' });
    expect(isNodeOpen(again.sidebar, groupNode('a'))).toBe(true);
    expect(cmds).toContainEqual({ type: 'ScrollToGroup', key: 'a' });
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

  test('r opens the review on Approve and waits for the next key', () => {
    const [next, cmds] = press(reviewable(), 'r');
    expect(next.review).toMatchObject({ open: true, verdict: 'APPROVE' });
    expect(next.chord).toBe('r');
    expect(cmds).toEqual([]);
  });

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
    expect(sending.review.sending).toBeDefined();
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

    const [sent, saved] = run(sending, { type: 'ReviewSent', diffId: 'd1', verdict: 'APPROVE', url: 'u' });
    expect(sent.review).toMatchObject({ comments: [], body: '', sending: undefined, sent: { verdict: 'APPROVE' } });
    expect(saved).toContainEqual({ type: 'SaveReview', diffId: 'd1', saved: { body: '', comments: [] } });
  });

  test.each(['j', 'z'])('%s after r drops the chord and leaves the review open on Approve', (key) => {
    const [next, cmds] = press(reviewable(), 'r', key);
    expect(next.chord).toBeUndefined();
    expect(next.review).toMatchObject({ open: true, verdict: 'APPROVE' });
    expect(next.position.g).toBeUndefined();
    expect(cmds).toEqual([]);
    expect(press(next, 'n')[0].review.verdict).toBe('APPROVE');
  });

  test('Escape after r closes the review', () => {
    const [next] = press(reviewable(), 'r', 'Escape');
    expect(next.chord).toBeUndefined();
    expect(next.review.open).toBe(false);
  });

  test('a local diff, or a PR before its diff arrives, cannot be reviewed', () => {
    expect(keyToMsg(model(), 'r')).toBeUndefined();
    const local = { ...reviewable(), ref: { kind: 'local', repo: '/r', target: '' } as const };
    expect(keyToMsg(local, 'r')).toBeUndefined();
    expect(run(local, { type: 'ReviewOpened' })[0].review.open).toBe(false);
  });

  test('an answer for a review sent on an earlier diff is ignored', () => {
    const [sending] = run(
      reviewable(),
      { type: 'ReviewBodyChanged', body: 'old' },
      { type: 'ReviewSubmitted', verdict: 'APPROVE' },
      {
        type: 'EventReceived',
        event: { type: 'diff.ready', seq: 9, at: '', diffId: 'd2', meta: META, files: [] } as never,
      },
      { type: 'ReviewBodyChanged', body: 'new' },
      { type: 'ReviewSubmitted', verdict: 'APPROVE' },
    );
    const [after] = run(sending, { type: 'ReviewSent', diffId: 'd1', verdict: 'APPROVE', url: 'u' });
    expect(after.review).toMatchObject({ body: 'new', sent: undefined });
    expect(after.review.sending).toBeDefined();
  });

  test('words written while a review is on its way stay in the draft', () => {
    const [sending] = run(
      reviewable(),
      { type: 'ReviewBodyChanged', body: 'lgtm' },
      { type: 'ReviewSubmitted', verdict: 'APPROVE' },
    );
    const [after] = run(
      sending,
      { type: 'CommentStarted', anchor: { fileId: 'f1', side: 'additions', line: 2 } },
      { type: 'CommentBodyChanged', body: 'later' },
      { type: 'CommentSaved' },
      { type: 'ReviewSent', diffId: 'd1', verdict: 'APPROVE', url: 'u' },
    );
    expect(after.review.body).toBe('');
    expect(after.review.comments.map((comment) => comment.body)).toEqual(['later']);
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
    expect(next.review.problem).toBeDefined();
  });

  test('starting another review drops the last confirmation', () => {
    const [sent] = run(
      reviewable(),
      { type: 'ReviewSubmitted', verdict: 'APPROVE' },
      { type: 'ReviewSent', diffId: 'd1', verdict: 'APPROVE', url: 'u' },
    );
    expect(sent.review.sent).toBeDefined();
    expect(run(sent, { type: 'ReviewOpened', verdict: 'REQUEST_CHANGES' })[0].review.sent).toBeUndefined();
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
      { type: 'ReviewFailed', diffId: 'd1', error: 'Can not approve your own pull request' },
    );
    expect(failed.review).toMatchObject({
      open: true,
      sending: undefined,
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
