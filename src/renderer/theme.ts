/**
 * App themes — the UI stylesheet runs on CSS variables, so a theme is just
 * 15 color overrides applied to :root (plus an optional skin for a full restyle). Persisted in localStorage, applied
 * on launch and on every pick. Canvas graphs (curve plot, dials) use fixed
 * paint colors and intentionally keep theirs in every theme.
 */
import { createContext, useEffect, useState } from 'react'

export type ThemeCategory = 'colors' | 'games' | 'apps'

export interface AppTheme {
  id: string
  label: string
  /** Section of the theme picker it sits in. */
  category: ThemeCategory
  vars: Record<string, string>
  /** Optional full restyle beyond colours: sets data-skin on <html> (see automata.css). */
  skin?: string
}

const VARS = [
  '--bg', '--bg-1', '--bg-2', '--bg-3', '--line', '--line-2',
  '--text', '--text-2', '--text-3',
  '--accent', '--accent-2', '--on-accent',
  '--good', '--warn', '--bad', '--violet',
  '--radius', '--radius-sm'
] as const

export const THEMES: ReadonlyArray<AppTheme> = [
  {
    id: 'default',
    category: 'colors',
    label: 'Default',
    vars: {
      '--bg': '#0f1115', '--bg-1': '#161920', '--bg-2': '#1c2028', '--bg-3': '#232833',
      '--line': '#2c323d', '--line-2': '#3b4352',
      '--text': '#e9ecf1', '--text-2': '#a9b1be', '--text-3': '#737c8b',
      '--accent': '#f43f52', '--accent-2': '#ff8fa0', '--on-accent': '#ffffff',
      '--good': '#3ecf8e', '--warn': '#e8b356', '--bad': '#ff6b6b', '--violet': '#a78bfa'
    }
  },
  {
    id: 'cyberpunk',
    category: 'games',
    skin: 'cyberpunk',
    label: 'Cyberpunk 2077',
    vars: {
      '--bg': '#050508', '--bg-1': '#121218', '--bg-2': '#1a1a24', '--bg-3': '#242433',
      '--line': '#2e2e3d', '--line-2': '#4a4a5e',
      '--text': '#e8f0f2', '--text-2': '#9fb3bd', '--text-3': '#5a6b75',
      '--accent': '#fcee0a', '--accent-2': '#fff06b', '--on-accent': '#0b0b10',
      '--good': '#00e5a0', '--warn': '#ffb300', '--bad': '#ff003c', '--violet': '#ff2fb3',
      '--radius': '0', '--radius-sm': '0'
    }
  },
  {
    id: 'discord',
    category: 'apps',
    label: 'Discord',
    vars: {
      '--bg': '#1e1f22', '--bg-1': '#2b2d31', '--bg-2': '#35373c', '--bg-3': '#404249',
      '--line': '#3f4147', '--line-2': '#4e5058',
      '--text': '#f2f3f5', '--text-2': '#b5bac1', '--text-3': '#7d818c',
      '--accent': '#5865F2', '--accent-2': '#8f9bf3', '--on-accent': '#ffffff',
      '--good': '#57F287', '--warn': '#FEE75C', '--bad': '#ED4245', '--violet': '#EB459E'
    }
  },
  {
    id: 'spotify',
    category: 'apps',
    label: 'Spotify',
    vars: {
      '--bg': '#121212', '--bg-1': '#181818', '--bg-2': '#242424', '--bg-3': '#2e2e2e',
      '--line': '#2b2b2b', '--line-2': '#3e3e3e',
      '--text': '#ffffff', '--text-2': '#b3b3b3', '--text-3': '#6a6a6a',
      '--accent': '#1DB954', '--accent-2': '#1ED760', '--on-accent': '#000000',
      '--good': '#1ED760', '--warn': '#eab308', '--bad': '#E91429', '--violet': '#AFB1FF',
      '--radius': '12px', '--radius-sm': '8px'
    }
  },
  {
    id: 'halloween',
    category: 'colors',
    label: 'Halloween',
    vars: {
      '--bg': '#0e0813', '--bg-1': '#171020', '--bg-2': '#221530', '--bg-3': '#2e1d42',
      '--line': '#3d2547', '--line-2': '#5c3a6e',
      '--text': '#f5ecdf', '--text-2': '#c9a86a', '--text-3': '#7a5f8f',
      '--accent': '#ff7518', '--accent-2': '#ffa94d', '--on-accent': '#1a0d02',
      '--good': '#3EE87E', '--warn': '#FFC42E', '--bad': '#C1121F', '--violet': '#A855F7'
    }
  },
  {
    id: 'automata',
    category: 'games',
    label: 'NieR:Automata',
    skin: 'automata',
    vars: {
      '--bg': '#cdc8b0', '--bg-1': '#d3cdb5', '--bg-2': '#dad4bb', '--bg-3': '#c4bea6',
      '--line': '#aaa48d', '--line-2': '#8b8573',
      '--text': '#4e4b42', '--text-2': '#5f5b50', '--text-3': '#858071',
      '--accent': '#4e4b42', '--accent-2': '#6e6a5c', '--on-accent': '#dad4bb',
      '--good': '#57694a', '--warn': '#9c7b38', '--bad': '#b4533e', '--violet': '#6b5d7a',
      '--radius': '0', '--radius-sm': '0'
    }
  },
  {
    id: 'persona',
    category: 'games',
    label: 'Persona 5',
    skin: 'persona',
    vars: {
      '--bg': '#e5191c', '--bg-1': '#0b0b0b', '--bg-2': '#0b0b0b', '--bg-3': '#1c1c1c',
      '--line': '#3a3a3a', '--line-2': '#f7f7f7',
      '--text': '#f7f7f7', '--text-2': '#e4e4e4', '--text-3': '#a9a9a9',
      '--accent': '#e5191c', '--accent-2': '#ff5a5a', '--on-accent': '#ffffff',
      '--good': '#ffffff', '--warn': '#ffd23d', '--bad': '#ff2a2a', '--violet': '#ffffff',
      '--radius': '0', '--radius-sm': '0'
    }
  },
  {
    id: 'hollow',
    category: 'games',
    label: 'Hollow Knight',
    skin: 'hollow',
    vars: {
      '--bg': '#070a12', '--bg-1': '#0b0f1a', '--bg-2': '#0e1320', '--bg-3': '#161c2c',
      '--line': '#232b3f', '--line-2': '#56607a',
      '--text': '#e8ecf2', '--text-2': '#aeb6c6', '--text-3': '#6d7690',
      '--accent': '#dfe7f5', '--accent-2': '#ffffff', '--on-accent': '#0b0f1a',
      '--good': '#9fd3ff', '--warn': '#f0a050', '--bad': '#d64545', '--violet': '#8a7fd8',
      '--radius': '2px', '--radius-sm': '2px'
    }
  },
  {
    id: 'nord',
    category: 'colors',
    label: 'Nord',
    vars: {
      '--bg': '#2E3440', '--bg-1': '#3B4252', '--bg-2': '#434C5E', '--bg-3': '#4C566A',
      '--line': '#434C5E', '--line-2': '#4C566A',
      '--text': '#ECEFF4', '--text-2': '#D8DEE9', '--text-3': '#7e8aa5',
      '--accent': '#88C0D0', '--accent-2': '#a9d6e5', '--on-accent': '#2E3440',
      '--good': '#A3BE8C', '--warn': '#EBCB8B', '--bad': '#BF616A', '--violet': '#B48EAD'
    }
  }
]

