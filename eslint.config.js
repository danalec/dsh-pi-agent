// ESLint flat config — the plugin's own sources plus the test suite.
//
// The rules are deliberately close to the defaults: this project is small and
// the type checker already carries most of the weight (see tsconfig.json,
// which enables `strict` plus `noUnusedLocals`/`noUnusedParameters`).
// What ESLint adds here is the style and correctness pass that the compiler
// does not do: unused promises, floating promises, unsafe `any`, and the
// plain-JS mistakes that only the test files can make.

import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      // `no-undef` is off for TypeScript: the compiler already rejects every
      // unknown identifier, and it understands type-only imports, which the
      // core rule does not.
      globals: {},
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-undef': 'off',
      // A floating promise is a lost event or a lost turn: the agent driver
      // is promise-driven, so an unhandled rejection must never be silent.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    files: ['test/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
)
