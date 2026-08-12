import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import type { Celebration } from '../../engine/core/celebration'
import { eventHole } from '../../engine/ledger'
import { GlyphText } from '../../components/GlyphText'
import { PixelSprite, spriteGrid } from '../../components/PixelSprite'
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
 * And a fourth that is really rule 3's premise: THE APPEND MUST BE ABOUT A
 * HOLE. `eventHole` answers null for `round/completed` and `round/reopened`,
 * both of which finalize many holes at once. That is guarded explicitly rather
 * than left to a `find` missing and the fallback firing anyway.
 */

/**
 * TWO SHAPES, AND THE ENGINE PICKS (`Celebration.style`). A TOSS is a garnish
 * you read out of the corner of your eye while you carry on entering scores, so
 * it is small, fast, and thrown at the row it belongs to. A SCENE is something
 * to WATCH: one picture, centre screen, still, and slow enough to follow.
 *
 * The split is not decoration. Wolf's sprite is a little film — the wolf clubs
 * a ball at the camera over seven frames — and run at the toss's speed and size
 * it was a smear travelling across a phone, which is what the first version of
 * it was. Nothing here asks WHICH GAME is celebrating; that would be the
 * per-game branching invariant #7 forbids. It asks what shape the engine said.
 */

/** Enough coins to read as "a lot", few enough to stay a garnish. */
const MAX_SPRITES = 5
/** Integer, like every sprite scale — 4 renders on the 16px grid at 64px. */
const SPRITE_SCALE = 4
/** How far apart the coins sit at rest; they leave the bar already spread by
 *  half this, because two coins launched from one point read as one coin. */
const FAN = 22

/**
 * A SCENE IS SLOW AND BIG ON PURPOSE. At the house frame rate seven frames are
 * over in six tenths of a second, which is fine for a coin doing the same thing
 * four times and useless for a picture that changes every frame. Roughly double
 * the frame time reads as deliberate; double the sprite scale is what makes a
 * club distinguishable from a ball at arm's length.
 */
const SCENE_FRAME_MS = 170
/**
 * A scene is sized in SCREEN PIXELS and the scale is derived from whatever grid
 * the sprite is drawn on — 5 for the wolf's 32, 10 for a 16-grid one. A fixed
 * scale would have been a constant that silently means a different size per
 * sprite, which is the trap this whole diff opened by making the grid
 * per-sprite. Rounded, because the scale must stay an integer.
 */
const SCENE_PX = 160
const sceneScale = (name: Parameters<typeof spriteGrid>[0]) =>
  Math.max(1, Math.round(SCENE_PX / spriteGrid(name)))
/** Long enough to play through once (6 steps) and hold the last frame. */
const SCENE_MS = 1500

interface Playing {
  /** re-keys AnimatePresence so the same hole celebrated twice replays */
  nonce: number
  celebration: Celebration
  /** where the sprites fly; a scene doesn't fly, so it has none */
  path?: { from: { x: number; y: number }; to: { x: number; y: number } }
}

/**
 * WHAT COUNTS AS THE SAME CELEBRATION. Game, hole, sprite and WHOSE it was —
 * and pointedly not `count`.
 *
 * The winner is in because a correction can hand a decided hole to someone
 * else: enter A 3 / B 5, then fix B to a 2, and the money moves from A to B. A
 * key without the players calls that the same event and stays silent on the
 * hole changing hands, which is the opposite of quiet.
 *
 * `count` is out because Skins' carry flows forward, so re-deciding an early
 * hole re-prices every later one — hole 3 slipping from 3 skins to 2 is
 * arithmetic, not news. Put `count` in the key and every carry correction
 * shouts about holes nobody is standing on.
 */
