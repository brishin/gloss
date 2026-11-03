import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * The static export (`gloss export`): the app as one ES module, which the CLI inlines into a
 * single HTML file with a tour snapshot. Lazy chunks are inlined, and the large leaf
 * libraries (shiki's grammars, themes and regex engine, pierre's highlighter wasm, elkjs)
 * load from jsDelivr at their installed versions, which artifact hosts allow for scripts.
 */
export default defineConfig({
  plugins: [react(), cdn()],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: 'dist/export',
    emptyOutDir: true,
    assetsInlineLimit: Number.POSITIVE_INFINITY,
    lib: { entry: 'src/export/main.tsx', formats: ['es'], fileName: () => 'tour.js' },
    rolldownOptions: { output: { codeSplitting: false, minify: true } },
  },
});

const CDN = 'https://cdn.jsdelivr.net/npm';

/** Imports served from the CDN instead of the bundle; `esm` asks jsDelivr to wrap a CommonJS file. */
const FROM_CDN: { test: (source: string, importer: string) => boolean; esm?: boolean }[] = [
  { test: (source) => /^@shikijs\/(langs|themes)\/[\w.-]+$/.test(source) },
  { test: (source) => source === '@shikijs/engine-oniguruma/wasm-inlined' },
  { test: (source, importer) => source === './highlights.wasm.mjs' && importer.includes('@pierre/highlights') },
  { test: (source) => source.startsWith('elkjs'), esm: true },
];

function cdn(): Plugin {
  return {
    name: 'gloss-cdn',
    enforce: 'pre',
    async resolveId(source, importer) {
      const rule = importer ? FROM_CDN.find((candidate) => candidate.test(source, importer)) : undefined;
      if (!rule) return undefined;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (!resolved) return undefined;
      const { name, version, root } = owningPackage(resolved.id);
      const path = relative(root, resolved.id.split('?')[0]!).split('\\').join('/');
      return { id: `${CDN}/${name}@${version}/${path}${rule.esm ? '/+esm' : ''}`, external: true };
    },
  };
}

/** The package a resolved file belongs to: the nearest package.json with a name. */
function owningPackage(file: string): { name: string; version: string; root: string } {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      const { name, version } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string };
      if (name && version) return { name, version, root: dir };
    }
  }
  throw new Error(`No package for ${file}`);
}
