/**
 * Reads `linguist-generated` (and `-diff`) marks from `.gitattributes` text, for sources
 * without a checkout. Local repositories ask `git check-attr` instead.
 * Gitignore-style matching: a pattern without a slash matches the basename at any depth;
 * with a slash it is anchored to the file's directory. The last matching line wins.
 */

interface Rule {
  match: (path: string) => boolean;
  value: boolean;
}

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*') {
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
      const end = glob.indexOf(']', i + 1);
      if (end === -1) {
        source += '\\[';
      } else {
        source += `[${glob
          .slice(i + 1, end)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else {
      source += char.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}(?:/.*)?$`);
}

export function parseGitattributes(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const [pattern, ...attrs] = line.split(/\s+/);
    let value: boolean | undefined;
    for (const attr of attrs) {
      if (
        attr === 'linguist-generated' ||
        attr === 'linguist-generated=true' ||
        attr === '-diff' ||
        attr === 'binary'
      ) {
        value = true;
      } else if (attr === 'linguist-generated=false' || attr === '-linguist-generated') {
        value = false;
      }
    }
    if (value === undefined || !pattern) {
      continue;
    }
    const anchored = pattern.replace(/^\//, '');
    const regexp = globToRegExp(pattern.includes('/') ? anchored : `**/${anchored}`);
    rules.push({ match: (path) => regexp.test(path), value });
  }
  return rules;
}

export function isGenerated(rules: readonly Rule[], path: string): boolean {
  let result = false;
  for (const rule of rules) {
    if (rule.match(path)) {
      result = rule.value;
    }
  }
  return result;
}
