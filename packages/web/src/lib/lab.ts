// What the interface already offers but the server does not keep yet: projects, memories, answer feedback, drafts and
// a few toggles. All of it lives in this browser (lib/local.ts) until the server grows the matching state; each
// store's shape is what that state should look like.
import { localStore, useLocal } from './local'

export interface Project {
  id: string
  name: string
  /** Index into `projectColors`. */
  color: number
  /** Sent with the first message of each conversation started in the project. */
  instructions: string
  treeIds: string[]
  createdAt: number
}

export const projectColors = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--muted-foreground)']

export const projects = localStore<Project[]>('gense.projects', [])
export const useProjects = () => useLocal(projects)
export const projectOf = (list: Project[], treeId: string) => list.find((p) => p.treeIds.includes(treeId))

export function createProject(name: string, instructions = ''): Project {
  const made: Project = { id: crypto.randomUUID(), name, color: projects.get().length % projectColors.length, instructions, treeIds: [], createdAt: Date.now() }
  projects.set((all) => [made, ...all])
  return made
}

export const updateProject = (id: string, patch: Partial<Project>) => projects.set((all) => all.map((p) => (p.id === id ? { ...p, ...patch } : p)))
export const deleteProject = (id: string) => projects.set((all) => all.filter((p) => p.id !== id))

/** Puts a conversation in one project (or none); a conversation is in at most one. */
export const moveToProject = (treeId: string, projectId: string | null) =>
  projects.set((all) =>
    all.map((p) => {
      const rest = p.treeIds.filter((t) => t !== treeId)
      return { ...p, treeIds: p.id === projectId ? [treeId, ...rest] : rest }
    }),
  )

export interface Memory {
  id: string
  text: string
  /** Where it came from: written by the owner, or noticed in a conversation. */
  source: 'manual' | 'chat'
  enabled: boolean
  createdAt: number
}

export const memories = localStore<Memory[]>('gense.memories', [])
export const useMemories = () => useLocal(memories)

/** 👍 / 👎 per answer, keyed `treeId:turnId`. */
export const feedback = localStore<Record<string, 'up' | 'down'>>('gense.feedback', {})
export const useFeedback = () => useLocal(feedback)

/** What was typed and not sent, per conversation (`home` for the start page). */
export const drafts = localStore<Record<string, string>>('gense.drafts', {})

/** Switches that are remembered but not wired to the server yet. */
export const lab = localStore('gense.lab', {
  memory: true,
  suggestions: true,
  /** Which Inbox items were read, by id. */
  read: [] as string[],
  sendKey: 'enter' as 'enter' | 'mod-enter',
  wide: false,
})
export const useLab = () => useLocal(lab)
