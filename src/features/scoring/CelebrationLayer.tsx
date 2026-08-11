import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import type { Celebration } from '../../engine/core/celebration'
import { eventHole } from '../../engine/ledger'
import { GlyphText } from '../../components/GlyphText'
import { PixelSprite } from '../../components/PixelSprite'
import { stepped } from '../../lib/motion'
import type { RoundView } from './useRound'

/**
 * THE CELEBRATION LAYER — plays a game's own sprite when a hole decides.
 *
 * Everything hard here is about firing ONCE, at the right moment, for the right
 * hole. `deriveRound` recomputes wholesale on every write, so every
 * `GameDerivation` is a new object on every render and NOTHING in it is
 * flavoured with newness: `celebration(7)` answers the same on the tap that
 * decided hole 7, on the next putt entered, on a revisit a week later, and on
 * the remount `key={activeUserId}` forces at sign-in. Newness has to be
 * computed here, against the event log, or the animation is noise.
 *
 * Three rules, each of which was a bug first:
 *
 * 1. SEED ON THE FIRST RENDER THAT HAS A VIEW — not on mount. `useRound`
 *    returns `undefined` while Dexie loads, so a mount-keyed seed records
 *    nothing and then treats the whole first real derivation as new, replaying
 *    every decided hole of a resumed round at once. That is the exact failure
 *    the seed exists to stop, arrived at by a different road.
 * 2. AN UNDO IS NOT A WIN. Retraction moves money BACKWARDS and grows the log
 *    like anything else, so the newest raw event being a `meta/retract` is the
 *    guard. (Keys the derivation stops reporting are dropped, so undo-then-redo
 *    celebrates again — which is right, it happened again.)
 * 3. AT MOST ONE PER APPEND. One append can produce several celebrations —
 *    a round holding two games decides them both off the same scores (MAI-44
 *    allows two instances of one game, and a $1 skin beside a $20 one is why).
 *    Uncapped they fire on top of each other, from the same bar to the same
 *    row. The cap is structural — ONE `Playing` slot, not a queue — because a
 *    queue turns a four-ball's hole into a train of animations to sit through.
 *
 *    Which one, when there are several: the hole the append was actually ABOUT
 *    (`eventHole`, the same function `buildHoleLedger` places events by), else
 *    whichever is latest BY POSITION in `ctx.holesPlayed`. Position, never hole
 *    number — a round can tee off anywhere and wrap, so `12 > 3` says nothing
 *    about which came first (invariant #9). The rest are marked seen silently:
 *    caught up, not queued.
 *
 * WHAT THE KEY DOES, which is easy to mistake for rule 3's job: a Skins carry
 * cascades, so correcting hole 1 re-derives every later hole — but what changes
 * downstream is the COUNT, never which holes were won. Hole 3 goes from "wins
 * 3 skins" to "wins 2" under an unchanged (game, hole, sprite) key, so it
 * silently re-prices instead of re-firing, and only the corrected hole is new.
 * Widen the key to include the count and every carry correction becomes news.
 *
 * `eventHole` returning null for `round/completed` and `round/reopened` falls
 * out of rule 3 for free — both finalize many holes at once, and neither should
 * throw coins.
 */

/** Enough coins to read as "a lot", few enough to stay a garnish. */
const MAX_SPRITES = 5
/** Integer, like every sprite scale — 4 renders on the 16px grid at 64px. */
const SPRITE_SCALE = 4
const HALF = (16 * SPRITE_SCALE) / 2
/** How far apart the coins sit at rest; they leave the bar already spread by
 *  half this, because two coins launched from one point read as one coin. */
const FAN = 22

interface Playing {
  /** re-keys AnimatePresence so the same hole celebrated twice replays */
  nonce: number
  celebration: Celebration
  from: { x: number; y: number }
  to: { x: number; y: number }
}

const keyOf = (gameId: string, c: Celebration) => `${gameId}:${c.hole}:${c.sprite}`

/** Every celebration the round currently reports, keyed. Cheap: each engine's
 *  implementation is a lookup in results it already computed. */
function currentCelebrations(view: RoundView): Map<string, { gameId: string; c: Celebration }> {
  const out = new Map<string, { gameId: string; c: Celebration }>()
  for (const game of view.round.games) {
    const d = view.derivations.get(game.gameId)
    if (!d?.celebration) continue
    for (const hole of view.ctx.holesPlayed) {
      const c = d.celebration(hole)
      if (c) out.set(keyOf(game.gameId, c), { gameId: game.gameId, c })
    }
  }
  return out
}

/** Where the coins land: the winner's score row if it's on screen, else the bar
 *  they came from — a celebration must never depend on a row being mounted. */
