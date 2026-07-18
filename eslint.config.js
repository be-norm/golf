import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  { ignores: ['dist', 'dev-dist', 'coverage', 'node_modules'] },
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
    ignores: ['src/engine/**/*.test.ts'],
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
  prettier,
)
