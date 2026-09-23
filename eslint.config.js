/**
 * Lint config, flat format (ESLint 9).
 *
 * Kept intentionally small. Lint here exists to catch mistakes, not to argue
 * about style — formatting is not a review conversation worth having, and every
 * rule added is a rule someone has to work around at 5pm.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.run/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Unused code is dead weight, but an underscore prefix is a real signal
      // that something is intentionally ignored.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Explicit `any` defeats the point of the type layer.
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      // Tests construct deliberately malformed values to prove the validator
      // rejects them; that necessarily involves unsafe casts.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Build and deploy scripts run on bare Node, so the Node globals have to be
    // declared. The TypeScript sources get them from @types/node instead.
    files: ['**/*.mjs', 'scripts/**/*.js'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
);
