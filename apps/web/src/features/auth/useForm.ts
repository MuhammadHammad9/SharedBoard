import { useCallback, useRef, useState } from 'react'

/**
 * Form validation timing — FLOWS §3.2, R-UI-058, R-UI-059.
 *
 * The rules are short and every one of them is a thing forms commonly get
 * wrong:
 *
 *   1. "Never validate a field before the user has left it for the first
 *       time. Validating on the first keystroke is hostile." Typing `p` into
 *       an email field and being told it is invalid is the app criticising
 *       an unfinished thought.
 *
 *   2. "Once a field has shown an error, re-validate on every keystroke so
 *       the error clears the moment it is fixed." Making someone blur again
 *       to be told they succeeded is the same hostility in reverse.
 *
 *   3. "Submit is never disabled for validation reasons — let the user click
 *       and show them what is wrong." A disabled button with no explanation
 *       is a dead end, and it is invisible to a screen reader.
 *
 * Rules 1 and 2 are the same state machine: a field validates once it has
 * been *touched*, where touched means blurred at least once OR submitted.
 * That single flag is the whole mechanism, and it is why this is a hook
 * rather than three booleans copied into five screens.
 */

export type Validator<T> = (values: T) => Partial<Record<keyof T & string, string>>

export interface FormState<T> {
  values: T
  /** Only for fields the user has left, or all of them after a submit. */
  errors: Partial<Record<keyof T & string, string>>
  touched: Partial<Record<keyof T & string, boolean>>
  submitting: boolean
  /** Above the submit button, focused on appearance — FLOWS §3.2. */
  formError: string | null
}

export interface FormApi<T> extends FormState<T> {
  setValue: <K extends keyof T & string>(field: K, value: T[K]) => void
  setValues: (patch: Partial<T>) => void
  handleBlur: (field: keyof T & string) => void
  setFormError: (message: string | null) => void
  /** Server-side field errors, e.g. 409 on email — FLOWS §3.1 branch 8b/8c. */
  setFieldError: (field: keyof T & string, message: string | null) => void
  submit: (
    onValid: (values: T) => Promise<void>,
  ) => (e?: { preventDefault?: () => void }) => void
  reset: (values?: Partial<T>) => void
  /** True when nothing is wrong — used for a checklist, never to disable submit. */
  isValid: boolean
}

export function useForm<T extends Record<string, unknown>>(
  initial: T,
  validate: Validator<T>,
): FormApi<T> {
  const [values, setValuesState] = useState<T>(initial)
  const [touched, setTouched] = useState<FormState<T>['touched']>({})
  const [serverErrors, setServerErrors] = useState<FormState<T>['errors']>({})
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const validateRef = useRef(validate)
  validateRef.current = validate

  const allErrors = validateRef.current(values)

  /*
   * The visibility filter — rules 1 and 2 in one expression.
   *
   * An error exists in `allErrors` from the first keystroke, but it is only
   * SHOWN once the field is touched. After that it updates live, because
   * `allErrors` is recomputed on every render.
   */
  const errors: FormState<T>['errors'] = {}
  for (const key of Object.keys(allErrors) as (keyof T & string)[]) {
    if (touched[key]) errors[key] = allErrors[key]
  }
  // A server error outranks a client one: the client cannot know an email is
  // already registered, and that message must not be overwritten by a
  // format check that passes.
  for (const key of Object.keys(serverErrors) as (keyof T & string)[]) {
    const message = serverErrors[key]
    if (message) errors[key] = message
  }

  const setValue = useCallback<FormApi<T>['setValue']>((field, value) => {
    setValuesState(prev => ({ ...prev, [field]: value }))
    // Any edit clears that field's SERVER error. The value the server
    // rejected no longer exists, so the message no longer applies.
    setServerErrors(prev => (prev[field] ? { ...prev, [field]: undefined } : prev))
  }, [])

  const setValues = useCallback((patch: Partial<T>) => {
    setValuesState(prev => ({ ...prev, ...patch }))
  }, [])

  const handleBlur = useCallback((field: keyof T & string) => {
    setTouched(prev => (prev[field] ? prev : { ...prev, [field]: true }))
  }, [])

  const setFieldError = useCallback<FormApi<T>['setFieldError']>((field, message) => {
    setServerErrors(prev => ({ ...prev, [field]: message ?? undefined }))
    // Touch it too, or a server error on a never-blurred field stays hidden.
    setTouched(prev => ({ ...prev, [field]: true }))
  }, [])

  const submit = useCallback<FormApi<T>['submit']>(
    onValid => (event?: { preventDefault?: () => void }) => {
      event?.preventDefault?.()
      setFormError(null)

      // Submitting touches everything, so a field the user tabbed straight
      // past still shows its error rather than failing silently.
      const nextTouched: FormState<T>['touched'] = {}
      for (const key of Object.keys(values) as (keyof T & string)[])
        nextTouched[key] = true
      setTouched(nextTouched)

      const problems = validateRef.current(values)
      if (Object.values(problems).some(Boolean)) return

      setSubmitting(true)
      void onValid(values).finally(() => setSubmitting(false))
    },
    [values],
  )

  const reset = useCallback(
    (next?: Partial<T>) => {
      setValuesState({ ...initial, ...next })
      setTouched({})
      setServerErrors({})
      setFormError(null)
    },
    [initial],
  )

  return {
    values,
    errors,
    touched,
    submitting,
    formError,
    setValue,
    setValues,
    handleBlur,
    setFormError,
    setFieldError,
    submit,
    reset,
    isValid: !Object.values(allErrors).some(Boolean),
  }
}
