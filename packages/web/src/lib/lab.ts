// What the interface already offers but the server does not keep yet: answer feedback, drafts and a few toggles.
// All of it lives in this browser (lib/local.ts) until the server grows the matching state; each store's shape is
// what that state should look like.
import { localStore, useLocal } from './local'

export const projectColors = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--muted-foreground)']

/**
 * Projects and memories this browser kept before the server stored them (the 2026-11-14 redesign). The first
 * connection after the upgrade moves them to the server (app/importLocal.ts) and then clears these keys.
 */
export interface LegacyProject {
  id: string
  name: string
  color: number
  instructions: string
  treeIds: string[]
  createdAt: number
}
export interface LegacyMemory {
  id: string
  text: string
  source: 'manual' | 'chat'
  enabled: boolean
  createdAt: number
}
export const legacyProjects = localStore<LegacyProject[]>('gense.projects', [])
export const legacyMemories = localStore<LegacyMemory[]>('gense.memories', [])

/** 👍 / 👎 per answer, keyed `treeId:turnId`. */
export const feedback = localStore<Record<string, 'up' | 'down'>>('gense.feedback', {})
export const useFeedback = () => useLocal(feedback)

/** What was typed and not sent, per conversation (`home` for the start page). */
export const drafts = localStore<Record<string, string>>('gense.drafts', {})

/** Switches that are remembered but not wired to the server yet. */
export const lab = localStore('gense.lab', {
  suggestions: true,
  /** Which Inbox items were read, by id. */
  read: [] as string[],
  sendKey: 'enter' as 'enter' | 'mod-enter',
  wide: false,
})
export const useLab = () => useLocal(lab)
