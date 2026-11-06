import type { FileChange } from '@gloss/protocol';
import { looksGenerated, looksLikeTest } from '../pipeline/heuristics.ts';

/**
 * What to search for to find who imports a file or package: a fixed string that appears in the
 * import line (`needle`), and the words such a line holds. Undefined for a file other code does
 * not import by path (Swift, Kotlin, CSS and the like), or a name too short to search.
 */
export interface ImportQuery {
  label: string;
  /** What a code search engine looks for: the bare name, since it drops punctuation. */
  term: string;
  needles: string[];
  /** For a script file: its path, so an import can be checked to point at it and not a namesake. */
  path?: string;
}

const IMPORT_WORDS = ['import', 'from', 'require', 'export'];
const SCRIPT = /\.(m|c)?[jt]sx?$/;

/** The import query for a repository file, by language. */
export function fileImportQuery(path: string): ImportQuery | undefined {
  const segments = path.split('/');
  const base = segments.at(-1) ?? '';
  const parent = segments.at(-2);
  if (SCRIPT.test(base)) {
    const stem = base.replace(/(\.d)?\.(m|c)?[jt]sx?$/, '').replace(/\.(web|native|ios|android)$/, '');
    // `foo/index.ts` is imported as `foo`.
    const name = stem === 'index' ? parent : stem;
    if (!name || name.length < 3) {
      return undefined;
    }
    const needles = [`/${name}'`, `/${name}"`, `/${name}.`];
    // ...or by its full name, as directly run TypeScript must (`./sources/index.ts`).
    if (stem === 'index') {
      needles.push(`/${name}/index'`, `/${name}/index"`, `/${name}/index.`);
    }
    return { label: path, term: name, needles, path };
  }
  if (base.endsWith('.py')) {
    const stem = base.slice(0, -3);
    const name = stem === '__init__' ? parent : stem;
    const pkg = stem === '__init__' ? segments.at(-3) : parent;
    if (!name) {
      return undefined;
    }
    // `from app.services.plain import x` and `from app.services import plain`, or relative:
    // `from .plain import x` and `from . import plain`, checked against the importer's package.
    // Later in an import list too (`import helper, plain`, `import (plain, helper)`): the path check
    // below decides.
    const relative = [`.${name} import`, `import ${name}`, `, ${name}`, `(${name}`];
    return pkg
      ? { label: path, term: `${pkg}.${name}`, needles: [`${pkg}.${name}`, `${pkg} import ${name}`, ...relative], path }
      : { label: path, term: name, needles: relative, path };
  }
  return undefined;
}

/** The import query for a package: its name in quotes, as JS and TS import it. */
export function packageImportQuery(name: string): ImportQuery {
  return { label: `package ${name}`, term: name, needles: [`'${name}'`, `"${name}"`, `'${name}/`, `"${name}/`] };
}

/** Whether a line from a search is an import of what the query names. */
export function isImportLine(line: string, query: ImportQuery): boolean {
  return query.needles.some((needle) => line.includes(needle)) && IMPORT_WORDS.some((word) => line.includes(word));
}

/** A path with `.` and `..` segments folded, or undefined when it climbs out of the repository. */
function normalize(path: string): string | undefined {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '..') {
      if (!out.length) {
        return undefined;
      }
      out.pop();
    } else if (segment && segment !== '.') {
      out.push(segment);
    }
  }
  return out.join('/');
}

/** A script path as an import names it: no extension, no platform suffix, no `/index`. */
function moduleName(path: string): string {
  return path
    .replace(/(\.d)?\.(m|c)?[jt]sx?$/, '')
    .replace(/\.(web|native|ios|android)$/, '')
    .replace(/\/index$/, '');
}

/**
 * Whether an import line found in `importer` points at the script file the query names, not at
 * another file of the same name. A relative specifier must resolve to it; an aliased one
 * (`@/editor/RichTextEditor`) must end in its folder and name. Lines with no specifier to check,
 * and queries for packages, pass. A Python query checks relative imports (`pythonImportsPath`).
 */
