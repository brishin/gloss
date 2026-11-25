import { describe, expect, it } from 'vitest';
import {
  activityOf,
  createInboxReader,
  githubPulls,
  type InboxJson,
  type InboxNode,
  inboxTours,
  type PullsJson,
  pullsQuery,
  talkOf,
} from './github.ts';

describe('pullsQuery', () => {
  it('asks for every PR in one query, aliased by position, with names quoted', () => {
    const query = pullsQuery([
      { kind: 'github-pr', owner: 'o', repo: 'r', number: 1 },
      { kind: 'github-pr', owner: 'a"b', repo: 'r.js', number: 22 },
    ]);
    expect(query).toBe(
      'query { p0: repository(owner: "o", name: "r") { pullRequest(number: 1) { author { login } state isDraft isInMergeQueue } } ' +
        'p1: repository(owner: "a\\"b", name: "r.js") { pullRequest(number: 22) { author { login } state isDraft isInMergeQueue } } }',
    );
  });
});

describe('githubPulls', () => {
  it('splits a batch GitHub refuses until only the missing PR is left out', async () => {
    const refs = [1, 2, 3, 4, 5].map((number) => ({ kind: 'github-pr' as const, owner: 'o', repo: 'r', number }));
    let calls = 0;
    const pulls = await githubPulls(refs, undefined, async (text) => {
      calls++;
      const numbers = [...text.matchAll(/number: (\d+)/g)].map((match) => Number(match[1]));
      if (numbers.includes(3)) {
        throw new Error('Could not resolve to a PullRequest');
      }
      return {
        data: Object.fromEntries(
          numbers.map((n, i) => [
            `p${i}`,
            {
              pullRequest: {
                author: { login: `u${n}` },
                state: n === 5 ? 'MERGED' : 'OPEN',
                isDraft: n === 2,
                isInMergeQueue: n === 4,
              },
            },
          ]),
        ),
      } satisfies PullsJson;
    });
    expect([...pulls]).toEqual([
      ['github:o/r#1', { author: 'u1', state: 'open' }],
      ['github:o/r#2', { author: 'u2', state: 'draft' }],
      ['github:o/r#4', { author: 'u4', state: 'queued' }],
      ['github:o/r#5', { author: 'u5', state: 'merged' }],
    ]);
    expect(calls).toBe(5);
  });
});

describe('inboxTours', () => {
  const node = (number: number, base: string, head: string, repo = 'r') => ({
    number,
    title: `#${number}`,
    state: 'OPEN' as const,
    isDraft: number === 3,
    isInMergeQueue: false,
    updatedAt: '2026-11-02T00:00:00Z',
    author: { login: 'me' },
    baseRefName: base,
    headRefName: head,
    repository: { owner: { login: 'o' }, name: repo },
  });

  it('chains PRs on each other into one stack, bottom first, and leaves the rest alone', () => {
    const tours = inboxTours([
      node(3, 'b', 'c'),
      node(9, 'main', 'x'),
      node(1, 'main', 'a'),
      node(2, 'a', 'b'),
      node(4, 'a', 'b', 'other'),
    ]);
    expect(tours.map((tour) => [tour.title, tour.state, tour.stack?.members.map((m) => m.number)])).toEqual([
      ['#3', 'draft', [1, 2, 3]],
      ['#9', 'open', undefined],
      ['#1', 'open', [1, 2, 3]],
      ['#2', 'open', [1, 2, 3]],
      ['#4', 'open', undefined],
    ]);
    expect(tours[0]!.stack?.base).toBe('main');
  });

  it('stops at a cycle of branches', () => {
    expect(inboxTours([node(1, 'b', 'a'), node(2, 'a', 'b')]).map((tour) => tour.stack?.members.length)).toEqual([
      2, 2,
    ]);
  });
});

