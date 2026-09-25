/**
 * Lint policy: docs/CODE-STANDARDS.md explains each rule. `npm run lint` fails on any warning.
 */
const SERVER_MODULES = ['@/server/*', '@/server/**', 'server-only']
const SIZE = { skipBlankLines: true, skipComments: true }

module.exports = {
  root: true,
  extends: ['next/core-web-vitals', 'next/typescript'],
  reportUnusedDisableDirectives: true,
  ignorePatterns: ['.next/', '.data/', 'node_modules/', 'dist/', 'public/pdf.min.mjs', 'public/pdf.worker.min.mjs', 'next-env.d.ts'],
  rules: {
    // Correctness and consistency
    eqeqeq: ['error', 'smart'],
    'no-var': 'error',
    'prefer-const': 'error',
    'object-shorthand': ['error', 'always'],
    '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    // Operations: logs go through server/logger.ts (structured JSON), configuration through server/env.ts
    'no-console': ['error', { allow: ['warn', 'error'] }],
    'no-restricted-syntax': [
      'error',
      {
        selector: "MemberExpression[object.object.name='process'][object.property.name='env'][property.name!=/^(NODE_ENV|NEXT_RUNTIME)$/]",
        message: 'Read configuration through server/env.ts (validated, cached and testable).',
      },
    ],
    // Size: small modules and functions (split by responsibility, pass an options object)
    'max-lines': ['error', { max: 500, ...SIZE }],
    'max-params': ['error', 5],
    complexity: ['error', 20],
  },
  overrides: [
    {
      // Browser code: never bundle server modules (secrets, database) into the client.
      files: ['components/**', 'hooks/**', 'lib/**'],
      rules: {
        'no-restricted-imports': ['error', { patterns: [{ group: SERVER_MODULES, message: 'Server code must not reach the browser bundle; call an API route instead.' }] }],
      },
    },
    {
      // Routes and pages stay thin: they reach data through services and repositories.
      files: ['app/**'],
      rules: {
        'no-restricted-imports': ['error', { patterns: [{ group: ['@/server/db/*'], message: 'Go through a service or repository (see docs/CODE-STANDARDS.md → Structure).' }] }],
      },
    },
    {
      // JSX conditionals count towards complexity, so components get more room than logic.
      files: ['components/**/*.tsx', 'app/**/*.tsx'],
      rules: { complexity: ['error', 30] },
    },
    {
      // Edge middleware cannot import server/env.ts; scripts and tests set up their own environment.
      files: ['middleware.ts', 'next.config.mjs', 'server/env.ts', 'scripts/**', 'tests/**'],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      files: ['scripts/**', 'server/logger.ts'],
      rules: { 'no-console': 'off' },
    },
    {
      files: ['tests/**'],
      rules: { 'max-lines': ['error', { max: 700, ...SIZE }] },
    },
    {
      // Append-only schema history: released migrations are never edited or moved.
      files: ['server/db/migrations.ts'],
      rules: { 'max-lines': 'off' },
    },
  ],
}
