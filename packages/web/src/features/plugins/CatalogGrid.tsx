// A titled group of catalog cards, two columns wide from `sm` up (roadmap-6 B1).
import type { ReactNode } from 'react'
import type { Entry } from './catalog'
import { PluginCard } from './PluginCard'

export interface CardActions {
  open: (e: Entry) => void
  add: (e: Entry) => void
  /** The entry being added, by key. */
  adding: string | null
  menu: (e: Entry) => ReactNode
}

export function CatalogSection({ title, count, description, children }: { title: string; count?: number; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-8 last:mb-0">
      <div className="mb-3">
        <h2 className="flex items-baseline gap-2 text-sm font-semibold">
          {title}
          {count !== undefined && <span className="font-normal text-muted-foreground tabular-nums">{count}</span>}
        </h2>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  )
}

export function CatalogGrid({ entries, actions }: { entries: Entry[]; actions: CardActions }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {entries.map((e) => (
        <PluginCard key={e.key} entry={e} onOpen={() => actions.open(e)} onAdd={() => actions.add(e)} adding={actions.adding === e.key} menu={actions.menu(e)} />
      ))}
    </ul>
  )
}
