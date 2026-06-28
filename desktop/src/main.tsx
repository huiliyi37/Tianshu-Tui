import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AppStateProvider } from './state/store'
import { initTheme } from './lib/theme'
import { initFontWeight } from './lib/font-weight'
import { initFontFamily } from './lib/font-family'
import { initGlassMode } from './lib/glass'
import { initGlassCustom } from './lib/glass-custom'
import { initUiDensity } from './lib/ui-density'
import { initI18n } from './i18n'
import './styles/tokens.css'
import './styles.css'
import './styles/shadcn-tokens.css'
import 'katex/dist/katex.min.css'
import { TooltipProvider } from '@/components/ui/tooltip'

initTheme()
initFontWeight()
initFontFamily()
initGlassMode()
initGlassCustom()
initUiDensity()
initI18n()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, staleTime: 1000 },
  },
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary label="应用">
      <QueryClientProvider client={queryClient}>
        <AppStateProvider>
          <TooltipProvider>
            <App />
          </TooltipProvider>
        </AppStateProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
