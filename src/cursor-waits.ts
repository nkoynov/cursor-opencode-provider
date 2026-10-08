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

/** Longest a tool call's input may take to arrive after Cursor announced the call. */
export const MAX_TOOL_INPUT_MS = 15 * 60_000

function callIdOf(update: unknown): string {
  const id = (update as { call_id?: unknown } | undefined)?.call_id
  return typeof id === "string" ? id : ""
}

/**
 * Cursor holds a tool call's input until the model has written all of it: after `partial_tool_call` it
 * sends only heartbeats, for minutes on a large file, then the whole input at once. Cursor CLI keeps
 * such a Run while heartbeats arrive, so while an announced call has not started only a silent stream
 * stalls. Calls are tracked one by one: a parallel step announces the next call before the previous
 * one's exec.
 */
export function noteRunFrame(session: CursorSession, update: Record<string, unknown> | undefined): void {
  const now = Date.now()
  session.lastFrameAt = now
  if (update?.partial_tool_call) {
    const callId = callIdOf(update.partial_tool_call)
    const composing = session.composingToolCalls ??= new Map()
    if (!composing.has(callId)) {
      composing.set(callId, now)
      trace(`tool input: Cursor announced call ${callId || "-"} — semantic deadline held while frames arrive, up to ${MAX_TOOL_INPUT_MS}ms`)
    }
  } else if (update?.tool_call_started || update?.tool_call_completed) {
    session.composingToolCalls?.delete(callIdOf(update.tool_call_started ?? update.tool_call_completed))
  } else if (update?.step_completed || update?.turn_ended) {
    session.composingToolCalls?.clear()
  }
}

/** When the Run counts as stalled: the semantic deadline, or later while a Cursor-side wait runs or a tool input is written. */
export function semanticDeadlineAt(session: CursorSession): number {
  let deadline = session.semanticDeadlineAt
  for (const until of session.cursorWaits?.values() ?? []) {
    if (until > deadline) deadline = until
  }
  if (session.lastFrameAt !== undefined) {
    for (const since of session.composingToolCalls?.values() ?? []) {
      const until = Math.min(session.lastFrameAt + session.policy.semanticIdleMs, since + MAX_TOOL_INPUT_MS)
      if (until > deadline) deadline = until
    }
  }
  return deadline
}
