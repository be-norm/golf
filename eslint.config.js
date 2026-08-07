import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'

/**
 * Invariant #1's denylist, hoisted because TWO config blocks need it.
 *
 * ESLint flat config REPLACES a rule's options when a later block redefines it
 * — it does not merge them. A second block setting `no-restricted-imports` for
 * a subset of these files therefore switches this list OFF for that subset,
 * silently, with a green lint. That is exactly what happened when the registry
 * ban below was first added as its own block: engine purity stopped being
 * enforced for every game engine, and only a review caught it. Both blocks now
 * spread this array.
 */
const ENGINE_PURITY_PATTERNS = [
  {
    group: ['react', 'react-*', 'motion', 'motion/*'],
    message: 'engine must stay React/UI-free',
  },
  {
    group: ['dexie', 'dexie-*', '@supabase/*'],
    message: 'engine must stay persistence/network-free',
  },
  {
    group: ['**/db/*', '**/features/*', '**/components/*', '**/pwa/*', '**/remote/*', '**/app/*'],
    message: 'engine cannot import from app layers',
  },
]

export default tseslint.config(
  // supabase/functions/** is Deno (its own runtime + globals), linted by the
  // Supabase/Deno toolchain, not by the Vite app's TS/React ESLint config.
  { ignores: ['dist', 'dev-dist', 'coverage', 'node_modules', 'supabase/functions/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // Engine purity boundary: src/engine/** is pure TypeScript.
    // Only relative imports within engine plus zod are allowed.
    files: ['src/engine/**/*.ts'],
    // src/engine/test/** is the test layer living inside the engine tree: the
    // harness and the fast-check arbitraries. It is EXEMPT, explicitly — the
    // arbitraries import fast-check, a devDependency, which today's denylist
    // happens not to name. Better a stated exemption than a purity boundary
    // that looks enforced and isn't. Nothing under src/** non-test imports it.
    ignores: ['src/engine/**/*.test.ts', 'src/engine/test/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ENGINE_PURITY_PATTERNS }],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'engine must stay DOM-free' },
        { name: 'document', message: 'engine must stay DOM-free' },
        { name: 'navigator', message: 'engine must stay DOM-free' },
        { name: 'localStorage', message: 'engine must stay DOM-free' },
        { name: 'indexedDB', message: 'engine must stay DOM-free' },
        { name: 'fetch', message: 'engine must stay network-free' },
      ],
    },
  },
  {
    // MAI-43, invariant #7: taxonomy is presentation, and an engine must not
    // settle money by it. `role` is guarded by a test (catalog.test.ts derives
    // every engine three ways), but `meta.category`/`family`/`shapes` live on
    // the engine singleton, so no fixture can vary them. An engine can only
    // reach its own meta through the registry, and none does — so banning the
    // registry inside game engines turns "we reviewed it" into a build error.
    files: ['src/engine/games/**/*.ts'],
    ignores: ['src/engine/games/**/*.test.ts'],
    rules: {
      // NOTE the spread: this block replaces invariant #1's options for these
      // files, so it has to carry them.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...ENGINE_PURITY_PATTERNS,
            {
              // by PATTERN, not a single '../../catalog' literal: an engine one
              // directory deeper would spell it '../../../catalog' and escape
              group: ['**/catalog'],
              importNames: ['getEngine', 'listEngines'],
              message:
                'an engine must not read the registry — taxonomy (meta.category/family/shapes) is presentation and must never reach a settlement (CLAUDE.md invariant #7)',
            },
          ],
        },
      ],
    },
  },
  {
    // MAI-76: saved-course membership has ONE write path. CourseRepo pairs
    // every `saved_courses` write with its outbox push in a single transaction;
    // reaching for db.saved_courses directly is exactly how the feature
    // silently stopped syncing twice. Tests may seed state directly.
    files: ['src/**/*.{ts,tsx}'],
    // schema declares the table; repos is the write path; wipe/seed are the
    // account-wipe and legacy-cleanup exceptions documented in each file
    ignores: [
      'src/db/schema.ts',
      'src/db/repos.ts',
      'src/db/wipe.ts',
      'src/db/seed.ts',
      'src/**/*.test.{ts,tsx}',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='saved_courses']",
          message:
            'saved_courses is written only through CourseRepo (src/db/repos.ts) — membership and its sync push must stay atomic (MAI-76)',
        },
      ],
    },
  },
  prettier,
)
