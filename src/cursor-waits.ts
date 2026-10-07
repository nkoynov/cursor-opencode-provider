import { trace } from "./debug.js"
import type { CursorSession } from "./session.js"

const AWAIT_TOOL_CALL = "await_tool_call"
/** Longest Cursor-side wait the stall watchdog honors. */
export const MAX_CURSOR_WAIT_MS = 60 * 60_000

/**
 * Cursor runs AwaitShell itself. With no shell to poll it sleeps for
 * `block_until_ms` and sends only heartbeats, which a stalled Run sends too, so
 * the semantic-progress deadline moves to the end of the wait plus the idle window.
 */
export function noteCursorWaitStarted(
  session: CursorSession,
  callId: string,
  variant: string,
  args: Record<string, unknown>,
): void {
  if (variant !== AWAIT_TOOL_CALL) return
  const blockMs = Number(args.block_until_ms)
  if (!Number.isFinite(blockMs) || blockMs <= 0) return
  const waitMs = Math.min(blockMs, MAX_CURSOR_WAIT_MS)
  const until = Date.now() + waitMs + session.policy.semanticIdleMs
  ;(session.cursorWaits ??= new Map()).set(callId, until)
  trace(`cursor wait: callId=${callId} blockUntilMs=${blockMs} — semantic deadline held for ${waitMs}ms`)
}

export function noteCursorWaitEnded(session: CursorSession, callId: string): void {
  session.cursorWaits?.delete(callId)
}

/** When the Run counts as stalled: the semantic deadline, or later while a Cursor-side wait runs. */
export function semanticDeadlineAt(session: CursorSession): number {
  let deadline = session.semanticDeadlineAt
  for (const until of session.cursorWaits?.values() ?? []) {
    if (until > deadline) deadline = until
  }
  return deadline
}
