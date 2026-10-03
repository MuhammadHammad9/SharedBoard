import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'
import { ErrorBoundary } from './components/states/ErrorBoundary.js'
import { installGlobalErrorReporting } from './lib/errorReporting.js'
import './index.css'

// Errors outside render (handlers, timers, promises) are reported too.
installGlobalErrorReporting()

const container = document.getElementById('root')
if (!container) throw new Error('Root element #root not found')

createRoot(container).render(
  <StrictMode>
    {/* S-21, the outer boundary: a crash anywhere, providers included. */}
    <ErrorBoundary variant="app">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
