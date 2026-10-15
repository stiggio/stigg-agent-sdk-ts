// Kept aligned with `eslint.config.mjs` in the internal monorepo (stiggio/stigg-sdk): the same
// source is linted on both sides, so a rule that exists here and not there turns every sync into a
// lint failure somebody has to "fix" in mirrored code. Repository-only rules are allowed, as long
// as they apply to paths that are not mirrored - see `.sync-manifest.json`.
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierPlugin from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
  {
    // The config files at the root are JavaScript, outside every tsconfig, and not what this
    // repository ships. TypeScript is the only linted language here, as internally.
    ignores: ['**/dist/', '**/node_modules/', '.yarn/', '**/coverage/', '**/.pack/', '**/*.mjs', '**/*.cjs', '**/*.js'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierPlugin,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
);
