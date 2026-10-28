/**
 * Turns a GitHub PR body into the Markdown subset Astryx renders. GitHub allows inline
 * HTML, which Astryx shows as literal text, so the common cases are rewritten:
 * comments (bot attribution, templates) are dropped, `<br>` becomes a line break,
 * `<details>/<summary>` becomes a bold label, images become Markdown images, and any
 * other tag is unwrapped to its text.
 */
export function githubBodyToMarkdown(body: string): string {
  return (
    body
      .replace(/\r\n?/g, '\n')
      .replace(/<!--[\s\S]*?-->/g, '')
      // Leave code alone: tags inside fences and inline code are content, not markup.
      .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
      .map((part, index) => (index % 2 === 1 ? part : rewriteHtml(part)))
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1];
}

function rewriteHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '  \n')
    .replace(/<summary[^>]*>([\s\S]*?)<\/summary>/gi, (_, label: string) => `\n\n**${label.trim()}**\n\n`)
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = attribute(tag, 'src');
      return src ? `![${attribute(tag, 'alt') ?? ''}](${src})` : '';
    })
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (tag: string, label: string) => {
      const href = attribute(tag, 'href');
      return href ? `[${label.trim()}](${href})` : label;
    })
    .replace(
      /<\/?(p|div|details|picture|source|table|thead|tbody|tr|td|th|sub|sup|kbd|span|center|h[1-6])\b[^>]*>/gi,
      '\n',
    )
    .replace(/<\/?(b|strong)>/gi, '**')
    .replace(/<\/?(i|em)>/gi, '_')
    .replace(/<\/?[a-z][a-z0-9-]*\b[^>]*>/gi, '');
}
