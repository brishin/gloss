import type { Category, FileChange, FileSummary, ProvisionalGroup } from '@gloss/protocol';
import { SYNTHETIC_GROUPS } from '@gloss/protocol';
import { isAgentGuidance, isDocumentation } from './guidance.ts';

/** Generated-looking paths. A hint for the instant first view only: Jev decides for real. */
const GENERATED_RE =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|go\.sum|composer\.lock|Podfile\.lock)$|(^|\/)(__generated__|generated|dist|vendor)\/|\.(min\.(js|css)|map|snap|pb\.go|g\.dart)$|[._-]generated\.|\.gen\.[a-z]+$/i;
const TEST_RE =
  /(^|\/)(__tests__|__mocks__|__fixtures__|tests?|spec|fixtures|e2e|testdata)\/|\.(test|spec|stories|e2e)\.[a-z0-9]+$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|Tests?\.(swift|kt|java|cs)$/i;
const CONFIG_RE =
  /(^|\/)(\.github|\.circleci|\.vscode|\.husky)\/|(^|\/)\.[^/]+$|(^|\/)(Dockerfile|docker-compose\.ya?ml|Makefile|tsconfig[^/]*\.json|vite\.config\.[a-z]+|eslint\.config\.[a-z]+)$/i;
const MANIFEST_RE =
  /(^|\/)(package\.json|Cargo\.toml|go\.mod|pyproject\.toml|requirements[^/]*\.txt|Gemfile|Package\.swift)$/;

export function looksGenerated(path: string): boolean {
  return GENERATED_RE.test(path);
}

export function looksLikeTest(path: string): boolean {
  return TEST_RE.test(path);
}

const CONTAINERS = new Set([
  'packages',
  'apps',
  'libs',
  'services',
  'crates',
  'modules',
  'plugins',
  'src',
  'lib',
  'internal',
  'cmd',
  'pkg',
]);

/** A file's "area": `packages/foo`, `src/api`, or its top directory. */
function area(path: string): string {
  const parts = path.split('/');
  if (parts.length === 1) {
    return '(root)';
  }
  if (CONTAINERS.has(parts[0]!) && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0]!;
}

function guessCategory(key: string): Category {
  if (/(^|\/)(ui|web|app|components?|views?|pages|styles?|frontend)(\/|$)/i.test(key)) {
    return 'ui';
  }
  if (/(^|\/)(api|server|routes?|handlers?|backend)(\/|$)/i.test(key)) {
    return 'api';
  }
  if (/(^|\/)(db|migrations?|models?|schema|storage)(\/|$)/i.test(key)) {
    return 'data';
  }
  if (/(^|\/)(cli|bin|cmd)(\/|$)/i.test(key)) {
    return 'cli';
  }
  if (/(^|\/)(scripts?|tools?)(\/|$)/i.test(key)) {
    return 'scripts';
  }
  return 'core';
}

/**
 * The instant, no-model grouping shown while the real tour streams in: docs and agent
 * guidance first, generated, tests and config split out, everything else by area. Never cached as model output.
 */
export function provisionalGroups(files: readonly (FileChange | FileSummary)[]): ProvisionalGroup[] {
  const buckets = new Map<string, ProvisionalGroup>();
  const add = (key: string, make: () => Omit<ProvisionalGroup, 'fileIds'>, fileId: string) => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { ...make(), fileIds: [] };
      buckets.set(key, bucket);
    }
    bucket.fileIds.push(fileId);
  };
  for (const file of files) {
    if (file.generated || looksGenerated(file.path)) {
      add('generated', () => SYNTHETIC_GROUPS.generated, file.id);
    } else if (looksLikeTest(file.path)) {
      add('tests', () => SYNTHETIC_GROUPS.tests, file.id);
    } else if (isAgentGuidance(file.path) || isDocumentation(file.path)) {
      add('guidance', () => SYNTHETIC_GROUPS.guidance, file.id);
    } else if (CONFIG_RE.test(file.path) || MANIFEST_RE.test(file.path)) {
      add('config', () => ({ key: 'config', label: 'Config & build', summary: '', category: 'config' }), file.id);
    } else {
      const key = area(file.path);
      add(
        `area:${key}`,
        () => ({ key: `area:${key}`, label: key, summary: '', category: guessCategory(key) }),
        file.id,
      );
    }
  }
  // Docs and agent guidance lead, as in the final tour; mechanical groups trail.
  const order = ['guidance', 'config', 'tests', 'generated'];
  return [...buckets.values()].toSorted((a, b) => {
    // Area groups (not in `order`) sit between guidance and the mechanical groups.
    const rank = (group: ProvisionalGroup) => (order.indexOf(group.key) + 1 || 1.5) - 1;
    return rank(a) - rank(b) || b.fileIds.length - a.fileIds.length;
  });
}
