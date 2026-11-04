/**
 * Gitignore-style globs, as review tools and `.gitattributes` scope files: `*` and `?` stay within
 * one path segment, `**` crosses them, `[abc]` is a class and `{a,b}` is either. A glob without a
 * slash matches the file name at any depth (`*.py`); with one it is anchored to the repository root
 * (`src/**\/*.ts`, a leading `/` is dropped). A glob that names a folder matches everything in it.
 */
export function globToRegExp(glob: string): RegExp {
  const trimmed = glob.trim();
  const anchored = trimmed.replace(/^\//, '').replace(/\/$/, '');
  const source = segmentSource(trimmed.replace(/\/$/, '').includes('/') ? anchored : `**/${anchored}`);
  try {
    return new RegExp(`^${source}(?:/.*)?$`);
  } catch {
    // A class that cannot compile (`[z-a]`) in a hand-written config: the glob matches nothing.
    return /(?!)/;
  }
}

/** One test per glob; `globToRegExp` builds it. */
export function globMatcher(glob: string): (path: string) => boolean {
  const pattern = globToRegExp(glob);
  return (path) => pattern.test(path);
}

function segmentSource(glob: string): string {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '\\' && i + 1 < glob.length) {
      // `\[id\]` is a literal bracket, as in a Next.js route folder.
      source += glob[++i]!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    } else if (char === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        source += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) {
        source += '\\[';
      } else {
        source += `[${glob
          .slice(i + 1, end)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (char === '{') {
      // One level of alternatives; a brace with no partner, or a nested one, is literal.
      const end = glob.indexOf('}', i + 1);
      const inner = end === -1 ? '' : glob.slice(i + 1, end);
      if (end === -1 || inner.includes('{')) {
        source += '\\{';
      } else {
        source += `(?:${inner.split(',').map(segmentSource).join('|')})`;
        i = end;
      }
    } else {
      source += char.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return source;
}
