import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'
import { ErrorBoundary } from './components/states/ErrorBoundary.js'
import { installGlobalErrorReporting } from './lib/errorReporting.js'
import { installSubmitShortcut } from './lib/submitShortcut.js'
import { missingBrowserFeatures } from './lib/browserSupport.js'
import { FullScreenState } from './components/ui/FullScreenState.js'
import { errors } from './lib/strings.js'
import { startSessionBootstrap } from './routes/guards.js'
import './index.css'

// Errors outside render (handlers, timers, promises) are reported too.
installGlobalErrorReporting()
// PRD Appendix A: Cmd/Ctrl+Enter submits the focused form.
installSubmitShortcut()

const container = document.getElementById('root')
if (!container) throw new Error('Root element #root not found')

// PRD §7.6: a browser missing what the board needs gets one honest sentence.
const supported = missingBrowserFeatures().length === 0

// The silent refresh starts now, in parallel with the route's chunks, rather
// than after the first render (PRD §7.1 dashboard budget; see guards.tsx).
if (supported) startSessionBootstrap()

createRoot(container).render(
  <StrictMode>
    {supported ? (
      // S-21, the outer boundary: a crash anywhere, providers included.
      <ErrorBoundary variant="app">
        <App />
      </ErrorBoundary>
    ) : (
      <FullScreenState
        headline={errors.unsupportedBrowser}
        testId="unsupported-browser"
      />
    )}
  </StrictMode>,
)
