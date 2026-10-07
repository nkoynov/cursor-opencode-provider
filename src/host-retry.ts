import { CursorProviderError } from "./errors.js"

type FinalFailure = { message: string; at: number }

// OpenCode 2 retries a failed step up to 10 times (~90 s) unless the error is classified as
// deterministic, and it classifies `code: "resource_exhausted"` as retryable whatever the message
// says. Its plugin `session.retry` hook is the only way to say no, and the plugin that registers
// it can be another copy of this module than the model's.
const FINAL_FAILURES = Symbol.for("cursor-opencode-provider.final-failures")
const globals = globalThis as typeof globalThis & { [FINAL_FAILURES]?: Map<string, FinalFailure> }
const finalFailures = globals[FINAL_FAILURES] ??= new Map()

export const FINAL_FAILURE_TTL_MS = 60_000
const MAX_FINAL_FAILURES = 256

/** A failure that another attempt cannot fix: Cursor refused the account, or had no capacity through the provider's own backoff. */
export function isFinalForHost(error: unknown): error is CursorProviderError {
  return error instanceof CursorProviderError && error.hostRetryUseless === true
}

/** Remember that the error ending this OpenCode session's step must not be retried by OpenCode. */
export function recordFinalFailure(openCodeSessionId: string | undefined, error: unknown, now = Date.now()): void {
  if (!openCodeSessionId || !isFinalForHost(error) || !error.message.trim()) return
  finalFailures.delete(openCodeSessionId)
  finalFailures.set(openCodeSessionId, { message: error.message.trim(), at: now })
  for (const [id, failure] of finalFailures) {
    if (finalFailures.size <= MAX_FINAL_FAILURES && now - failure.at <= FINAL_FAILURE_TTL_MS) break
    finalFailures.delete(id)
  }
}

/** True once for the step failure recorded with this message; OpenCode should then not retry. */
export function takeFinalFailure(openCodeSessionId: string, message: string | undefined, now = Date.now()): boolean {
  const failure = finalFailures.get(openCodeSessionId)
  if (!failure) return false
  if (now - failure.at > FINAL_FAILURE_TTL_MS) {
    finalFailures.delete(openCodeSessionId)
    return false
  }
  if (!message?.includes(failure.message)) return false
  finalFailures.delete(openCodeSessionId)
  return true
}

export function resetFinalFailuresForTests(): void {
  finalFailures.clear()
}
