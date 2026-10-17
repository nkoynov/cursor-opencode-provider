import { trace } from "./debug.js"
import type { CursorSession } from "./session.js"

const AWAIT_TOOL_CALL = "await_tool_call"

/**
 * Cursor runs AwaitShell itself and sends only heartbeats while it waits, so a
 * quiet Run then is not a stall the tool-call ordering should break up.
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
  ;(session.cursorWaits ??= new Set()).add(callId)
  trace(`cursor wait: callId=${callId} blockUntilMs=${blockMs}`)
}

export function noteCursorWaitEnded(session: CursorSession, callId: string): void {
  session.cursorWaits?.delete(callId)
}
