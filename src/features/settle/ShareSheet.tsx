import { useEffect, useState } from 'react'
import type { Round } from '../../engine/core/types'
import { Sheet } from '../../components/Sheet'
import { BigButton } from '../../components/BigButton'
import { paintSummaryCard } from './paintSummaryCard'
import { canShareFile, downloadFile, roundFileBase, shareFile } from './shareImage'
import type { SummaryCard } from './summaryCard'

type State =
  | { status: 'painting' }
  | { status: 'ready'; file: File; url: string }
  | { status: 'error' }

/**
 * Preview first, then share. The preview isn't decoration: it means
 * `navigator.share()` fires from a direct tap on an image that already exists.
 * Generating inside the share handler is how you lose iOS Safari's transient
 * user activation and get a sheet that silently never opens.
 */
export function ShareSheet({
  open,
  onClose,
  round,
  card,
}: {
  open: boolean
  onClose: () => void
  round: Round
  card: SummaryCard
}) {
  return (
    <Sheet open={open} onClose={onClose}>
      <h2 className="font-display mb-3 text-xs uppercase text-felt-300">Share round</h2>
      {/* Sheet only renders children while open, so this mounts fresh — and
          starts in 'painting' — on every open, with no reset effect needed. */}
      <SharePreview round={round} card={card} />
    </Sheet>
  )
}

function SharePreview({ round, card }: { round: Round; card: SummaryCard }) {
  const [state, setState] = useState<State>({ status: 'painting' })

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | undefined
    void paintSummaryCard(card)
      .then((blob) => {
        if (cancelled) return
        const file = new File([blob], `${roundFileBase(round)}.png`, { type: 'image/png' })
        objectUrl = URL.createObjectURL(file)
        setState({ status: 'ready', file, url: objectUrl })
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' })
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [card, round])

  const share = async (file: File) => {
    // a failed share still owes the user their image
    if ((await shareFile(file, `${round.courseSnapshot.name} — round summary`)) === 'failed') {
      downloadFile(file)
    }
  }

  return (
    <>
      {state.status === 'painting' && (
        <p className="py-16 text-center text-lg text-stone-400">
          <span className="animate-blink mr-2 text-coin-400">▶</span>
          Developing…
        </p>
      )}

      {state.status === 'error' && (
        <p className="py-16 text-center text-lg text-flag-500">
          Couldn't build the image on this device.
        </p>
      )}

      {state.status === 'ready' && (
        <>
          <div className="pixel max-h-[52dvh] overflow-y-auto border-stone-700 bg-felt-950">
            <img
              src={state.url}
              alt="Round summary"
              className="w-full [image-rendering:pixelated]"
            />
          </div>
          <div className="mt-4 flex gap-2">
            {canShareFile(state.file) && (
              <BigButton className="flex-1" onClick={() => void share(state.file)}>
                Share
              </BigButton>
            )}
            <BigButton
              variant="outline"
              className="flex-1"
              onClick={() => downloadFile(state.file)}
            >
              Save image
            </BigButton>
          </div>
        </>
      )}
    </>
  )
}
