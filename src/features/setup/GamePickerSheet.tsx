import { useMemo, useState } from 'react'
import {
  listEngines,
  type GameEngine,
  type GameFamily,
  type GameShape,
} from '../../engine/catalog'
import { Sheet } from '../../components/Sheet'
import { isPlayable, playerCountNote } from './ConfigField'

/**
 * Typed as a total record on purpose: adding a `GameFamily` without a heading
 * would otherwise ship a blank group header in a sheet of 25 games, and only
 * be noticed by looking at it. Same for shapes.
 */
const FAMILY_LABEL: Record<GameFamily, string> = {
  match: 'Match play',
  stroke: 'Stroke play',
  points: 'Points',
  pot: 'Pots & carryovers',
  award: 'Awards',
  wager: 'Wagers',
}

const SHAPE_LABEL: Record<GameShape, string> = {
  solo: 'Every man for himself',
  headToHead: 'One against one',
  teams: 'Fixed teams',
  partners: 'Partners that change',
}

const FAMILY_ORDER = Object.keys(FAMILY_LABEL) as GameFamily[]
const SHAPE_ORDER = Object.keys(SHAPE_LABEL) as GameShape[]

type GroupBy = 'family' | 'shape'

interface Props {
  open: boolean
  /** which section the "+" was tapped in — decides what's eligible */
  section: 'main' | 'side'
  playerCount: number
  /** how many of each type are already chosen, so a row can say so */
  chosenCounts: Map<string, number>
  onPick: (engine: GameEngine) => void
  onClose: () => void
}

export function GamePickerSheet({
  open,
  section,
  playerCount,
  chosenCounts,
  onPick,
  onClose,
}: Props) {
  const [groupBy, setGroupBy] = useState<GroupBy>('family')
  const [query, setQuery] = useState('')

  // `meta.category` is ELIGIBILITY — 'either' games (Skins) offer in both
  // sections, and which one they end up in is `roleOf`'s answer, not this
  // sheet's. Presentation only, either way: nothing here reaches a settlement.
  const eligible = useMemo(
    () =>
      listEngines().filter(
        (e) => e.meta.category === section || e.meta.category === 'either',
      ),
    [section],
  )

  const q = query.trim().toLowerCase()
  const matching = q
    ? eligible.filter(
        (e) =>
          e.meta.name.toLowerCase().includes(q) || e.meta.blurb.toLowerCase().includes(q),
      )
    : eligible

  // The shape view answers "what could this group play right now", so it
  // intersects with the roster: three players see Nassau's 2v1 and no Vegas.
  // The family view keeps unplayable games visible-but-dimmed, with the reason,
  // because "Vegas needs 4" is worth knowing when you might call a fourth.
  const rosterFiltered =
    groupBy === 'shape' ? matching.filter((e) => isPlayable(e, playerCount)) : matching
  const hiddenByRoster = matching.length - rosterFiltered.length

  const groups: { key: string; label: string; engines: GameEngine[] }[] =
    groupBy === 'family'
      ? FAMILY_ORDER.map((f) => ({
          key: f,
          label: FAMILY_LABEL[f],
          engines: rosterFiltered.filter((e) => e.meta.family === f),
        })).filter((g) => g.engines.length > 0)
      : SHAPE_ORDER.map((s) => ({
          key: s,
          label: SHAPE_LABEL[s],
          // A game appears under EVERY shape it supports — Nassau is genuinely
          // both 1v1 and 2v2, which is why `shapes` is a set and why this axis
          // could not be `family`.
          engines: rosterFiltered.filter((e) => e.meta.shapes.includes(s)),
        })).filter((g) => g.engines.length > 0)

  return (
    <Sheet open={open} onClose={onClose}>
      {/* Named region: the chosen games below carry the same names as the rows
          in here, so this is what lets a reader (and a test) tell "Skins, on
          offer" from "Skins, already added". */}
      <section aria-label="Game picker" className="space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-xs uppercase text-felt-300">
            {section === 'main' ? 'Choose a game' : 'Add a side bet'}
          </h2>
          <button onClick={onClose} className="font-display text-[10px] uppercase text-stone-400">
            Close
          </button>
        </div>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search games…"
          aria-label="search games"
          className="min-h-12 w-full rounded-xl bg-stone-950 px-4 ring-1 ring-stone-700 placeholder:text-stone-500 focus:outline-none focus:ring-felt-500"
        />

        <div className="flex gap-2">
          {(['family', 'shape'] as const).map((g) => (
            <button
              key={g}
              onClick={() => setGroupBy(g)}
              className={`font-display px-3 py-2 text-[10px] uppercase ${
                groupBy === g
                  ? 'pixel border-felt-300 bg-felt-700'
                  : 'border-2 border-stone-700 bg-stone-800 text-stone-400'
              }`}
            >
              {g === 'family' ? 'By type of bet' : 'By who plays whom'}
            </button>
          ))}
        </div>

        {groups.length === 0 && (
          <p className="py-6 text-center text-stone-500">
            {q ? `Nothing matches “${query}”.` : 'No games available for this group size.'}
          </p>
        )}

        {groups.map((group) => (
          <div key={group.key}>
            <h3 className="font-display mb-2 text-[10px] uppercase text-stone-400">
              {group.label}
            </h3>
            <div className="space-y-2">
              {group.engines.map((engine) => {
                const playable = isPlayable(engine, playerCount)
                const chosen = chosenCounts.get(engine.type) ?? 0
                return (
                  <button
                    key={engine.type}
                    // NOT disabled when already chosen: two instances of one
                    // game is the point of this screen (gross skins beside net
                    // skins). Only an unplayable roster blocks the tap.
                    disabled={!playable}
                    onClick={() => onPick(engine)}
                    className={`pixel flex w-full items-start justify-between gap-3 border-stone-700 bg-stone-900/70 px-3.5 py-3 text-left ${
                      playable ? '' : 'opacity-40'
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="font-semibold">{engine.meta.name}</span>
                      <span className="block text-sm text-stone-400">
                        {playable ? engine.meta.blurb : playerCountNote(engine)}
                      </span>
                    </span>
                    {chosen > 0 && (
                      <span className="shrink-0 text-xs text-felt-300">
                        ✓ {chosen} added
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        ))}

        {/* Hidden is not the same as absent: say what the roster filtered out,
            so a foursome-only game doesn't look like it was never built. */}
        {groupBy === 'shape' && hiddenByRoster > 0 && (
          <p className="text-center text-xs text-stone-500">
            …and {hiddenByRoster} more that need a different group size.
          </p>
        )}
      </section>
    </Sheet>
  )
}
