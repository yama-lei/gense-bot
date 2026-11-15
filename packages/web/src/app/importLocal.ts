// One-time move of the projects and memories this browser kept before the server stored them (roadmap-7 A).
// Runs once the server has sent both lists; an entry the server already has (same name / same text) is skipped,
// so a second browser holding the same data does not duplicate it.
import type { Client } from './client'
import { legacyMemories, legacyProjects } from '../lib/lab'
import { toast } from 'sonner'

let started = false

export function importLocal(client: Client) {
  const { memories, projects, trees } = client.socket.state
  if (started || !memories || !projects || !trees) return
  const oldProjects = legacyProjects.get()
  const oldMemories = legacyMemories.get()
  if (oldProjects.length === 0 && oldMemories.length === 0) return
  started = true
  void (async () => {
    let moved = 0
    const known = new Set(trees.map((t) => t.id))
    for (const p of [...oldProjects].reverse()) {
      const made = projects.find((x) => x.name === p.name) ?? (await client.createProject({ name: p.name, instructions: p.instructions, color: p.color }))
      for (const treeId of p.treeIds) if (known.has(treeId)) client.moveToProject(treeId, made.id)
      moved++
    }
    const texts = new Set(memories.map((m) => m.text))
    for (const m of [...oldMemories].reverse()) {
      if (texts.has(m.text)) continue
      await client.addMemory({ text: m.text, source: m.source === 'chat' ? 'saved' : 'manual', enabled: m.enabled })
      moved++
    }
    legacyProjects.set([])
    legacyMemories.set([])
    try {
      localStorage.removeItem('gense.projects')
      localStorage.removeItem('gense.memories')
    } catch {
      // Storage blocked: the emptied stores already stop a second import.
    }
    if (moved > 0) toast.success('这个浏览器里的项目和记忆已同步到你的账户')
  })().catch((e: unknown) => {
    started = false
    toast.error(`同步本地的项目和记忆失败：${e instanceof Error ? e.message : String(e)}`)
  })
}
