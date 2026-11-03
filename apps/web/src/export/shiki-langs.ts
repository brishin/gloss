// Stands in for `shiki/langs` in the export build (see vite.export.config.ts). Every grammar
// ships in the page once, gzipped, and is inflated the first time a diff needs a language,
// so the page highlights any language without fetching anything.
import { GRAMMARS, LANGUAGES } from 'virtual:gloss-grammars';
import { inflateJson } from './gzip.ts';

let table: Promise<Record<string, unknown>> | undefined;

export const bundledLanguages: Record<string, () => Promise<{ default: unknown[] }>> = Object.fromEntries(
  Object.entries(LANGUAGES).map(([lang, names]) => [
    lang,
    async () => {
      const grammars = await (table ??= inflateJson<Record<string, unknown>>(GRAMMARS));
      return { default: names.map((name) => grammars[name]) };
    },
  ]),
);