export function importsQueryPath(importer: string, line: string, query: ImportQuery): boolean {
  if (!query.path) {
    return true;
  }
  if (query.path.endsWith('.py')) {
    return pythonImportsPath(importer, line, query.path);
  }
  const specifiers = [...line.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]!);
  const target = moduleName(query.path);
  const tail = target.split('/').slice(-2).join('/');
  return specifiers.some((specifier) => {
    const named = moduleName(specifier);
    if (named.startsWith('.')) {
      const dir = importer.split('/').slice(0, -1).join('/');
      return normalize(`${dir}/${named}`) === target;
    }
    // An alias root maps somewhere we cannot see: the folder and name must still match.
    return named === tail || named.endsWith(`/${tail}`);
  });
}

/**
 * Whether a Python import line points at `path`. A relative import (`from .plain import x`,
 * `from .. import plain`) must resolve to it from the importer's package; an absolute one matched
 * the query's dotted name already.
 */
function pythonImportsPath(importer: string, line: string, path: string): boolean {
  const match = /\bfrom\s+(\.+)([\w.]*)\s+import\s+(.+)/.exec(line);
  if (!match) {
    // An absolute import must name the module itself, `services.plain` or `services import plain`,
    // whole: not `app.other import plain` or `import plaintext`.
    const segments = path.replace(/(\/__init__)?\.py$/, '').split('/');
    const name = segments.at(-1)!;
    const pkg = segments.at(-2);
    const word = (text: string) => text.replace(/[.]/g, '\\.');
    return pkg
      ? new RegExp(`(^|[\\s.])${word(pkg)}\\.${word(name)}\\b`).test(line) ||
          new RegExp(`(^|[\\s.])${word(pkg)}\\s+import\\s+[\\w\\s,(]*\\b${word(name)}\\b`).test(line)
      : new RegExp(`\\bimport\\s+${word(name)}\\b`).test(line);
  }
  const [, dots, module, names] = match as unknown as [string, string, string, string];
  const target = path.replace(/(\/__init__)?\.py$/, '');
  // One dot is the importer's own package; each more climbs one.
  const base = normalize([...importer.split('/').slice(0, -1), ...Array(dots.length - 1).fill('..')].join('/'));
  if (base === undefined) {
    return false;
  }
  const from = [base, ...module.split('.')].filter(Boolean).join('/');
  if (from === target) {
    return true;
  }
  // `from . import plain`: an imported name may be a module of that package.
  return names
    .replace(/[()]/g, '')
    .split(',')
    .some((name) => `${from ? `${from}/` : ''}${name.trim().split(/\s+/)[0]}` === target);
}

const MANIFEST_KEYS = new Set(['name', 'version', 'main', 'module', 'types', 'private', 'packageManager']);

/** Packages whose version a `package.json` change adds or changes, in diff order. */
export function bumpedPackages(files: readonly FileChange[]): string[] {
  const names: string[] = [];
  for (const file of files) {
    if (!file.path.endsWith('package.json')) {
      continue;
    }
    for (const hunk of file.hunks) {
      for (const line of hunk.patch.split('\n')) {
        const match = /^\+\s*"([^"]+)":\s*"(?:[~^<>=]*\d|workspace:|npm:|link:|file:)/.exec(line);
        if (match && !MANIFEST_KEYS.has(match[1]!) && !names.includes(match[1]!)) {
          names.push(match[1]!);
        }
      }
    }
  }
  return names;
}

/**
 * What to look up before the affected call, most telling first: the packages the change bumps,
 * then the changed code files others may import (modified, not added: nothing imports a new file
 * yet), larger changes first. Tests and generated files are left out.
 */
export function importQueries(files: readonly FileChange[], limit: number): ImportQuery[] {
  const queries = bumpedPackages(files).slice(0, 3).map(packageImportQuery);
  const shared = files
    .filter(
      (file) =>
        (file.status === 'modified' || file.status === 'renamed') &&
        !looksLikeTest(file.path) &&
        !looksGenerated(file.path) &&
        !file.generated,
    )
    .toSorted((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
  for (const file of shared) {
    const query = fileImportQuery(file.path);
    // Two files of one name have the same needles but different importers: the path tells them apart.
    if (query && !queries.some((known) => known.label === query.label)) {
      queries.push(query);
    }
  }
  return queries.slice(0, limit);
}
