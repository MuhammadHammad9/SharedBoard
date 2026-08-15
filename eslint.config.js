import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

/**
 * ESLint flat config.
 *
 * Three rule groups here exist to enforce decisions MECHANICALLY rather than
 * by memory. A rule nobody can violate by accident is worth more than a
 * paragraph in a document nobody re-reads.
 *
 *   R-SEC-010  — no dangerouslySetInnerHTML, anywhere
 *   C-2        — Phosphor is the only icon family
 *   C-3 / C-4  — no animation library reachable from the board route
 *
 * Note: the plan named `.eslintrc.cjs`, which is the ESLint 8 format. ESLint 9
 * uses flat config, so this is `eslint.config.js` with the same rules.
 */

const BANNED_ICON_PACKAGES = [
  'lucide-react',
  '@heroicons/react',
  'react-icons',
  '@fortawesome/react-fontawesome',
  '@mui/icons-material',
  'react-feather',
]

const BANNED_ANIMATION_PACKAGES = ['framer-motion', 'motion', 'motion/react', 'gsap', '@gsap/react']

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/build/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.tsbuildinfo',
      'fixtures/**',
      'apps/server/prisma/migrations/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // R-GIT-008 item 7: no `any` without a comment explaining why. Warnings
      // are errors here (`--max-warnings 0`), so this is effectively blocking.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },

  // ── Client ────────────────────────────────────────────────────────────────
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // R-SEC-010 (Blocking): XSS vector. Never, anywhere.
      'react/no-danger': 'error',

      // C-2 / R-UI-011: one icon family. Phosphor satisfies all three design
      // skills simultaneously; Lucide loses.
      'no-restricted-imports': [
        'error',
        {
          paths: BANNED_ICON_PACKAGES.map(name => ({
            name,
            message:
              'Icons come from @phosphor-icons/react only (RULES.md conflict C-2, rule R-UI-011).',
          })),
        },
      ],
    },
  },

  // ── Board route and canvas: no animation libraries ────────────────────────
  // C-3, C-4, R-SKILL-060, R-MOTION-051/052, R-PERF-021.
  // Framer Motion is ~40 KB against a 200 KB board budget and its rAF loop
  // competes with the renderer for the main thread. GSAP is not a dependency
  // of this project at all.
  //
  // This catches DIRECT imports. scripts/check-board-chunk-imports.ts catches
  // transitive ones.
  {
    files: [
      'apps/web/src/routes/Board.tsx',
      'apps/web/src/features/canvas/**/*.{ts,tsx}',
      'apps/web/src/features/presence/**/*.{ts,tsx}',
      'apps/web/src/features/sync/**/*.{ts,tsx}',
      'apps/web/src/components/board/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...BANNED_ICON_PACKAGES.map(name => ({
              name,
              message: 'Icons come from @phosphor-icons/react only (C-2).',
            })),
            ...BANNED_ANIMATION_PACKAGES.map(name => ({
              name,
              message:
                'Banned in the board chunk. Framer Motion is marketing/dashboard only; GSAP is not a dependency. See RULES.md §2.3 conflict C-3 and rule R-PERF-021.',
            })),
          ],
        },
      ],
    },
  },

  // ── Server ────────────────────────────────────────────────────────────────
  {
    files: ['apps/server/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },

  // ── Scripts and tests ─────────────────────────────────────────────────────
  {
    files: ['scripts/**/*.ts', '**/*.test.ts', '**/*.spec.ts', '**/*.config.{ts,js}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
)
