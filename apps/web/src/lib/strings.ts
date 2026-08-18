/**
 * Canonical user-facing copy. PRD §8.2 and §8.3, verbatim.
 *
 * R-UI-052 (Blocking): ALL user-facing copy originates here and nowhere else.
 * Inlining a string at a call site is how two screens end up saying different
 * things about the same condition (anti-pattern A-72).
 *
 * Tone rules — PRD §8.1:
 *   - Second person, present tense.
 *   - Never blame the user.
 *   - Every error tells the user what to do next.
 *   - No exclamation marks except "Copied!" and celebratory empty states.
 *   - Never expose internal identifiers, stack traces or error codes. Log them;
 *     show a friendly message with a short correlation ID.
 *
 * R-PREC-018: em-dashes present in PRD copy are preserved verbatim. The
 * `design-taste-frontend` §9.G em-dash ban applies only to newly authored copy.
 */

export const errors = {
  wrongCredentials: "That email or password didn't match. Try again.",
  rateLimitedLogin: (minutes: number) =>
    `Too many attempts. Try again in ${minutes} minutes.`,
  emailAlreadyRegistered: 'An account already exists for this email.',
  weakPassword: 'Password needs at least 8 characters, including a letter and a number.',
  noBoardAccess: "You don't have access to this board.",
  boardNotFound: "This board doesn't exist, or it was deleted.",
  boardDeletedWhileOpen: 'The owner deleted this board.',
  accessRevokedWhileOpen: 'Your access to this board was removed.',
  disconnected:
    "Offline — your changes are saved locally and will sync when you're back.",
  reconnecting: (attempt: number) => `Reconnecting… (attempt ${attempt})`,
  syncing: (count: number) => `Syncing ${count} changes…`,
  opRejected: "That change couldn't be saved.",
  uploadTooLarge: 'Images must be under 10 MB.',
  unsupportedFile: 'We support PNG, JPG, GIF, WebP, and SVG.',
  uploadFailed: 'Upload failed.',
  boardTooLarge: 'This board is getting large. Consider splitting it up.',
  genericServerError: "Something went wrong on our end. We're looking into it.",
  genericServerErrorRef: (correlationId: string) => `Ref: ${correlationId}`,
  unsupportedBrowser:
    'CoBoard needs a modern browser. Try Chrome, Firefox, Edge, or Safari.',
} as const

export const actions = {
  askOwnerForAccess: 'Ask the owner for access',
  backToDashboard: 'Back to dashboard',
  backToHome: 'Back to home',
  backToLogin: 'Back to log in',
  logInInstead: 'Log in instead',
  retry: 'Retry',
  retryNow: 'Retry now',
  remove: 'Remove',
  dismiss: 'Dismiss',
  undo: 'Undo',
  cancel: 'Cancel',
  newBoard: 'New board',
  clearFilter: 'Clear filter',
  clearSearch: 'Clear search',
  reloadPage: 'Reload page',
  takeMeHome: 'Take me home',
  signUp: 'Sign up',
  copy: 'Copy',
  copied: 'Copied!',
  moveToTrash: 'Move to trash',
  deleteForever: 'Delete forever',
  restore: 'Restore',
  resetLink: 'Reset link',
  requestAccess: 'Request access',
  switchAccount: 'Switch account',
  notYou: 'Not you?',
  joinBoard: 'Join board',
  createAccount: 'Create account',
  exportLabel: 'Export',
  share: 'Share',
} as const

/** PRD §8.3 */
export const emptyStates = {
  dashboardNoBoards: {
    headline: 'Nothing here yet',
    body: 'Create your first board and invite your team.',
    cta: actions.newBoard,
  },
  dashboardFilterEmpty: {
    headline: 'No boards match that filter',
    cta: actions.clearFilter,
  },
  trashEmpty: {
    headline: 'Trash is empty',
    body: 'Deleted boards appear here for 30 days.',
  },
  boardNoObjects: {
    hint: 'Pick a tool and start drawing',
  },
  searchNoResults: {
    headline: (query: string) => `No boards found for '${query}'`,
    cta: actions.clearSearch,
  },
} as const

/** FLOWS §3.2 — validation copy. Timing rules live in the form layer. */
export const validation = {
  emailRequired: 'Enter your email.',
  emailInvalid: "That doesn't look like an email address.",
  passwordRules: 'Password needs at least 8 characters, including a letter and a number.',
  displayNameRequired: 'Enter a name so others know who you are.',
  passwordRequired: 'Enter your password.',
  networkFailure: "Couldn't reach the server. Check your connection.",
} as const

/** FLOWS §7 — guest join. Persona B's entire experience. */
export const guest = {
  linkInvalid: "This link isn't valid. Ask whoever shared it for a new one.",
  linkTurnedOff: 'This link has been turned off.',
  boardGone: 'This board no longer exists.',
  boardFull: 'This board is full right now. Try again in a few minutes.',
  nameRequired: validation.displayNameRequired,
  joinedAs: (name: string) => `You're in as ${name}`,
  joinedChip: (name: string) => `Joined as ${name}`,
  conversionBar: "You're a guest. Sign up to save your boards.",
} as const

/** FLOWS §12 — full-screen states. */
export const states = {
  accessDenied: {
    // R-SEC-018: NEVER show the board name here. Leaking the name of a board
    // someone cannot access is an information leak.
    headline: errors.noBoardAccess,
    body: 'Ask the person who shared it to invite you.',
  },
  boardNotFound: {
    headline: errors.boardNotFound,
    body: 'Double-check the link, or head back to your boards.',
  },
  boardDeleted: {
    headline: errors.boardDeletedWhileOpen,
    body: 'Your changes were saved before it was deleted.',
  },
  errorBoundary: {
    headline: 'Something went wrong.',
    body: "We've logged the problem. Reloading usually fixes it.",
  },
} as const