function anchorFor(playerIds: readonly string[]): { x: number; y: number } | null {
  for (const id of playerIds) {
    const el = document.querySelector(`[data-player-row="${id}"]`)
    if (el) {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 }
    }
  }
  return null
}

function barOrigin(): { x: number; y: number } {
  const el = document.querySelector('[data-summary-bar]')
  if (el) {
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width * 0.5, y: r.top }
  }
  return { x: window.innerWidth * 0.5, y: window.innerHeight - 80 }
}

export function CelebrationLayer({ view }: { view: RoundView | undefined | null }) {
  const seenRef = useRef<Set<string> | null>(null)
  const lastLenRef = useRef(0)
  const nonceRef = useRef(0)
  const [playing, setPlaying] = useState<Playing | null>(null)

  useEffect(() => {
    if (!view) return
    const current = currentCelebrations(view)
    const currentKeys = new Set(current.keys())

    // (1) first render WITH data — record where we came in and show nothing
    if (seenRef.current === null) {
      seenRef.current = currentKeys
      lastLenRef.current = view.events.length
      return
    }

    const grew = view.events.length > lastLenRef.current
    const newest = view.events[view.events.length - 1]
    lastLenRef.current = view.events.length

    const fresh = [...current.entries()].filter(([k]) => !seenRef.current!.has(k))
    seenRef.current = currentKeys
    if (!grew || fresh.length === 0) return
    // (2) an undo is not a win
    if (newest?.type === 'meta/retract') return

    // (3) exactly one — the hole this append was about, else the latest played
    const about = newest ? eventHole(newest) : null
    const positionOf = new Map(view.ctx.holesPlayed.map((h, i) => [h, i]))
    const pick =
      fresh.find(([, v]) => v.c.hole === about) ??
      fresh.reduce((best, cur) =>
        (positionOf.get(cur[1].c.hole) ?? -1) > (positionOf.get(best[1].c.hole) ?? -1) ? cur : best,
      )

    const celebration = pick[1].c
    const to = anchorFor(celebration.playerIds)
    const from = barOrigin()
    nonceRef.current += 1
    setPlaying({ nonce: nonceRef.current, celebration, from, to: to ?? { ...from, y: from.y - 60 } })
  }, [view])

  // The layer is decorative and must never eat a tap: scoring stays live for the
  // whole animation, which is the entire point of anchoring instead of taking
  // over the screen.
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[60] overflow-hidden">
      <AnimatePresence>
        {playing && (
          <Burst
            key={playing.nonce}
            playing={playing}
            onDone={() => setPlaying((p) => (p?.nonce === playing.nonce ? null : p))}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

function Burst({ playing, onDone }: { playing: Playing; onDone: () => void }) {
  const { celebration, from, to } = playing
  const n = Math.min(Math.max(1, celebration.count), MAX_SPRITES)
  const coins = Array.from({ length: n }, (_, i) => i)

  useEffect(() => {
    const t = setTimeout(onDone, 1100)
    return () => clearTimeout(t)
  }, [onDone])

  return (
    <>
      {coins.map((i) => {
        // centred on the group, so three coins straddle the row rather than
        // trailing off to one side of it
        const spread = (i - (n - 1) / 2) * FAN
        return (
          <motion.div
            key={i}
            className="absolute"
            style={{ left: 0, top: 0 }}
            initial={{ x: from.x - HALF + spread / 2, y: from.y - HALF, opacity: 0 }}
            animate={{
              x: to.x - HALF + spread,
              y: to.y - HALF,
              opacity: [0, 1, 1, 0],
            }}
            transition={{
              duration: 0.62,
              delay: i * 0.07,
              ease: stepped(7),
              opacity: { times: [0, 0.15, 0.8, 1], duration: 0.62, delay: i * 0.07 },
            }}
          >
            <PixelSprite name={celebration.sprite} scale={SPRITE_SCALE} loop />
          </motion.div>
        )
      })}
      <motion.p
        className="font-display absolute text-[10px] uppercase text-coin-400 [text-shadow:2px_2px_0_rgb(0_0_0/0.8)]"
        style={{ left: 0, top: 0 }}
        initial={{ x: to.x - 70, y: to.y - 4, opacity: 0 }}
        animate={{ y: [to.y - 4, to.y - 30], opacity: [0, 1, 1, 0] }}
        transition={{ duration: 0.95, delay: 0.3, ease: stepped(5), times: [0, 1] }}
      >
        <span className="inline-block w-[140px] text-center">
          <GlyphText text={celebration.text} />
        </span>
      </motion.p>
    </>
  )
}
