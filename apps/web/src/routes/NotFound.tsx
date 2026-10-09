import { Link } from 'react-router'
import { Button } from '../components/ui/Button.js'
import { FullScreenState } from '../components/ui/FullScreenState.js'
import { actions, states } from '../lib/strings.js'
import { useAuthStore } from '../stores/authStore.js'
import { useSessionBootstrap } from './guards.js'

/**
 * S-20 — the generic 404, FLOWS §1.1 "UNIVERSAL FALLBACKS", route `*`.
 *
 * "Take me home" → S-01 or S-07 (§1.2): the dashboard for a signed-in user,
 * the landing page for everyone else. The silent refresh runs here too, so a
 * returning user with a valid cookie is sent to their dashboard rather than
 * the marketing page. The page renders at once while it resolves — a 404
 * behind a spinner is a slower 404.
 */
export default function NotFound() {
  useSessionBootstrap()
  const authed = useAuthStore(s => s.status === 'authenticated')
  return (
    <FullScreenState
      headline={states.notFound.headline}
      body={states.notFound.body}
      action={
        <Link to={authed ? '/dashboard' : '/'} data-testid="take-me-home">
          <Button variant="secondary">{actions.takeMeHome}</Button>
        </Link>
      }
      testId="not-found"
    />
  )
}
