import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Language, Node, Parser as ParserType } from '@vscode/tree-sitter-wasm';

/**
 * What a line that names a symbol does with it, read from the file's syntax tree: grep finds the
 * lines, the tree tells a call from an import, a definition, a comment or a string.
 */
export type UseKind = 'call' | 'pass' | 'set' | 'read';
/** `define` and `import` name the symbol without using it; `text` is a comment or a string. */
export type NameKind = UseKind | 'define' | 'import' | 'text';

const require = createRequire(import.meta.url);
const GRAMMARS: Record<string, string> = {
  py: 'python',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  go: 'go',
  rs: 'rust',
  java: 'java',
  rb: 'ruby',
};
/** A file longer than this is not parsed. */
const PARSE_CHARS = 1_500_000;

let runtime: Promise<typeof import('@vscode/tree-sitter-wasm')> | undefined;
const languages = new Map<string, Promise<Language>>();

async function parserFor(path: string): Promise<ParserType | undefined> {
  const grammar = GRAMMARS[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];
  if (!grammar) {
    return undefined;
  }
  runtime ??= (async () => {
    const loaded = require('@vscode/tree-sitter-wasm') as typeof import('@vscode/tree-sitter-wasm');
    await loaded.Parser.init();
    return loaded;
  })();
  const { Language: Loader, Parser } = await runtime;
  let language = languages.get(grammar);
  if (!language) {
    language = Loader.load(join(dirname(require.resolve('@vscode/tree-sitter-wasm')), `tree-sitter-${grammar}.wasm`));
    languages.set(grammar, language);
  }
  const parser = new Parser();
  parser.setLanguage(await language);
  return parser;
}

const IMPORTS = new Set([
  'import_statement',
  'import_from_statement',
  'future_import_statement',
  'import_specifier',
  'import_clause',
  'namespace_import',
  'export_specifier',
  'import_declaration',
  'import_spec',
  'use_declaration',
]);
const NAMED = new Set([
  'function_definition',
  'function_declaration',
  'generator_function_declaration',
  'function_signature',
  'function_item',
  'class_definition',
  'class_declaration',
  'abstract_class_declaration',
  'method_definition',
  'method_declaration',
  'method_signature',
  'abstract_method_signature',
  'property_signature',
  'public_field_definition',
  'field_definition',
  'variable_declarator',
  'type_alias_declaration',
  'interface_declaration',
  'enum_declaration',
  'default_parameter',
  'typed_default_parameter',
]);
const PARAMETERS = new Set([
  'parameters',
  'typed_parameter',
  'list_splat_pattern',
  'dictionary_splat_pattern',
  'required_parameter',
  'optional_parameter',
  'formal_parameters',
  'lambda_parameters',
  'object_pattern',
  'array_pattern',
]);
const ASSIGNS = new Set([
  'assignment',
  'assignment_expression',
  'augmented_assignment',
  'augmented_assignment_expression',
]);
const CALLS = new Set(['call', 'call_expression', 'new_expression']);
const MEMBERS = new Set(['attribute', 'member_expression', 'selector_expression', 'field_expression']);
const FUNCTIONS = new Set([
  'function_definition',
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'lambda',
  'function_item',
  'method_declaration',
]);

function fieldOf(node: Node): string | undefined {
  const parent = node.parent;
  for (let index = 0; parent && index < parent.childCount; index += 1) {
    if (parent.child(index)?.id === node.id) {
      return parent.fieldNameForChild(index) ?? undefined;
    }
  }
  return undefined;
}

