import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

const root = process.cwd()
const srcLib = resolve(root, 'src/lib')

export default defineConfig({
  resolve: {
    alias: [
      // Absolute paths so aliases work from both tests/ and src/ contexts
      { find: /^\.\.\/lib\/(.+?)\.js$/, replacement: `${srcLib}/$1.ts` },
      { find: /^\.\.\/background\.js$/, replacement: resolve(root, 'src/background/index.ts') },
      // Intra-src relative imports: ./foo.js → ./foo.ts
      { find: /^(\.\/.+?)\.js$/, replacement: '$1.ts' },
    ],
  },
  test: {
    include: ['tests/**/*.test.{js,ts}'],
    exclude: ['tests/e2e/**'],
    environment: 'jsdom',
    setupFiles: ['tests/setup.js'],
    globals: false,
  },
})
