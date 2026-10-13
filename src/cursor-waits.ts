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

/** Longest a Run may go on heartbeats alone, the time a model may take to write a tool call's input. */
export const MAX_TOOL_INPUT_MS = 15 * 60_000

/** Start of the current stretch of heartbeats: the last other frame, or the last progress the Run made otherwise. */
function heartbeatsSince(session: CursorSession): number {
  return Math.max(session.lastNonHeartbeatAt ?? 0, session.semanticDeadlineAt - session.policy.semanticIdleMs)
}

/**
 * Cursor sends a tool call only once the model has written all of its input, for minutes on a large file,
 * and what it sends meanwhile depends on the model and tool: `partial_tool_call` then heartbeats or
 * `tool_call_delta` (Claude, GPT with Cursor's edit tool), `token_delta` alone (GPT with an MCP tool), or
 * heartbeats alone (Grok). Cursor CLI keeps a Run while any frame arrives, so heartbeats keep it here too,
 * up to MAX_TOOL_INPUT_MS after the last other frame; a silent stream still stalls after the idle window.
 */
export function noteRunFrame(session: CursorSession, update: Record<string, unknown> | undefined): void {
  const now = Date.now()
  const previous = session.lastFrameAt
  session.lastFrameAt = now
  if (!update?.heartbeat) {
    session.lastNonHeartbeatAt = now
    return
  }
  const idleMs = session.policy.semanticIdleMs
  const since = heartbeatsSince(session)
  if (previous !== undefined && previous - since <= idleMs && now - since > idleMs) {
    trace(`stream hold: heartbeats only for ${now - since}ms — Run kept while frames arrive, up to ${MAX_TOOL_INPUT_MS}ms`)
  }
}

/** When the Run counts as stalled: the semantic deadline, or later while a Cursor-side wait runs or frames keep arriving. */
export function semanticDeadlineAt(session: CursorSession): number {
  let deadline = session.semanticDeadlineAt
  for (const until of session.cursorWaits?.values() ?? []) {
    if (until > deadline) deadline = until
  }
  if (session.lastFrameAt !== undefined) {
    const until = Math.min(session.lastFrameAt + session.policy.semanticIdleMs, heartbeatsSince(session) + MAX_TOOL_INPUT_MS)
    if (until > deadline) deadline = until
  }
  return deadline
}