/** What the name at `node` does there. */
function kindOf(node: Node): NameKind {
  if (!/identifier|^constant$/.test(node.type)) {
    return 'text';
  }
  const parent = node.parent;
  if (!parent) {
    return 'read';
  }
  for (let above: Node | null = parent, depth = 0; above && depth < 4; above = above.parent, depth += 1) {
    if (IMPORTS.has(above.type)) {
      return 'import';
    }
  }
  const field = fieldOf(node);
  const upper = parent.parent;
  if (node.type === 'shorthand_property_identifier_pattern' || (parent.type === 'pair_pattern' && field === 'value')) {
    // `const { name } = await import('./module')` and `= require('./module')` import the name.
    let declared: Node | null = parent;
    while (declared && declared.type !== 'variable_declarator' && !/parameter|statement/.test(declared.type)) {
      declared = declared.parent;
    }
    const value = declared?.type === 'variable_declarator' ? declared.childForFieldName('value')?.text : undefined;
    return value && /^(await\s+)?(import|require)\s*\(/.test(value) ? 'import' : 'define';
  }
  if (NAMED.has(parent.type) && field === 'name') {
    return 'define';
  }
  if (PARAMETERS.has(parent.type) && (field === undefined || field === 'pattern')) {
    return 'define';
  }
  // Python: `name: Type = value` in a class body declares a field.
  if (parent.type === 'assignment' && field === 'left' && parent.childForFieldName('type')) {
    return 'define';
  }
  if (ASSIGNS.has(parent.type) && field === 'left') {
    return 'set';
  }
  const member = MEMBERS.has(parent.type) && (field === 'attribute' || field === 'property' || field === 'field');
  if (member && upper && ASSIGNS.has(upper.type) && upper.childForFieldName('left')?.id === parent.id) {
    return 'set';
  }
  if (CALLS.has(parent.type) && (field === 'function' || field === 'constructor')) {
    return 'call';
  }
  if (member && upper && CALLS.has(upper.type) && upper.childForFieldName('function')?.id === parent.id) {
    return 'call';
  }
  if ((parent.type === 'jsx_self_closing_element' || parent.type === 'jsx_opening_element') && field === 'name') {
    return 'call';
  }
  if (parent.type === 'keyword_argument' && field === 'name') {
    return 'pass';
  }
  if (parent.type === 'jsx_attribute' && parent.child(0)?.id === node.id) {
    return 'pass';
  }
  if (parent.type === 'pair' && field === 'key') {
    // `f({ name: value })` passes it; `const o = { name: value }` only makes a property.
    return upper?.parent?.type === 'arguments' ? 'pass' : 'define';
  }
  return 'read';
}

/** Whether a defined name is a parameter: its uses include every caller that passes it by name. */
function parameter(node: Node): boolean {
  for (let above = node.parent, depth = 0; above && depth < 3; above = above.parent, depth += 1) {
    if (/parameter/.test(above.type)) {
      return true;
    }
  }
  return false;
}

const ORDER: readonly NameKind[] = ['call', 'pass', 'set', 'read', 'define', 'import', 'text'];
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface NamedAt {
  kind: NameKind;
  /** The name is reached through something: `router.invalidate`, `invalidate=`. */
  member: boolean;
  /** Rows (from 1) of the function around a definition that is not a parameter, when there is one. */
  within?: { from: number; to: number };
  /** A definition that is a parameter. */
  parameter?: boolean;
  /** A definition at the top of a JavaScript or TypeScript file that the file does not export. */
  unexported?: boolean;
}

/**
 * What each of `lines` (from 1) of `source` does with `symbol`; a line with several mentions takes
 * its strongest one. Undefined when the file's language has no grammar here or it does not parse.
 */
export async function namedAt(
  path: string,
  source: string,
  symbol: string,
  lines: readonly number[],
): Promise<Map<number, NamedAt> | undefined> {
  if (source.length > PARSE_CHARS) {
    return undefined;
  }
  const parser = await parserFor(path).catch(() => undefined);
  const tree = parser?.parse(source);
  if (!parser || !tree) {
    parser?.delete();
    return undefined;
  }
  try {
    const rows = source.split('\n');
    const word = new RegExp(`(?<![\\w$])${escaped(symbol)}(?![\\w$])`, 'g');
    const javascript = !path.endsWith('.py') && /\.[cm]?[jt]sx?$/.test(path);
    const out = new Map<number, NamedAt>();
    for (const line of lines) {
      let best: NamedAt | undefined;
      for (const match of (rows[line - 1] ?? '').matchAll(word)) {
        const node = tree.rootNode.descendantForPosition({ row: line - 1, column: match.index });
        if (!node) {
          continue;
        }
        const kind = kindOf(node);
        const parent = node.parent;
        const found: NamedAt = {
          kind,
          member:
            !!parent &&
            ((MEMBERS.has(parent.type) && fieldOf(node) !== 'object') ||
              parent.type === 'keyword_argument' ||
              parent.type === 'pair' ||
              parent.type === 'jsx_attribute'),
        };
        if (kind === 'define' && (node.type === 'property_identifier' || parameter(node))) {
          found.parameter = true;
        }
        // A property of an object or a type is not a name in scope.
        if (kind === 'define' && parent && node.type !== 'property_identifier' && !parameter(node)) {
          let above: Node | null = parent;
          // The function a definition names is not the function around it.
          if (FUNCTIONS.has(parent.type)) {
            above = parent.parent;
          }
          while (above && !FUNCTIONS.has(above.type)) {
            above = above.parent;
          }
          if (above) {
            found.within = { from: above.startPosition.row + 1, to: above.endPosition.row + 1 };
          } else if (javascript) {
            let top: Node | null = parent;
            while (top && top.parent && top.parent.type !== 'program') {
              top = top.parent;
            }
            found.unexported = top?.type !== 'export_statement';
          }
        }
        if (!best || ORDER.indexOf(kind) < ORDER.indexOf(best.kind)) {
          best = found;
        }
      }
      out.set(line, best ?? { kind: 'text', member: false });
    }
    return out;
  } finally {
    tree.delete();
    parser.delete();
  }
}

const BLOCKS = new Set([...FUNCTIONS, 'class_definition', 'class_declaration', 'decorated_definition']);

/**
 * The rows (from 1) of the function, method or class around each of `lines`: the code a reader
 * opens to see what a line is part of. A line outside any is its own block. Undefined when the
 * file's language has no grammar here.
 */
export async function blocksAround(
  path: string,
  source: string,
  lines: readonly number[],
): Promise<Map<number, { from: number; to: number }> | undefined> {
  if (source.length > PARSE_CHARS) {
    return undefined;
  }
  const parser = await parserFor(path).catch(() => undefined);
  const tree = parser?.parse(source);
  if (!parser || !tree) {
    parser?.delete();
    return undefined;
  }
  try {
    const rows = source.split('\n');
    const out = new Map<number, { from: number; to: number }>();
    for (const line of lines) {
      const text = rows[line - 1] ?? '';
      let node: Node | null = tree.rootNode.descendantForPosition({
        row: line - 1,
        // The end of the line is inside the block a `def` or `function` line opens.
        column: Math.max(text.trimEnd().length - 1, 0),
      });
      while (node && !BLOCKS.has(node.type)) {
        node = node.parent;
      }
      // A decorated definition starts at its decorators.
      if (node?.parent?.type === 'decorated_definition') {
        node = node.parent;
      }
      out.set(
        line,
        node ? { from: node.startPosition.row + 1, to: node.endPosition.row + 1 } : { from: line, to: line },
      );
    }
    return out;
  } finally {
    tree.delete();
    parser.delete();
  }
}
