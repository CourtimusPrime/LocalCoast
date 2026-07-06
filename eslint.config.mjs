import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.mjs', '**/*.cjs'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Boundary rule: core, protocol-types, mcp, page-agent, cli-wrapper must never
  // import electron. Only packages/desktop may.
  {
    files: [
      'packages/protocol-types/**/*.ts',
      'packages/core/**/*.ts',
      'packages/mcp/**/*.ts',
      'packages/page-agent/**/*.ts',
      'packages/cli-wrapper/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'Only packages/desktop may import electron. Core stays headless (AD-5/AD-9).',
            },
          ],
          patterns: ['electron/*'],
        },
      ],
    },
  },
  // Boundary rule: renderer code must not import better-sqlite3, node fs, or CDP —
  // panels read data only via core:query/command/subscribe (invariant #1).
  {
    files: ['packages/desktop/src/renderer/**/*.ts', 'packages/desktop/src/renderer/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'better-sqlite3', message: 'Renderer reads data only via Core queries.' },
            { name: 'fs', message: 'Renderer reads data only via Core queries.' },
            { name: 'node:fs', message: 'Renderer reads data only via Core queries.' },
            { name: 'electron', message: 'Renderer uses only the preload-exposed core bridge.' },
          ],
        },
      ],
    },
  },
);
