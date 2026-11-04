/**
 * Reads `linguist-generated` (and `-diff`) marks from `.gitattributes` text, for sources
 * without a checkout. Local repositories ask `git check-attr` instead.
 * Gitignore-style matching: a pattern without a slash matches the basename at any depth;
 * with a slash it is anchored to the file's directory. The last matching line wins.
 */

import { globMatcher } from '@gloss/protocol';

interface Rule {
  match: (path: string) => boolean;
  value: boolean;
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
    rules.push({ match: globMatcher(pattern), value });
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
