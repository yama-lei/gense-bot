// Roadmap-6 C: model-sized thresholds and the handoff instructions for every compaction.
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { CompactionTask, type CompactionPolicy, type RegistryReader } from '@earendil-works/pi-durable'
import type { CompactionOutcome } from '@gense/protocol'
import type { UserSpace } from './space.ts'

export const COMPACTION_INSTRUCTIONS = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`

export function compactionPolicy(contextWindow: number): CompactionPolicy {
  // pi already enables compaction. Scale its budgets down for small windows and cap them for large ones.
  return {
    enabled: true,
    reserveTokens: Math.max(1, Math.min(16_384, Math.floor(contextWindow * 0.1))),
    keepRecentTokens: Math.max(1, Math.min(20_000, Math.floor(contextWindow * 0.2))),
    backgroundTokens: Math.max(1, Math.min(32_768, Math.floor(contextWindow * 0.15))),
  }
}

function instructions(extra?: string) {
  return COMPACTION_INSTRUCTIONS + (extra?.trim() ? `\n\nAdditional instructions from the user:\n${extra.trim()}` : '')
}

/**
 * pi 1.4 has no default-instructions setting: automatic tasks are created with only a reason. Adapt its read-side
 * task definition, supplying CompactionInput.instructions to the built-in phases. Selection, checkpoints, retries,
 * placement and recovery remain pi's. No global task definition or persisted task is mutated.
 */
export function compactionRegistry(registry: RegistryReader): RegistryReader {
  const definition = CompactionTask.definition
  const task: typeof CompactionTask = {
    definition: {
      ...definition,
      phases: {
        ...definition.phases,
        select: (task, runtime, ctx) => definition.phases.select({ ...task, input: { ...task.input, instructions: instructions(task.input.instructions) } }, runtime, ctx),
        summarize: (task, runtime, ctx) => definition.phases.summarize({ ...task, input: { ...task.input, instructions: instructions(task.input.instructions) } }, runtime, ctx),
      },
    },
  }
  return {
    subscribe: listener => registry.subscribe(listener),
    snapshot: () => {
      const snapshot = registry.snapshot()
      return {
        installed: () => snapshot.installed(),
        extension: name => snapshot.extension(name),
        tools: () => snapshot.tools(),
        sections: () => snapshot.sections(),
        tasks: () => snapshot.tasks().map(t => t.definition.name === definition.name ? task : t),
        task: name => name === definition.name ? task : snapshot.task(name),
      }
    },
  }
}

/** Admission returns immediately; status and the eventual summary arrive over the watched branch. */
export async function compact(this: UserSpace, treeId: string, branchId?: string, instructions?: string, ctx: Context = BACKGROUND_CONTEXT) {
  const { branch } = await this.branchRow(treeId, branchId)
  const taskId = await (await this.open(branch, ctx)).compact(instructions, ctx)
  return { taskId, branchId: branch.id }
}

/**
 * Waits for a compaction task to settle. pi completes without a result when the history is shorter than what it
 * keeps verbatim, so a manual request can end with nothing to do; the caller says so rather than "done".
 */
export async function compactionOutcome(space: UserSpace, taskId: Awaited<ReturnType<typeof compact>>['taskId'], ctx: Context = BACKGROUND_CONTEXT): Promise<CompactionOutcome> {
  const { outcome } = (await space.harness.waitForTask(taskId, ctx)).state
  switch (outcome.status) {
    case 'completed': {
      const result = (outcome.result ?? {}) as { entryId?: unknown; submissionId?: unknown }
      return result.entryId !== undefined || result.submissionId !== undefined ? { status: 'placed' } : { status: 'nothing' }
    }
    case 'failed':
    case 'faulted':
      return { status: 'failed', error: outcome.error.message }
    case 'orphaned':
      return { status: 'failed', error: outcome.reason }
    default:
      return { status: 'aborted' }
  }
}
