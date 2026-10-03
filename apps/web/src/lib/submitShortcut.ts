/**
 * Cmd/Ctrl+Enter submits the form that has focus — PRD Appendix A ("Forms").
 *
 * One listener for the whole app rather than one per form, so every form —
 * auth, invite, rename — gets it without opting in. `requestSubmit` runs the
 * form's own validation and submit handler, exactly as clicking its submit
 * button would; a form with no enabled submit button is left alone.
 */
let installed = false

export function installSubmitShortcut(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    const form = (event.target as HTMLElement | null)?.closest?.('form')
    if (!form) return
    const submit = form.querySelector<HTMLButtonElement>(
      'button[type="submit"]:not([disabled]), button:not([type]):not([disabled])',
    )
    if (!submit) return
    event.preventDefault()
    form.requestSubmit(submit)
  })
}
