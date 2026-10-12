import { useCallback, useEffect, useState } from 'react'

/** 跟随系统 / 浅色 / 深色. “system” leaves <html> without data-theme so the CSS media query decides. */
export type ThemeChoice = 'system' | 'light' | 'dark'

const KEY = 'tm.theme'
export const THEME_LABELS: Record<ThemeChoice, string> = { system: '跟随系统', light: '浅色', dark: '深色' }
const ORDER: ThemeChoice[] = ['system', 'light', 'dark']

export function readTheme(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch { return 'system' }
}

export function applyTheme(choice: ThemeChoice): void {
  if (choice === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', choice)
}

/** The theme actually shown, after resolving “system” against the OS preference. */
function resolved(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function useTheme(): { choice: ThemeChoice; shown: 'light' | 'dark'; next: () => void } {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme)
  const [shown, setShown] = useState(() => resolved(choice))
  useEffect(() => {
    applyTheme(choice)
    setShown(resolved(choice))
    try { if (choice === 'system') window.localStorage.removeItem(KEY); else window.localStorage.setItem(KEY, choice) } catch { /* not persisted */ }
    if (choice !== 'system') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const follow = () => setShown(query.matches ? 'dark' : 'light')
    query.addEventListener('change', follow)
    return () => query.removeEventListener('change', follow)
  }, [choice])
  const next = useCallback(() => setChoice(current => ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]), [])
  return { choice, shown, next }
}
