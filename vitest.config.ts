import { defineConfig } from 'vitest/config'

export default defineConfig({
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
        test: {
          name: 'app',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx', 'src/db/**/*.test.ts'],
          setupFiles: ['./src/test/setup.ts'],
        },
      },
    ],
  },
})
