import js from '@eslint/js';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import globals from 'globals';

const configFileName = basename(fileURLToPath(import.meta.url));

export default [
  {
    name: `${configFileName}/ignores`,
    ignores: [
      'coverage/**',
      'node_modules/**',
      '.planning/**',
      '.worktrees/**',
    ],
  },
  js.configs.recommended,
  {
    name: `${configFileName}/node`,
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.node,
      sourceType: 'module',
    },
  },
  {
    name: `${configFileName}/tests`,
    files: ['tests/**/*.test.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
];
