// Small stores for what stays in this browser: the theme, the model last chosen, view states.
import { useSyncExternalStore } from 'react'

export interface LocalStore<T> {
  get(): T
  set(next: T | ((current: T) => T)): void
  subscribe(listener: () => void): () => void
}

/** A value kept in localStorage under `key`; without storage it lasts for this tab. */
export function localStore<T>(key: string, initial: T): LocalStore<T> {
  let value = initial
  try {
    const raw = localStorage.getItem(key)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as T
      value = initial && typeof initial === 'object' && !Array.isArray(initial) ? { ...initial, ...parsed } : parsed
    }
  } catch {
    // Unreadable: start from the default.
  }
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next) {
      value = typeof next === 'function' ? (next as (current: T) => T)(value) : next
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // Full or blocked storage.
      }
      for (const l of listeners) l()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

export const useLocal = <T>(store: LocalStore<T>) => useSyncExternalStore(store.subscribe, store.get)
