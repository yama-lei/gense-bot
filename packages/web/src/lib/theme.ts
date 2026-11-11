import { useSyncExternalStore } from 'react'
import { localStore, useLocal } from './local'

export type ThemePref = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

export const themePref = localStore<ThemePref>('gense.theme', 'system')

const system = matchMedia('(prefers-color-scheme: dark)')
const resolve = (): Theme => (themePref.get() === 'system' ? (system.matches ? 'dark' : 'light') : (themePref.get() as Theme))

/** Puts the theme on <html>, where the tokens in styles/app.css read it. */
function apply() {
  const theme = resolve()
  document.documentElement.dataset.theme = theme
  document.querySelector<HTMLMetaElement>('meta[name=theme-color]')?.setAttribute('content', theme === 'dark' ? '#262624' : '#faf9f5')
}

themePref.subscribe(apply)
system.addEventListener('change', apply)
apply()

const subscribe = (listener: () => void) => {
  const off = themePref.subscribe(listener)
  system.addEventListener('change', listener)
  return () => {
    off()
    system.removeEventListener('change', listener)
  }
}

export const useThemePref = () => useLocal(themePref)
/** The theme in effect. */
export const useTheme = () => useSyncExternalStore(subscribe, resolve)