describe('activityOf', () => {
  const bot = { __typename: 'Bot', login: 'devin-ai-integration' };
  const user = (login: string) => ({ __typename: 'User', login, avatarUrl: `https://a/${login}` });
  const pull: InboxNode = {
    id: 'PR_7',
    number: 7,
    title: 't',
    state: 'OPEN',
    isDraft: false,
    isInMergeQueue: false,
    updatedAt: '2026-11-24T10:00:00Z',
    author: { login: 'ana' },
    baseRefName: 'main',
    headRefName: 'x',
    repository: { owner: { login: 'o' }, name: 'r' },
    additions: 120,
    deletions: 30,
    reviewDecision: null,
    commits: {
      nodes: [{ commit: { committedDate: '2026-11-24T09:00:00Z', statusCheckRollup: { state: 'FAILURE' } } }],
    },
    latestReviews: {
      nodes: [
        { author: bot, state: 'COMMENTED', submittedAt: '2026-11-24T08:00:00Z' },
        { author: user('me'), state: 'APPROVED', submittedAt: '2026-11-24T08:30:00Z' },
      ],
    },
    reviewRequests: {
      nodes: [{ requestedReviewer: user('li') }, { requestedReviewer: { __typename: 'Bot', login: 'copilot' } }],
    },
    reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] },
  };

  it('leaves bots out of the reviewers and keeps the viewer review time', () => {
    expect(activityOf(pull, 'me', { people: 3, bots: 3 })).toEqual({
      additions: 120,
      deletions: 30,
      checks: 'failing',
      pushedAt: '2026-11-24T09:00:00Z',
      updatedAt: '2026-11-24T10:00:00Z',
      reviewers: [
        { login: 'me', state: 'approved', avatar: 'https://a/me' },
        { login: 'li', state: 'pending', avatar: 'https://a/li' },
      ],
      reviewDecision: 'approved',
      openThreads: 1,
      comments: { people: 3, bots: 3 },
      viewerReviewedAt: '2026-11-24T08:30:00Z',
    });
  });

  it('reads an old inbox answer without the new fields', () => {
    const bare: InboxNode = {
      number: pull.number,
      title: pull.title,
      state: pull.state,
      isDraft: pull.isDraft,
      isInMergeQueue: pull.isInMergeQueue,
      updatedAt: pull.updatedAt,
      author: pull.author,
      baseRefName: pull.baseRefName,
      headRefName: pull.headRefName,
      repository: pull.repository,
    };
    expect(activityOf(bare)).toEqual({
      additions: 0,
      deletions: 0,
      updatedAt: pull.updatedAt,
      reviewers: [],
      openThreads: 0,
    });
  });

  it('counts talk from people and bots; an empty review note is not talk', () => {
    expect(
      talkOf({
        id: 'PR_7',
        comments: { nodes: [{ author: bot }, { author: user('ana') }] },
        reviews: {
          nodes: [
            { author: bot, body: 'Summary' },
            { author: user('me'), body: ' ' },
          ],
        },
        reviewThreads: {
          nodes: [
            { comments: { nodes: [{ author: bot }, { author: user('ana') }] } },
            { comments: { nodes: [{ author: null }] } },
          ],
        },
      }),
    ).toEqual({ people: 3, bots: 3 });
  });

  it('reads talk again only for PRs that changed since the last read', async () => {
    let updatedAt = pull.updatedAt;
    const asked: string[][] = [];
    const read = createInboxReader({
      inbox: async () =>
        ({
          data: {
            viewer: { login: 'me' },
            review: { nodes: [] },
            reviewed: { nodes: [{ ...pull, updatedAt }] },
            authored: { nodes: [{ ...pull, id: 'PR_8', number: 8, author: { login: 'me' } }] },
          },
        }) satisfies InboxJson,
      talk: async (ids) => {
        asked.push([...ids]);
        return ids.map((id) => ({ id, comments: { nodes: [{ author: user('ana') }] } }));
      },
    });
    const first = await read();
    await read();
    updatedAt = '2026-11-25T00:00:00Z';
    await read();
    expect(asked).toEqual([['PR_7', 'PR_8'], ['PR_7']]);
    expect(first.reviewed[0]!.activity?.comments).toEqual({ people: 1, bots: 0 });
  });
});
