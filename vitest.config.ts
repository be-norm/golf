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
          include: ['src/**/*.test.tsx', 'src/db/**/*.test.ts', 'src/remote/**/*.test.ts'],
          setupFiles: ['./src/test/setup.ts'],
        },
      },
    ],
  },
})
