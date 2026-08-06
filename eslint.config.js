import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'

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
      'no-restricted-imports': [
        'error',
        {
          patterns: [
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
          ],
        },
      ],
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
