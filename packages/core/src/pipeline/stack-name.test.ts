import { describe, expect, test } from 'vitest';
import { blurbOf } from '../sources/github-stack.ts';
import { cleanStackName, stackNamePrompt } from './stack-name.ts';

describe('blurbOf', () => {
  test.each([
    ['no description', null, undefined],
    [
      'only template lines',
      '<!-- marker -->\n_Requested by **Brian** · [thread](https://x)_\n\n## Summary\n',
      undefined,
    ],
    [
      'skips the byline and heading, keeps bullets as prose and links as text',
      '<!-- m -->\n_Requested by **Brian**_\n\n## Summary\n\n- Adds `nameStack` via the [fast tier](https://x).\n- Caches it.',
      'Adds nameStack via the fast tier. Caches it.',
    ],
    ['drops images and rules', '![shot](https://x.png)\n---\nShows names.', 'Shows names.'],
    [
      'drops a Generated with Claude Code footer and session links',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nhttps://claude.ai/code/session_1\nThis is step 3.',
      'This is step 3.',
    ],
  ])('%s', (_, body, blurb) => {
    expect(blurbOf(body)).toBe(blurb);
  });

  test('cuts a long description at a word', () => {
    const blurb = blurbOf(`${'word '.repeat(100)}end`)!;
    expect(blurb.length).toBeLessThanOrEqual(201);
    expect(blurb.endsWith('word…')).toBe(true);
  });
});

describe('cleanStackName', () => {
  test.each([
    ['"Stack names in the rail."', 'Stack names in the rail'],
    ['  Effect\nrewrite  ', 'Effect rewrite'],
    ['“Android editor”', 'Android editor'],
    [`${'Long words '.repeat(8)}`, 'Long words Long words Long words Long words'],
  ])('%s', (raw, name) => {
    expect(cleanStackName(raw)).toBe(name);
  });
});

test('the prompt leaves out states and authors, so a merge keeps the name', () => {
  const member = { number: 1, title: 'One', state: 'open' as const, author: 'ana', baseRef: 'main', headRef: 'a' };
  const stack = { owner: 'o', repo: 'r', base: 'main', members: [member, { ...member, number: 2, baseRef: 'a' }] };
  const merged = { ...stack, members: [{ ...member, state: 'merged' as const, author: 'bo' }, stack.members[1]!] };
  expect(stackNamePrompt(merged)).toBe(stackNamePrompt(stack));
  expect(stackNamePrompt(stack)).not.toContain('ana');
});
