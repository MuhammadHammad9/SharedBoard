import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from './components/ui/Toast.js'
import {
  RedirectIfAuthed,
  RedirectIfAuthedOptimistic,
  RequireAuth,
} from './routes/guards.js'
import { RequireBoardAccess } from './routes/RequireBoardAccess.js'
import { FullScreenSpinner } from './components/ui/Spinner.js'
import Login from './routes/Login.js'
import Signup from './routes/Signup.js'
import ForgotPassword from './routes/ForgotPassword.js'
import ResetPassword from './routes/ResetPassword.js'
import OAuthCallback from './routes/OAuthCallback.js'
import Settings from './routes/Settings.js'
/*
 * S-01 is STATIC, unlike the board. It is prerendered into dist/index.html
 * (scripts/prerender.ts) for the LCP budget, and React's first render must be
 * the same markup — a lazy route would first render an empty Suspense
 * fallback and wipe the prerendered page until its chunk arrived. It costs
 * ~4 KB gzipped and imports no canvas code.
 */
import Landing from './routes/Landing.js'
import { loading } from './lib/strings.js'

/**
 * The router — FLOWS §2.1.
 *
 * The board route is LAZY and every auth route is not, which is the whole
 * point of the split. TRD §12.2: the auth screens must not pull in the canvas
 * engine. A static import of `Board` here would put the renderer, the
 * interaction machine and the history stack into the initial chunk, and every
 * person who lands on /login would download a whiteboard to look at a form.
 *
 * NO route transition animation. The plan's motion table says "Route
 * transition — None", and it is right: a fade between pages makes an app that
 * navigates instantly feel like one that does not.
 *
 * S-01 Landing is the exception: static, because it is prerendered.
 */

const Board = lazy(() => import('./routes/Board.js'))
const GuestEntry = lazy(() => import('./routes/GuestEntry.js'))

/*
 * The dashboard and Trash are lazy for the same reason the board is (TRD
 * §12.2): they pull TanStack Query and, through the grid, Framer Motion, and
 * someone landing on /login should download neither. They share one chunk
 * because they share every component they use, so the second one is free once
 * the first has loaded.
 */
const loadDashboard = () => import('./routes/Dashboard.js')
const Dashboard = lazy(loadDashboard)
/*
 * PRD §7.1 "Dashboard interactive ≤ 2.0 s": on a direct load of the dashboard
 * or Trash, start fetching their chunk NOW, in parallel with the silent
 * refresh, instead of after `RequireAuth` resolves. `lazy()` then finds the
 * module already in flight. Measured: one round trip off a slow-4G load.
 */
if (
  typeof window !== 'undefined' &&
  /^\/(dashboard|trash)\b/.test(window.location.pathname)
) {
  void loadDashboard()
}
const Trash = lazy(() => import('./routes/Trash.js'))

/**
 * One QueryClient for the app's lifetime, created OUTSIDE the component.
 *
 * Created inside, every render would produce a new client and throw the whole
 * cache away — which looks like "the dashboard refetches constantly" and is
 * the single most common way this library is misconfigured.
 *
 * `retry: 1` rather than the default 3: a dashboard that spends nine seconds
 * silently retrying before it admits failure is worse than one that shows the
 * error state and a Retry button, which FLOWS §6.3 requires anyway.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            {/* MARKETING — S-01. */}
            <Route
              path="/"
              element={
                <RedirectIfAuthedOptimistic>
                  <Landing />
                </RedirectIfAuthedOptimistic>
              }
            />
            {/* "Try it now" — S-10 in demo mode: no account, nothing saved. */}
            <Route
              path="/demo"
              element={
                <Suspense fallback={<FullScreenSpinner label={loading.board} />}>
                  <Board demo />
                </Suspense>
              }
            />

            {/* AUTH — S-02 … S-06 */}
            <Route
              path="/login"
              element={
                <RedirectIfAuthed>
                  <Login />
                </RedirectIfAuthed>
              }
            />
            <Route
              path="/signup"
              element={
                <RedirectIfAuthed>
                  <Signup />
                </RedirectIfAuthed>
              }
            />
            <Route
              path="/forgot-password"
              element={
                <RedirectIfAuthed>
                  <ForgotPassword />
                </RedirectIfAuthed>
              }
            />
            {/* Guarded by the token in the URL, not by a session — a logged-out
            user following a reset link must reach it. */}
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/auth/callback" element={<OAuthCallback />} />

            {/* PRODUCT CHROME */}
            <Route
              path="/dashboard"
              element={
                <RequireAuth>
                  <Suspense fallback={<FullScreenSpinner label={loading.boards} />}>
                    <Dashboard />
                  </Suspense>
                </RequireAuth>
              }
            />
            <Route
              path="/settings"
              element={
                <RequireAuth>
                  <Settings />
                </RequireAuth>
              }
            />

            {/*
             * BOARD — FLOWS §2.3 `requireBoardAccess`. Users AND guests: the
             * guard resolves identity, asks /access, and renders S-17/S-18
             * itself rather than redirecting, because the URL is valid either way.
             */}
            <Route path="/board/:boardId" element={<BoardRoute />} />

            {/* S-11 — a guest arriving through a share link. No session needed. */}
            <Route
              path="/join/:token"
              element={
                <Suspense fallback={<FullScreenSpinner label={loading.invite} />}>
                  <GuestEntry />
                </Suspense>
              }
            />

            <Route
              path="/trash"
              element={
                <RequireAuth>
                  <Suspense fallback={<FullScreenSpinner label={loading.boards} />}>
                    <Trash />
                  </Suspense>
                </RequireAuth>
              }
            />

            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  )
}

function BoardRoute() {
  const { boardId = '' } = useParams<{ boardId: string }>()
  return (
    <RequireBoardAccess boardId={boardId}>
      <Suspense fallback={<FullScreenSpinner label={loading.board} />}>
        <Board />
      </Suspense>
    </RequireBoardAccess>
  )
}