/** Picker sections, in display order. */
export const THEME_CATEGORIES: ReadonlyArray<ThemeCategory> = ['colors', 'games', 'apps']

export function themeById(id: string): AppTheme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

export function applyTheme(id: string): void {
  const theme = themeById(id)
  const vars = theme.vars
  const root = document.documentElement
  if (theme.skin) root.dataset.skin = theme.skin
  else delete root.dataset.skin
  for (const key of VARS) {
    const value = vars[key]
    if (value) root.style.setProperty(key, value)
    else root.style.removeProperty(key)
  }
}

interface ThemeCtx {
  theme: string
  setTheme: (id: string) => void
}

export const ThemeContext = createContext<ThemeCtx>({ theme: 'default', setTheme: () => undefined })

export function useThemeState(): [string, (id: string) => void] {
  const [theme, setThemeState] = useState<string>(() => {
    try {
      const saved = window.localStorage.getItem('sticklabs.theme')
      if (saved && THEMES.some((t) => t.id === saved)) return saved
    } catch {
      /* ignore */
    }
    return 'default'
  })
  useEffect(() => {
    applyTheme(theme)
  }, [theme])
  const setTheme = (id: string): void => {
    if (!THEMES.some((t) => t.id === id)) return
    setThemeState(id)
    try {
      window.localStorage.setItem('sticklabs.theme', id)
    } catch {
      /* ignore */
    }
  }
  return [theme, setTheme]
}
