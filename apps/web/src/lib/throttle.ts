/**
 * Leading-and-trailing throttle — TRD §10.3.
 *
 * Both edges, and the trailing one is the half that matters here. A
 * leading-only throttle drops the LAST call of a burst, so a cursor that stops
 * moving mid-gesture leaves everyone else's screen showing where it was 50 ms
 * before the user let go — a pointer permanently a few pixels off its true target.
 *
 * The first call in a quiet period fires immediately, so the very first cursor
 * move after a pause is not delayed by the interval.
 */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs: number,
  now: () => number = Date.now,
): ((...args: A) => void) & { cancel: () => void; flush: () => void } {
  let lastRun = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: A | null = null

  const run = (args: A) => {
    lastRun = now()
    pending = null
    fn(...args)
  }

  const throttled = (...args: A) => {
    const elapsed = now() - lastRun
    if (elapsed >= intervalMs) {
      run(args)
      return
    }
    // Inside the window: remember only the LATEST arguments. A cursor's
    // intermediate positions during a 50 ms window are worthless — only where
    // it ended up matters.
    pending = args
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      if (pending) run(pending)
    }, intervalMs - elapsed)
  }

  throttled.cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    pending = null
  }

  throttled.flush = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (pending) run(pending)
  }

  return throttled
}
