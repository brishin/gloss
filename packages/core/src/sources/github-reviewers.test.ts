import { describe, expect, test } from 'vitest';
import { reviewersPayload } from './github-reviewers.ts';

describe('reviewersPayload', () => {
  test('asks users by login and teams by slug', () => {
    expect(reviewersPayload([{ login: 'octocat' }, { login: 'acme/web', team: true }])).toEqual({
      reviewers: ['octocat'],
      team_reviewers: ['web'],
    });
  });
});
