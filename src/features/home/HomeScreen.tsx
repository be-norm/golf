import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { roundRepo } from '../../db/repos'
import { holesForRound } from '../../engine/core/holes'
import { InstallHint } from '../../pwa/InstallHint'
import { PixelSprite, spriteFrames } from '../../components/PixelSprite'
import { FRAME_MS } from '../../lib/motion'
import { useAuth } from '../../auth/AuthProvider'
import { AuthSheet } from '../auth/AuthSheet'

/** Footer nav rendered as pressable pixel chips — the app's tappable idiom,
 *  so utility links read as controls instead of faint text. */
const NAV_CHIP = 'pixel-press border-stone-700 bg-stone-900/70 px-3.5 py-2 text-sm text-stone-200'

/**
 * THE APPROACH LANDS ONCE, THEN THE WIND RUNS FOREVER.
 *
 * A one-shot strip comes to rest on its last frame, which is the ball in the
 * hole — right, but it is then a photograph for as long as anyone is on this
 * screen. So the mark swaps to a looping strip of the same scene, minus the
 * ball, with the flag flapping and a gust crossing the grass.
 *
 * Looping the approach instead was the obvious thing and is wrong: a ball that
 * holes out every two seconds stops reading as a shot and starts reading as a
 * metronome. It happens when you arrive, and then the course just sits there in
 * the wind, which is what a course does.
 *
 * A one-shot travels n-1 frames, so that is what there is to wait out.
 */
const APPROACH_MS = (spriteFrames('logo') - 1) * FRAME_MS
/** Slower than the house rate: a flap, not a flutter. */
const WIND_FRAME_MS = 200

function CourseMark() {
  const [landed, setLanded] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setLanded(true), APPROACH_MS)
    return () => clearTimeout(t)
  }, [])
  return landed ? (
    <PixelSprite name="logo-idle" scale={4} frameMs={WIND_FRAME_MS} loop />
  ) : (
    <PixelSprite name="logo" scale={4} />
  )
}

export function HomeScreen() {
  const { activeUserId, isGuest, displayName } = useAuth()
  const [authOpen, setAuthOpen] = useState(false)
  const liveRound = useLiveQuery(() => roundRepo.liveRound(activeUserId), [activeUserId])
  const recent = useLiveQuery(() => roundRepo.listRecent(activeUserId, 8), [activeUserId])
  const completed = recent?.filter((r) => r.status === 'completed') ?? []

  return (
    <main className="flex min-h-dvh flex-col gap-6 py-8">
      {/* The mark, animated once on arrival: the ball finds the cup. It plays
          over the top of nothing and gates nothing — the boot splash is what
          the launch actually waits on, and holding THAT for an animation would
          tax every cold start on the first tee (MAI-36). */}
      <header className="pt-6 text-center">
        {/* FULL WIDTH, BY BLEEDING AND CROPPING rather than by stretching. It
            cannot be `width: 100%` — a fluid width is a fractional scale, and
            crisp rects at a fractional scale snap to different device-pixel
            widths across one picture. So the banner is drawn at a fixed integer
            scale wider than the column, escapes the gutter, and lets the ends
            clip on a narrow screen. Losing a little fairway off the left costs
            the picture nothing; the hole is well inside. */}
        <span className="-mx-4 block overflow-hidden">
          <span className="mx-auto block w-fit">
            <CourseMark />
          </span>
        </span>
        <h1 className="font-display mt-3 text-3xl uppercase text-felt-300 [text-shadow:4px_4px_0_rgb(0_0_0/0.6)]">
          Golf
        </h1>
        <p className="mt-2 text-lg text-felt-400">— games between friends —</p>
      </header>

      {liveRound && (
        <Link
          to={`/round/${liveRound.id}`}
          className="pixel-press block border-felt-300 bg-felt-700 p-5"
        >
          <p className="font-display text-[10px] uppercase text-coin-400">
            <span className="animate-blink">▶</span> Resume round
          </p>
          <p className="mt-2 text-2xl font-bold">{liveRound.courseSnapshot.name}</p>
          <p className="mt-1 text-lg text-felt-100">
            {liveRound.players.map((p) => p.name).join(' · ')}
          </p>
          <p className="mt-2 text-lg text-felt-200">
            {holesForRound(liveRound).length} holes ·{' '}
            {liveRound.games.length} game{liveRound.games.length === 1 ? '' : 's'}
          </p>
        </Link>
      )}

      <Link
        to="/setup"
        className="pixel-press font-display block border-felt-600 bg-felt-900/60 p-5 text-center text-xs uppercase"
      >
        {!liveRound && <span className="animate-blink mr-2 text-coin-400">▶</span>}
        New round
      </Link>

      <InstallHint />

      {completed.length > 0 && (
        <section>
          <h2 className="font-display mb-2 text-[10px] uppercase text-stone-400">Recent rounds</h2>
          <ul className="space-y-2.5">
            {completed.map((r) => (
              <li key={r.id}>
                <Link
                  to={`/round/${r.id}/settle`}
                  className="pixel block border-stone-700 bg-stone-900/70 px-4 py-3"
                >
                  <span className="text-lg font-medium">{r.courseSnapshot.name}</span>
                  <span className="ml-2 text-stone-400">
                    {new Date(r.startedAt).toLocaleDateString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="mt-auto pb-2 text-center">
        <div className="mb-3 text-sm">
          {isGuest ? (
            <button className="text-felt-400" onClick={() => setAuthOpen(true)}>
              Sign in to sync your rounds ▸
            </button>
          ) : (
            <span className="text-stone-500">
              Signed in as <span className="text-felt-300">{displayName}</span>
            </span>
          )}
        </div>
        <nav className="flex flex-wrap items-center justify-center gap-2">
          <Link to="/players" className={NAV_CHIP}>
            Players
          </Link>
          <Link to="/courses" className={NAV_CHIP}>
            Courses
          </Link>
          {/* Always shown, signed in or not. Account deletion has to be easy to
              find (App Store 5.1.1(v)), and hiding the route behind the
              signed-in state also left its guest view unreachable. */}
          <Link to="/account" className={NAV_CHIP}>
            Account
          </Link>
          <Link to="/diagnostics" aria-label="Diagnostics" className={NAV_CHIP}>
            ⚙
          </Link>
        </nav>
      </footer>

      <AuthSheet open={authOpen} onClose={() => setAuthOpen(false)} />
    </main>
  )
}
