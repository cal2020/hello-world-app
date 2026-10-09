import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './index.css'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 5_000 },
  },
})

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

let tree = (
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
)
if (__BROWSER_BUILD__) {
  // Browser build: the backend runs in a worker; show its startup before the app.
  const { RuntimeGate } = await import('./runtime/RuntimeGate')
  tree = <RuntimeGate>{tree}</RuntimeGate>
}

createRoot(root).render(<StrictMode>{tree}</StrictMode>)
