// Shared with the upstream project: the same source is linted on both sides, so a rule that exists
// here and not there turns into a lint failure somebody has to "fix" in code they did not write.
// Rules that apply only to this repository's own files are fine.
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
