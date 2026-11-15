// What stays in this browser on purpose (lib/local.ts): drafts and how this device shows things. Everything about
// the user's account lives on the server.
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

/** What was typed and not sent, per conversation (`home` for the start page). */
export const drafts = localStore<Record<string, string>>('gense.drafts', {})

/** This device's preferences. */
export const lab = localStore('gense.lab', {
  sendKey: 'enter' as 'enter' | 'mod-enter',
  wide: false,
})
export const useLab = () => useLocal(lab)
