import { Sheet } from '../../components/Sheet'
import { getEngine } from '../../engine/catalog'
import '../../engine/games'

interface Props {
  /** engine type to show rules for; undefined renders nothing */
  type: string | undefined
  onClose: () => void
}

/** Generic rules viewer — content comes from each engine's meta.rules. */
export function RulesSheet({ type, onClose }: Props) {
  const engine = type ? getEngine(type) : undefined
  return (
    <Sheet open={!!engine} onClose={onClose}>
      {engine && (
        <div className="space-y-5 pb-2">
          <header>
            <h2 className="font-display text-sm uppercase text-felt-300">
              {engine.meta.name} — rules
            </h2>
            <p className="mt-2 text-xl text-stone-200">{engine.meta.rules.tagline}</p>
          </header>

          <RuleSection title="How to play" items={engine.meta.rules.howToPlay} />
          <RuleSection title="Scoring & money" items={engine.meta.rules.scoring} />

          <section>
            <h3 className="font-display mb-2 text-[10px] uppercase text-stone-400">Key terms</h3>
            <dl className="space-y-2">
              {engine.meta.rules.terms.map((t) => (
                <div key={t.term} className="pixel border-stone-700 bg-stone-800/60 px-3 py-2">
                  <dt className="font-display text-[10px] uppercase text-coin-400">{t.term}</dt>
                  <dd className="mt-1 text-lg leading-snug text-stone-200">{t.def}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      )}
    </Sheet>
  )
}

function RuleSection({ title, items }: { title: string; items: string[] }) {
  return (
    <section>
      <h3 className="font-display mb-2 text-[10px] uppercase text-stone-400">{title}</h3>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item} className="flex gap-2 text-lg leading-snug text-stone-200">
            <span aria-hidden className="text-felt-400">
              ▶
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
