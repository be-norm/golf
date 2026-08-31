import { useState } from 'react'
import { eventStore } from '../../db/eventStore'
import { effectiveEvents } from '../../engine/core/replay'
import { formatCentsSigned } from '../../engine/core/money'
import type { EventDraft } from '../../engine/core/events'
import { amendmentImpact } from '../../lib/roundSettings'
import { BigButton } from '../../components/BigButton'
import { selectOnFocus } from '../../components/inputs'
import type { RoundView } from './useRound'

/**
 * Fat-finger guard on a hand-typed course handicap, mirroring the bound
 * `player/handicap` carries in `eventDraftSchema` — the schema is the rule, this
 * is the input agreeing with it so a typo is corrected in front of you rather
 * than rejected on append. The ceiling sits above any real WHS course handicap
 * (a 54.0 index on a steep slope lands in the low 70s), so nothing legitimate is
 * clipped and "142" still can't get in.
 */
const clampHandicap = (n: number) => Math.max(-10, Math.min(74, Math.round(n)))

/**
 * One player's course handicap.
 *
 * The typed text is LOCAL state, and it COMMITS ON BLUR, not per keystroke. A
 * controlled input reading straight from the round (a Dexie round-trip away)
 * snaps back to the stale value between keystrokes — type "22" over 14 and you
 * get 142 — so local state owns what's on screen. And committing per keystroke
 * would persist a half-typed value: clear the box to retype and it writes 0;
 * type "10" over "18" and the stroke rows below flash the CH-1 allocation. Blur
 * settles it once: an empty/NaN entry, or one that didn't change the number,
 * reverts and writes nothing.
 */
function HandicapField({
  name,
  courseHandicap,
  disabled,
  onCommit,
}: {
  name: string
  courseHandicap: number
  disabled?: boolean
  onCommit: (ch: number) => void
}) {
  const [text, setText] = useState(String(courseHandicap))
  const commit = () => {
    const raw = text.trim()
    if (raw === '' || Number.isNaN(Number(raw))) return setText(String(courseHandicap))
    const ch = clampHandicap(Number(raw))
    setText(String(ch))
    if (ch !== courseHandicap) onCommit(ch)
  }
  return (
    <input
      type="number"
      inputMode="numeric"
      min={-10}
      max={74}
      value={text}
      disabled={disabled}
      onFocus={selectOnFocus}
      aria-label={`${name} course handicap`}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      className="min-h-11 w-20 border-2 border-stone-700 bg-stone-800 px-2 text-center text-lg text-stone-100 focus:border-felt-500 focus:outline-none disabled:opacity-50"
    />
  )
}

/**
 * THE ROUND'S COURSE HANDICAPS, editable for as long as the round is live
 * (MAI-100/102).
 *
 * These used to lock the instant the log gained ANY event, because the only way
 * to change one was to rewrite the round document — invariant #2's first-tee
 * exception — and doing that under a live log silently re-derives every settled
 * hole. They are `player/handicap` amendments now, so the lock is gone: the
 * change is stated, previewed, undoable, and carried by sync like everything
 * else in the log.
 *
 * TWO MODES, because the preview rule has to hold here as it does for a stake —
 * a handicap change re-prices every net game's settled holes:
 *
 * - NOTHING SCORED YET: commit on blur, exactly as before. There is no money to
 *   preview, so a Save step would be ceremony over nothing, and the first tee is
 *   where these are usually corrected.
 * - ANYTHING SCORED: the fields hold pending edits and one Save commits them
 *   together, under a single swing covering everyone changed. Together, because
 *   a group re-checking handicaps usually fixes more than one, and previewing
 *   them one at a time would quote a swing that the next edit invalidates.
 */
export function HandicapSection({ view, readOnly }: { view: RoundView; readOnly: boolean }) {
  const { round, events } = view
  // The same question the fold asks, over EFFECTIVE events — a retracted score
  // never happened, so the round is back on the first tee.
  const scored = effectiveEvents(events).some((e) => e.type === 'score/set')
  const [pending, setPending] = useState<Record<string, number>>({})
  const [failed, setFailed] = useState(false)

  const drafts: EventDraft[] = Object.entries(pending).map(([playerId, courseHandicap]) => ({
    type: 'player/handicap',
    playerId,
    courseHandicap,
  }))
  const impact = drafts.length > 0 ? amendmentImpact(round, events, drafts) : { swing: [], riding: [] }

  const append = (next: EventDraft[]) => {
    setFailed(false)
    void eventStore
      .append(round.id, next)
      .then(() => setPending({}))
      // `EventStore.append` validates with `eventDraftSchema.parse`, which
      // throws — without this the number would sit on screen unwritten.
      .catch(() => setFailed(true))
  }

  const commit = (playerId: string, ch: number) => {
    if (scored) return setPending((p) => ({ ...p, [playerId]: ch }))
    append([{ type: 'player/handicap', playerId, courseHandicap: ch }])
  }

  return (
    <section className="pixel border-stone-700 bg-stone-900/60 p-4">
      <h2 className="font-display text-[10px] uppercase text-stone-400">Course handicaps</h2>
      <ul className="mt-2 space-y-1.5">
        {round.players.map((p) => (
          <li key={p.playerId} className="flex items-center justify-between gap-2">
            <span className="font-medium">{p.name}</span>
            <HandicapField
              name={p.name}
              // the pending number when there is one, so the field shows what
              // you typed rather than snapping back to the saved value
              courseHandicap={pending[p.playerId] ?? p.courseHandicap}
              disabled={readOnly}
              onCommit={(ch) => commit(p.playerId, ch)}
            />
          </li>
        ))}
      </ul>

      {drafts.length > 0 && !readOnly && (
        <div className="pixel mt-3 border-coin-500/40 bg-coin-500/10 px-3 py-2.5">
          <p className="font-display text-[10px] uppercase text-coin-400">Re-prices the round</p>
          {impact.swing.length > 0 ? (
            <p className="mt-1 text-stone-300">
              {impact.swing.map((s) => `${s.name} ${formatCentsSigned(s.cents)}`).join(' · ')}
            </p>
          ) : (
            <p className="mt-1 text-stone-300">No money moves.</p>
          )}
          {impact.riding.map(({ position, changed }) => (
            <p key={position} className="mt-1 text-stone-300">
              Riding: {position}
              {!changed && <span className="text-stone-500"> · unchanged</span>}
            </p>
          ))}
        </div>
      )}

      {failed && (
        <p className="mt-2 text-sm text-flag-500">That didn’t save. Check the number and retry.</p>
      )}

      <p className="mt-2 text-xs text-stone-500">
        {readOnly
          ? 'This round is finished. Reopen it to change a handicap.'
          : scored
            ? 'Changes apply to the whole round, including holes already played.'
            : 'Tap to adjust.'}
      </p>

      {drafts.length > 0 && !readOnly && (
        <div className="mt-3 flex gap-2.5">
          <BigButton variant="outline" className="flex-1" onClick={() => setPending({})}>
            Cancel
          </BigButton>
          <BigButton className="flex-1" onClick={() => append(drafts)}>
            Save
          </BigButton>
        </div>
      )}
    </section>
  )
}
