/**
 * Build once, on first use.
 *
 * For work that is expensive, module-scope and NOT wanted on the critical path
 * of a cold start — sprite frame strips, chiefly. `routes.tsx` imports every
 * screen and every screen imports `PixelSprite`, so anything a sprite module
 * evaluates eagerly is paid before first paint whether or not it is ever shown.
 */
export function once<T>(build: () => T): () => T {
  let made: T | undefined
  return () => (made ??= build())
}
