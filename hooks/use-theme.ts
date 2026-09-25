'use client'

import { useCallback, useSyncExternalStore } from 'react'

import { THEME_STORAGE_KEY, type ThemePreference } from '@/lib/theme'

const LIGHT_QUERY = '(prefers-color-scheme: light)'

interface ThemeState {
  preference: ThemePreference
  resolved: 'light' | 'dark'
}

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

function resolve(preference: ThemePreference): 'light' | 'dark' {
  if (preference !== 'system') return preference
  return window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark'
}

function apply(theme: 'light' | 'dark') {
  const root = document.documentElement
  root.classList.toggle('light', theme === 'light')
  root.classList.toggle('dark', theme === 'dark')
}

/*
 * One theme state for the whole page (not one per component), so a change made anywhere — the
 * account menu, the command palette — reaches every component that draws with theme colours.
 */
const SERVER_STATE: ThemeState = { preference: 'system', resolved: 'dark' }
const listeners = new Set<() => void>()
let state: ThemeState | null = null

function current(): ThemeState {
  if (!state) {
    const preference = readPreference()
    state = { preference, resolved: resolve(preference) }
  }
  return state
}

function publish(next: ThemeState) {
  state = next
  listeners.forEach((listener) => listener())
}

function onSystemChange() {
  if (current().preference !== 'system') return
  const resolved = resolve('system')
  apply(resolved)
  publish({ preference: 'system', resolved })
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) window.matchMedia(LIGHT_QUERY).addEventListener('change', onSystemChange)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.matchMedia(LIGHT_QUERY).removeEventListener('change', onSystemChange)
  }
}

/** Light / dark / system theme, persisted per browser and following OS changes in "system" mode. */
export function useTheme() {
  const { preference, resolved } = useSyncExternalStore(subscribe, current, () => SERVER_STATE)

  const setTheme = useCallback((next: ThemePreference) => {
    try {
      if (next === 'system') localStorage.removeItem(THEME_STORAGE_KEY)
      else localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
    const theme = resolve(next)
    apply(theme)
    publish({ preference: next, resolved: theme })
  }, [])

  return { preference, resolved, setTheme }
}
