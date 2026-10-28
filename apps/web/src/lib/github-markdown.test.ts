import { describe, expect, it } from 'vitest';
import { githubBodyToMarkdown } from './github-markdown.ts';

describe('githubBodyToMarkdown', () => {
  it('drops comments and rewrites the HTML GitHub bodies commonly carry', () => {
    const body = [
      '<!-- claude-projects-attribution: {"github_login":"brishin"} -->',
      '_Requested by **Brian**_\r',
      '\r',
      '## Before\r',
      'line one<br>line two\r',
      '<details><summary>Screenshots</summary>\r',
      '<img src="https://x/a.png" alt="before"><img width="20" src="https://x/b.png">\r',
      '</details>\r',
      'See <a href="https://x/doc">the doc</a> and <b>this</b>.',
    ].join('\n');
    expect(githubBodyToMarkdown(body)).toBe(
      [
        '_Requested by **Brian**_',
        '',
        '## Before',
        'line one  ',
        'line two',
        '',
        '**Screenshots**',
        '',
        '![before](https://x/a.png)![](https://x/b.png)',
        '',
        'See [the doc](https://x/doc) and **this**.',
      ].join('\n'),
    );
  });

  it('leaves tags inside code untouched', () => {
    const body = 'Renders `<Banner>` now.\n\n```tsx\n<div className="x"><br/></div>\n```';
    expect(githubBodyToMarkdown(body)).toBe(body);
  });
});
