import { describe, expect, it } from 'vitest'
import './games/index'
import { listEngines } from './catalog'

describe('engine registry invariants', () => {
  it('every game ships complete player-facing rules', () => {
    const engines = listEngines()
    expect(engines.length).toBeGreaterThanOrEqual(4)
    for (const engine of engines) {
      const { rules } = engine.meta
      expect(rules.tagline.length, `${engine.type} tagline`).toBeGreaterThan(0)
      expect(rules.howToPlay.length, `${engine.type} howToPlay`).toBeGreaterThan(0)
      expect(rules.scoring.length, `${engine.type} scoring`).toBeGreaterThan(0)
      expect(rules.terms.length, `${engine.type} terms`).toBeGreaterThan(0)
      for (const t of rules.terms) {
        expect(t.term.length, `${engine.type} term name`).toBeGreaterThan(0)
        expect(t.def.length, `${engine.type} "${t.term}" definition`).toBeGreaterThan(0)
      }
    }
  })
})
