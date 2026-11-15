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
  document.querySelector<HTMLMetaElement>('meta[name=theme-color]')?.setAttribute('content', theme === 'dark' ? '#0d0f10' : '#f3f4f2')
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

/** The accent colour; the hues live in styles/app.css under [data-accent]. */
export const accents = [
  { id: 'jade', label: '青玉', swatch: 'oklch(0.6 0.11 165)' },
  { id: 'ocean', label: '海蓝', swatch: 'oklch(0.6 0.14 250)' },
  { id: 'violet', label: '堇紫', swatch: 'oklch(0.6 0.15 295)' },
  { id: 'ember', label: '赤陶', swatch: 'oklch(0.62 0.14 40)' },
  { id: 'rose', label: '绯红', swatch: 'oklch(0.62 0.15 5)' },
  { id: 'ink', label: '墨色', swatch: '#5b6062' },
] as const
export type Accent = (typeof accents)[number]['id']

export const accentPref = localStore<Accent>('gense.accent', 'jade')
const applyAccent = () => {
  document.documentElement.dataset.accent = accentPref.get()
}
accentPref.subscribe(applyAccent)
applyAccent()
export const useAccent = () => useLocal(accentPref)
