import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { AppStateProvider } from './state/store'
import { initTheme } from './lib/theme'
import './styles/tokens.css'
import './styles.css'

initTheme()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, staleTime: 1000 },
  },
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppStateProvider>
        <App />
      </AppStateProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
