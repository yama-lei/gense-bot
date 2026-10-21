import { models } from './mock/seed'
import type { ModelOption } from './types'

export const modelKey = (m: ModelOption) => `${m.provider}:${m.id}`
export const findModel = (key: string) => models.find((m) => modelKey(m) === key)
export const modelName = (key: string) => findModel(key)?.name ?? key.split(':').pop()!
