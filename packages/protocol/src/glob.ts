/**
 * Gitignore-style globs, as review tools and `.gitattributes` scope files: `*` and `?` stay within
 * one path segment, `**` crosses them, `[abc]` is a class, `{a,b}` is either and `\` escapes the
 * next character. A glob without a slash matches the file name at any depth (`*.py`); with one it
 * is anchored to the repository root (`src/**\/*.ts`, a leading `/` is dropped). A glob that names
 * a folder matches everything in it.
 *
 * Globs come from configs anyone with write access to a repository can commit, so they are not
 * turned into regular expressions, whose backtracking can take exponential time on a crafted glob
 * (`*a*a*a…b`). A glob runs as a small automaton instead: time grows with path length times glob
 * length. A glob that cannot be read (a class such as `[z-a]`, or too many `{}` alternatives)
 * matches nothing.
 */
export function globMatcher(glob: string): (path: string) => boolean {
  const trimmed = glob.trim().replace(/\/$/, '');
  const anchored = trimmed.includes('/');
  const body = trimmed.replace(/^\//, '');
  const alternatives = expandBraces(anchored ? body : `**/${body}`);
  const programs = alternatives?.map(compile);
  if (!programs || programs.some((program) => !program)) {
    return () => false;
  }
  return (path) => programs.some((program) => run(program!, path));
}

/** Alternatives past this many (`{a,b}{c,d}…` multiplies) make the glob match nothing. */
const MAX_ALTERNATIVES = 64;

/** `a{b,c}d` as `abd` and `acd`. One level: a brace with no partner, or a nested one, is literal. */
function expandBraces(glob: string): string[] | undefined {
  let out = [''];
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '\\' && i + 1 < glob.length) {
      out = out.map((prefix) => prefix + char + glob[i + 1]);
      i++;
      continue;
    }
    const end = char === '{' ? glob.indexOf('}', i + 1) : -1;
    const inner = end === -1 ? '' : glob.slice(i + 1, end);
    if (end === -1 || inner.includes('{')) {
      // A literal brace stays escaped, so the tokenizer reads it as a character.
      out = out.map((prefix) => prefix + (char === '{' ? '\\{' : char));
      continue;
    }
    const options = inner.split(',');
    out = out.flatMap((prefix) => options.map((option) => prefix + option));
    if (out.length > MAX_ALTERNATIVES) {
      return undefined;
    }
    i = end;
  }
  return out;
}

/**
 * One step of a glob: a character test, `*` (any run within a segment), `**` (any run) or `**\/`
 * (nothing, or any run that ends in a slash).
 */
type Step =
  | { kind: 'char'; test: (char: string) => boolean }
  | { kind: 'star' }
  | { kind: 'globstar' }
  | { kind: 'globstarSlash' };

function compile(glob: string): Step[] | undefined {
  const steps: Step[] = [];
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '\\' && i + 1 < glob.length) {
      const literal = glob[++i]!;
      steps.push({ kind: 'char', test: (c) => c === literal });
    } else if (char === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        steps.push({ kind: slash ? 'globstarSlash' : 'globstar' });
        i += slash ? 2 : 1;
      } else if (steps.at(-1)?.kind !== 'star') {
        steps.push({ kind: 'star' });
      }
    } else if (char === '?') {
      steps.push({ kind: 'char', test: (c) => c !== '/' });
    } else if (char === '[' && glob.indexOf(']', i + 2) !== -1) {
      const end = glob.indexOf(']', i + 2);
      const body = glob
        .slice(i + 1, end)
        .replace(/^!/, '^')
        .replace(/\\/g, '\\\\');
      let pattern: RegExp;
      try {
        // One character at a time: a class alone cannot backtrack.
        pattern = new RegExp(`^[${body}]$`);
      } catch {
        return undefined;
      }
      steps.push({ kind: 'char', test: (c) => pattern.test(c) });
      i = end;
    } else {
      steps.push({ kind: 'char', test: (c) => c === char });
    }
  }
  return steps;
}

/**
 * Runs the steps over the path, keeping the set of steps reached so far. State `i` is "before step
 * i"; state `steps.length + 1 + i` is "inside `**\/` step i, waiting for a slash". The glob matches when
 * every step is done at the end of the path, or right before a slash (a folder's contents).
 */
function run(steps: readonly Step[], path: string): boolean {
  const done = steps.length;
  const inside = done + 1;
  const close = (states: Set<number>) => {
    // Every wildcard step may match nothing, so it can be skipped.
    for (const state of states) {
      for (let next = state; next < done && steps[next]!.kind !== 'char'; next++) {
        states.add(next + 1);
      }
    }
    return states;
  };
  let states = close(new Set([0]));
  for (let at = 0; at <= path.length; at++) {
    if (states.has(done) && (at === path.length || path[at] === '/')) {
      return true;
    }
    if (at === path.length || states.size === 0) {
      return false;
    }
    const char = path[at]!;
    const next = new Set<number>();
    for (const state of states) {
      if (state === done) {
        continue;
      }
      if (state >= inside) {
        // Inside `**/`: any character keeps it there; a slash also ends it.
        const step = state - inside;
        next.add(state);
        if (char === '/') {
          next.add(step + 1);
        }
        continue;
      }
      const step = steps[state]!;
      if (step.kind === 'char') {
        if (step.test(char)) {
          next.add(state + 1);
        }
      } else if (step.kind === 'star') {
        if (char !== '/') {
          next.add(state);
        }
      } else if (step.kind === 'globstar') {
        next.add(state);
      } else {
        next.add(inside + state);
        if (char === '/') {
          next.add(state + 1);
        }
      }
    }
    states = close(next);
  }
  return false;
}
