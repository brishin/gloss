import { gzipSync } from 'node:zlib';
import react from '@vitejs/plugin-react';
import { bundledLanguages } from 'shiki/langs';
import { defineConfig, type Plugin } from 'vite';

/**
 * The static export (`gloss export`): the app as one ES module with nothing to fetch, which
 * the CLI inlines into a single HTML file with a tour snapshot. Lazy chunks are inlined, and
 * `shiki/langs` (a chunk per language) is replaced by one gzipped table of every grammar.
 */
export default defineConfig({
  plugins: [react(), grammars()],
  resolve: { alias: { 'shiki/langs': new URL('./src/export/shiki-langs.ts', import.meta.url).pathname } },
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: 'dist/export',
    emptyOutDir: true,
    assetsInlineLimit: Number.POSITIVE_INFINITY,
    lib: { entry: 'src/export/main.tsx', formats: ['es'], fileName: () => 'tour.js' },
    rolldownOptions: { output: { codeSplitting: false } },
  },
});

function grammars(): Plugin {
  const id = 'virtual:gloss-grammars';
  return {
    name: 'gloss-grammars',
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    async load(resolved) {
      if (resolved !== `\0${id}`) return undefined;
      const table: Record<string, unknown> = {};
      const languages: Record<string, string[]> = {};
      for (const [lang, load] of Object.entries(bundledLanguages)) {
        const { default: list } = await load();
        languages[lang] = list.map((grammar) => grammar.name);
        for (const grammar of list) table[grammar.name] = grammar;
      }
      const packed = gzipSync(JSON.stringify(table), { level: 9 }).toString('base64');
      return `export const GRAMMARS = ${JSON.stringify(packed)};\nexport const LANGUAGES = ${JSON.stringify(languages)};`;
    },
  };
}
