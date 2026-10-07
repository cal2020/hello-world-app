import { useCallback, useEffect, useState } from 'react'

import { useMediaQuery } from './media'
import { readStorage, writeStorage } from './storage'

export type ThemeChoice = 'system' | 'light' | 'dark'
const KEY = 'aci.theme'

export function useTheme(): {
  choice: ThemeChoice
  resolved: 'light' | 'dark'
  setChoice: (choice: ThemeChoice) => void
} {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => {
    const saved = readStorage(KEY)
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  })
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  const resolved = choice === 'system' ? (systemDark ? 'dark' : 'light') : choice

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark')
    document.documentElement.style.colorScheme = resolved
  }, [resolved])

  const setChoice = useCallback((next: ThemeChoice) => {
    writeStorage(KEY, next)
    setChoiceState(next)
  }, [])

  return { choice, resolved, setChoice }
}
