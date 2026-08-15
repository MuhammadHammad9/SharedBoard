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

export const strings = {
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
