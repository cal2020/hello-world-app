import { createContext, useContext } from 'react'

import type { ImportSummary, RunSummary } from './api/types'

export interface AppActions {
  openImport: () => void
  loadDemo: () => void
  exportImport: (importId: string, format: 'html' | 'json') => void
  exportComparison: (comparisonId: string, format: 'html' | 'json') => void
  requestDeleteImport: (summary: ImportSummary) => void
  requestDeleteRun: (run: RunSummary) => void
  compareFrom: (runId: string) => void
}

export const ActionsContext = createContext<AppActions | null>(null)

export function useActions(): AppActions {
  const actions = useContext(ActionsContext)
  if (!actions) throw new Error('useActions must be used inside ActionsContext')
  return actions
}
