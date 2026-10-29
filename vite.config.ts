import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: {
    experimentalSortImports: { newlinesBetween: false },
    experimentalSortPackageJson: { sortScripts: true },
    ignorePatterns: ['**/dist/', '**/.output/', '**/routeTree.gen.ts', 'pnpm-lock.yaml', 'fixtures/'],
    printWidth: 120,
    singleQuote: true,
  },
  lint: {
    ignorePatterns: ['**/dist/', '**/.output/', '**/routeTree.gen.ts', 'fixtures/'],
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/web/src/**/*.test.ts', 'apps/extension/*.test.js'],
  },
});
