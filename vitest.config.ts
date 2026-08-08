import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify('test'),
  },
  test: {
    projects: [
      {
        test: {
          name: 'engine',
          environment: 'node',
          include: ['src/engine/**/*.test.ts'],
        },
      },
      {
        resolve: {
          alias: {
            'virtual:pwa-register/react': new URL('./src/test/pwa-register-stub.ts', import.meta.url)
              .pathname,
          },
        },
        test: {
          name: 'app',
          environment: 'jsdom',
          // Enumerated rather than `src/**/*.test.ts`, so the engine project
          // keeps sole ownership of `src/engine/**`. Which means a new
          // top-level directory has to be added here or its tests run in
          // NEITHER project — silently, with a green suite. `src/lib` was in
          // exactly that state until gameRoles.ts arrived.
          include: [
            'src/**/*.test.tsx',
            'src/db/**/*.test.ts',
            'src/features/**/*.test.ts',
            'src/lib/**/*.test.ts',
            'src/remote/**/*.test.ts',
          ],
          setupFiles: ['./src/test/setup.ts'],
        },
      },
    ],
  },
})
