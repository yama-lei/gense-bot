import { createContext, useContext } from 'react'
import type { ModelOption } from './types'

/** The models the endpoints serve, provided by App from the store. */
export const ModelsContext = createContext<ModelOption[]>([])
export const useModels = () => useContext(ModelsContext)

export const modelKey = (m: ModelOption) => `${m.provider}:${m.id}`
export const findModel = (models: ModelOption[], key: string) => models.find((m) => modelKey(m) === key)
export const modelName = (models: ModelOption[], key: string) => findModel(models, key)?.name ?? key.split(':').pop()!