const keyOf = (gameId: string, c: Celebration) =>
  `${gameId}:${c.hole}:${c.sprite}:${[...c.playerIds].join(',')}`

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

    // (3) THIS APPEND MUST BE ABOUT A HOLE. `eventHole` answers null for the
    // round-level events — `round/completed` and `round/reopened` — and both
    // finalize many holes at once, which is exactly when a naive layer throws
    // its biggest burst. Skins cannot reach it today (Finish is gated on a full
    // card, so completion decides nothing new), but Snake settles ON completion
    // and the award pot's unclaimed rule is defined by `ctx.completed`, so the
    // second engine on this channel would have found it. An explicit guard,
    // rather than the accident of a `find` missing and a fallback firing anyway.
    const about = newest ? eventHole(newest) : null
    if (about === null) return

    // exactly one — the hole this append was about, else the latest PLAYED.
    // Position, never hole number: a round can tee off anywhere and wrap, so
    // `12 > 3` says nothing about which came first (invariant #9). The fallback
    // is for an engine that attributes a celebration to a different hole from
    // the one just scored — Nassau pays a closed bet on `finalizedAt`.
    const positionOf = new Map(view.ctx.holesPlayed.map((h, i) => [h, i]))
    const pick =
      fresh.find(([, v]) => v.c.hole === about) ??
      fresh.reduce((best, cur) =>
        (positionOf.get(cur[1].c.hole) ?? -1) > (positionOf.get(best[1].c.hole) ?? -1) ? cur : best,
      )

    const celebration = pick[1].c
    nonceRef.current += 1
    if (celebration.style === 'scene') {
      // no rows measured, no bar: a scene plays where it is looked at
      setPlaying({ nonce: nonceRef.current, celebration })
      return
    }
    const to = anchorFor(celebration.playerIds)
    const from = barOrigin()
    setPlaying({
      nonce: nonceRef.current,
      celebration,
      path: { from, to: to ?? { ...from, y: from.y - 60 } },
    })
  }, [view])

  /**
   * THE BURST HAS TO END, and the teardown belongs here rather than inside it.
   * Hung off a callback prop it depended on a closure rebuilt on every render
   * of this component — i.e. every score tap — so the timer cleared and
   * restarted forever and the burst never unmounted. Invisible, since the coins
   * are at `opacity: 0` by then, and not harmless: each stranded burst leaves up
   * to five looping CSS animations running on a phone that has been recording
   * scores for four hours.
   *
   * `playing` changes only when a new celebration starts, so this timer is per
   * burst, which is what the old one was trying to be.
   */
  useEffect(() => {
    if (!playing) return
    const ms = playing.celebration.style === 'scene' ? SCENE_MS + 120 : 1100
    const t = setTimeout(() => setPlaying((p) => (p?.nonce === playing.nonce ? null : p)), ms)
    return () => clearTimeout(t)
  }, [playing])

  // The layer is decorative and must never eat a tap: scoring stays live for the
  // whole animation, which is the entire point of anchoring instead of taking
  // over the screen.
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[60] overflow-hidden">
      <AnimatePresence>
        {playing &&
          (playing.path ? (
            <Burst key={playing.nonce} playing={playing} path={playing.path} />
          ) : (
            <Scene key={playing.nonce} celebration={playing.celebration} />
          ))}
      </AnimatePresence>
    </div>
  )
}

/**
 * ONE PICTURE, CENTRE SCREEN, HELD STILL. Played ONCE rather than looped, so it
 * comes to rest on its final frame — for Wolf that is the ball filling the box,
 * which is the shot the whole animation is for. A loop would snap back to the
 * address position and start again, turning a punchline into a fidget.
 *
 * The scrim is faint and exists for legibility: a 160px picture over a scoring
 * grid of numbers has nothing to separate it from the numbers. It is
 * pointer-events-none like everything else here, so scoring stays live.
 *
 * BOTH THE SPRITE AND THE CAPTION ARE POSITIONED, and that is load-bearing
 * rather than tidy. The scrim is `absolute` and so paints in the positioned
 * pass, above ordinary in-flow content — so an unpositioned sprite ends up
 * UNDER the wash meant to set it off, rendered at 60% while the caption beside
 * it stays bright. The caption always carried `relative`; the picture did not.
 */
function Scene({ celebration }: { celebration: Celebration }) {
  return (
    <motion.div
      className="absolute inset-0 flex flex-col items-center justify-center gap-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, 1, 1, 0] }}
      transition={{
        duration: SCENE_MS / 1000,
        times: [0, 0.08, 0.82, 1],
        ease: stepped(4),
      }}
    >
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative">
        <PixelSprite
          name={celebration.sprite}
          scale={sceneScale(celebration.sprite)}
          frameMs={SCENE_FRAME_MS}
        />
      </div>
      <p className="font-display relative max-w-[16rem] text-center text-[10px] uppercase leading-relaxed text-coin-400 [text-shadow:2px_2px_0_rgb(0_0_0/0.8)]">
        <GlyphText text={celebration.text} />
      </p>
    </motion.div>
  )
}

function Burst({
  playing,
  path,
}: {
  playing: Playing
  path: NonNullable<Playing['path']>
}) {
  const { celebration } = playing
  const { from, to } = path
  const n = Math.min(Math.max(1, celebration.style === 'toss' ? celebration.count : 1), MAX_SPRITES)
  // the sprite's own grid, not the house 16 — a 32-grid token tossed with a
  // hardcoded half-width lands a whole sprite off the row it was aimed at
  const half = (spriteGrid(celebration.sprite) * SPRITE_SCALE) / 2
  const coins = Array.from({ length: n }, (_, i) => i)


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
            initial={{ x: from.x - half + spread / 2, y: from.y - half, opacity: 0 }}
            animate={{
              x: to.x - half + spread,
              y: to.y - half,
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
        // `times` belongs to the property whose keyframes it describes. Shared
        // at the top level it was applied to a 2-keyframe `y` AND a 4-keyframe
        // `opacity`, and the extra offsets resolve to 1 — so the label faded in
        // across the whole beat and blinked out at the last instant instead of
        // snapping in, holding and fading.
        transition={{
          duration: 0.95,
          delay: 0.3,
          ease: stepped(5),
          opacity: { times: [0, 0.2, 0.75, 1], duration: 0.95, delay: 0.3 },
        }}
      >
        <span className="inline-block w-[140px] text-center">
          <GlyphText text={celebration.text} />
        </span>
      </motion.p>
    </>
  )
}
