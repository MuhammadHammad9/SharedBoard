import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from './components/ui/Toast.js'
import { RedirectIfAuthed, RequireAuth } from './routes/guards.js'
import { FullScreenSpinner } from './components/ui/Spinner.js'
import Login from './routes/Login.js'
import Signup from './routes/Signup.js'
import ForgotPassword from './routes/ForgotPassword.js'
import ResetPassword from './routes/ResetPassword.js'
import OAuthCallback from './routes/OAuthCallback.js'
import Settings from './routes/Settings.js'

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
 * S-01 Landing, S-08 Trash, S-11 GuestEntry and S-10's chrome are later
 * phases. The routes that do not exist yet are absent rather than stubbed,
 * so nothing renders a screen that pretends to work.
 */

const Board = lazy(() => import('./routes/Board.js'))

/*
 * The dashboard and Trash are lazy for the same reason the board is (TRD
 * §12.2): they pull TanStack Query and, through the grid, Framer Motion, and
 * someone landing on /login should download neither. They share one chunk
 * because they share every component they use, so the second one is free once
 * the first has loaded.
 */
const Dashboard = lazy(() => import('./routes/Dashboard.js'))
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
            {/* MARKETING — S-01 is Phase 15. Until then `/` is a signpost. */}
            <Route
              path="/"
              element={
                <RedirectIfAuthed>
                  <Navigate to="/login" replace />
                </RedirectIfAuthed>
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
                  <Suspense fallback={<FullScreenSpinner label="Loading your boards" />}>
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
             * BOARD — FLOWS §2.1, §2.3.
             *
             * `RequireAuth` gets the session; the board-level half of
             * `requireBoardAccess` is enforced by the server and rendered by the
             * route itself, which shows S-19/S-20 rather than redirecting. That
             * split is deliberate: a guard cannot decide access without asking the
             * server anyway, and doing it inside the route means one request
             * answers both "may I?" and "what is on it?".
             */}
            <Route
              path="/board/:boardId"
              element={
                <RequireAuth>
                  <Suspense fallback={<FullScreenSpinner label="Opening board" />}>
                    <Board />
                  </Suspense>
                </RequireAuth>
              }
            />

            <Route
              path="/trash"
              element={
                <RequireAuth>
                  <Suspense fallback={<FullScreenSpinner label="Loading your boards" />}>
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