/** FR-RT-008, FR-RT-009 — presence and connection. */
export const presence = {
  userJoined: (name: string) => `${name} joined`,
  userLeft: (name: string) => `${name} left`,
  backOnline: (count: number) => `Back online — ${count} changes synced`,
  nowViewer: "You're now a viewer on this board.",
  offlineAWhile:
    "You've been offline a while. Refresh when you're back online to make sure everything is up to date.",
} as const

/** FLOWS §6 — board management. */
export const boards = {
  defaultName: 'Untitled board',
  createFailed: "Couldn't create the board. Try again.",
  renameFailed: "Couldn't rename that board.",
  movedToTrash: 'Moved to trash',
  restored: 'Restored to your boards',
  deleteConfirmTitle: (name: string) => `Move '${name}' to trash?`,
  deleteConfirmBody:
    'Anyone working on this board will be disconnected. You can restore it for 30 days.',
  resetLinkConfirm: 'Anyone using the old link will lose access.',
  invitesSent: (count: number) => `Invites sent to ${count} people`,
  clipboardFallback: 'Press Cmd+C to copy',
} as const

/** FLOWS §11 — export. */
export const exportStrings = {
  nothingToExport: "There's nothing to export yet.",
  exported: 'Exported',
  scaledDown: 'Scaled down to fit the maximum export size.',
} as const

/**
 * FLOWS §3, §4, §5 — the auth screens.
 *
 * PRD §8 does not enumerate every label on every auth screen, so the strings
 * below that are not quoted in the specs are authored here to its tone rules
 * (§8.1): second person, present tense, never blame the user, every error
 * says what to do next. The ones that ARE specified — the validation table,
 * the login failure, the reset confirmation — are verbatim.
 */
export const auth = {
  signup: {
    title: 'Create your account',
    subtitle: 'Start drawing with your team in seconds.',
    submit: actions.createAccount,
    haveAccount: 'Already have an account?',
    logIn: 'Log in',
    google: 'Continue with Google',
    or: 'or',
    // FLOWS §3.1 branch 8b — inline on the email field, beside a route out.
    emailTaken: errors.emailAlreadyRegistered,
    genericFailure: errors.genericServerError,
    // FLOWS §3.1 step 5.
    checklist: {
      length: '8+ characters',
      letter: 'a letter',
      number: 'a number',
    },
    strength: {
      weak: 'Weak',
      fair: 'Fair',
      strong: 'Strong',
    },
  },

  login: {
    title: 'Welcome back',
    subtitle: 'Log in to get back to your boards.',
    submit: 'Log in',
    noAccount: "Don't have an account?",
    signUp: actions.signUp,
    forgot: 'Forgot password?',
    google: 'Continue with Google',
    // FLOWS §3.3 — the two OAuth failure banners.
    oauthCancelled: 'Google sign-in was cancelled.',
    oauthFailed: "Couldn't sign in with Google. Try email instead.",
    // FLOWS §5, shown after a successful reset.
    passwordUpdated: 'Password updated. Log in with your new password.',
    accountDisabled: 'This account has been disabled. Contact support.',
  },

  forgot: {
    title: 'Reset your password',
    subtitle: "Enter your email and we'll send you a link.",
    submit: 'Send reset link',
    // FLOWS §5 confirmation state, verbatim.
    sentTitle: 'Check your email',
    sentBody: (email: string) =>
      `If an account exists for ${email}, we've sent a reset link. It expires in 60 minutes.`,
    resend: 'Resend',
    resendIn: (seconds: number) => `Resend in ${seconds}s`,
    backToLogin: actions.backToLogin,
  },

  reset: {
    title: 'Choose a new password',
    submit: 'Update password',
    newPassword: 'New password',
    confirmPassword: 'Confirm password',
    mismatch: "Those passwords don't match.",
    checking: 'Checking your link…',
    // FLOWS §5 — one banner per token state.
    expired: 'That reset link expired. Request a new one.',
    invalid: "That reset link isn't valid. Request a new one.",
    used: 'That link was already used. Request a new one.',
  },

  callback: {
    signingIn: 'Signing you in…',
    // S-06 must never be visible for long — 5 s and 15 s thresholds.
    stillWorking: 'Still working…',
  },

  settings: {
    title: 'Settings',
    profile: 'Profile',
    displayName: 'Display name',
    email: 'Email',
    emailReadOnly: 'Your email address cannot be changed yet.',
    save: 'Save changes',
    saved: 'Saved',
    password: 'Password',
    currentPassword: 'Current password',
    newPassword: 'New password',
    setPassword: 'Set a password',
    setPasswordHint:
      'You signed in with Google. Set a password to also log in with your email.',
    changePassword: 'Change password',
    wrongCurrentPassword: "That password isn't right.",
    passwordChanged: 'Password updated. Log in again on your other devices.',
    dangerZone: 'Delete account',
    dangerBody: 'This removes your account and everything on it. This cannot be undone.',
    deleteConfirmLabel: (name: string) => `Type ${name} to confirm`,
    deleteMismatch: "That doesn't match your display name.",
    deleteSubmit: 'Delete my account',
    logOut: 'Log out',
  },

  // E-17 — the session expired while a board was open.
  sessionExpired: {
    message: 'Your session expired.',
    action: 'Log in again',
  },

  fields: {
    email: 'Email',
    password: 'Password',
    displayName: 'Your name',
  },
} as const

export const strings = {
  auth,
  errors,
  actions,
  emptyStates,
  validation,
  guest,
  states,
  presence,
  boards,
  export: exportStrings,
} as const

export type Strings = typeof strings
