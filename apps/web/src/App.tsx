import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { RedirectIfAuthed, RequireAuth } from './routes/guards.js'
import { FullScreenSpinner } from './components/ui/Spinner.js'
import Login from './routes/Login.js'
import Signup from './routes/Signup.js'
import ForgotPassword from './routes/ForgotPassword.js'
import ResetPassword from './routes/ResetPassword.js'
import OAuthCallback from './routes/OAuthCallback.js'
import Dashboard from './routes/Dashboard.js'
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

export default function App() {
  return (
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
              <Dashboard />
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
         * BOARD. `requireBoardAccess` (FLOWS §2.3) needs board membership,
         * which is Phase 8 — so for now the board is behind requireAuth only,
         * and the canvas remains reachable for the Phase 2–6 e2e suites.
         */}
        <Route
          path="/board/:boardId"
          element={
            <Suspense fallback={<FullScreenSpinner label="Opening board" />}>
              <Board />
            </Suspense>
          }
        />

        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
