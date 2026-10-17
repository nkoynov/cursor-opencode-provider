import { processShared } from "./process-shared.js"

/** A host tool may keep its Run open this long from its own start. */
export const RUNNING_TOOL_CAP_MS = 4 * 60 * 60 * 1_000

type RunningTool = { sessionId: string; startedAt: number }

/**
 * Everything the tracker knows, as plain data. The plugin that receives host
 * events and the provider that holds the Run can be different module copies
 * (OpenCode 2 loads one per location), so the process-wide tracker keeps this
 * in `processShared`: parent links, activity and prompts must all be seen by
 * the copy that renews the Run's lease.
 */
export type SessionActivityState = {
  parentBySession: Map<string, string>
  lastActivityBySession: Map<string, number>
  /** Open host prompts: `${sessionId}\0${requestId}` → session id and when it opened. */
  openPrompts: Map<string, { sessionId: string; openedAt: number }>
  /** `${sessionId}\0${callId}` → when that host tool started running. */
  runningTools: Map<string, RunningTool>
}

export function createSessionActivityState(): SessionActivityState {
  return {
    parentBySession: new Map(),
    lastActivityBySession: new Map(),
    openPrompts: new Map(),
    runningTools: new Map(),
  }
}

export type SessionActivitySource = {
  lastActivityAt(sessionId: string): number | undefined
  /**
   * Latest 4h ceiling among host tools still running in this session or a
   * descendant. Undefined when none are still inside their own ceiling.
   */
  runningToolDeadline?(sessionId: string, now: number, toolCapMs: number): number | undefined
}

const MAX_ANCESTRY_DEPTH = 64
const MAX_TRACKED_SESSIONS = 1_024
const ACTIVITY_RETENTION_MS = 24 * 60 * 60 * 1_000

/**
 * Tracks OpenCode message progress and propagates it through subagent ancestry.
 *
 * A permission or question prompt the host has open is waiting on the user, not
 * stalled: the host emits no events until the user answers, so an open prompt
 * counts as current activity for its session and every ancestor.
 */
export class SessionActivityTracker implements SessionActivitySource {
  private readonly parentBySession: Map<string, string>
  private readonly lastActivityBySession: Map<string, number>
  private readonly openPrompts: Map<string, { sessionId: string; openedAt: number }>
  private readonly runningTools: Map<string, RunningTool>

  constructor(state: SessionActivityState = createSessionActivityState()) {
    this.parentBySession = state.parentBySession
    this.lastActivityBySession = state.lastActivityBySession
    this.openPrompts = state.openPrompts
    this.runningTools = state.runningTools
  }

  linkSession(sessionId: string, parentId?: string): void {
    if (!sessionId) return
    this.prune(Date.now())
    if (parentId && parentId !== sessionId) this.parentBySession.set(sessionId, parentId)
    else this.parentBySession.delete(sessionId)

    const existing = this.lastActivityBySession.get(sessionId)
    if (existing !== undefined) this.recordActivity(sessionId, existing)
    this.prune(Date.now())
  }

  recordActivity(sessionId: string, at = Date.now()): void {
    if (!sessionId || !Number.isFinite(at)) return
    this.prune(at)
    const visited = new Set<string>()
    let current: string | undefined = sessionId
    for (let depth = 0; current && depth < MAX_ANCESTRY_DEPTH; depth++) {
      if (visited.has(current)) return
      visited.add(current)
      const previous = this.lastActivityBySession.get(current)
      if (previous === undefined || at > previous) {
        // Map insertion order is our least-recently-active eviction order.
        this.lastActivityBySession.delete(current)
        this.lastActivityBySession.set(current, at)
      }
      current = this.parentBySession.get(current)
    }
    this.prune(at)
  }

  lastActivityAt(sessionId: string): number | undefined {
    const now = Date.now()
    this.prune(now)
    if (this.awaitsUser(sessionId)) return now
    return this.lastActivityBySession.get(sessionId)
  }

  /** The host opened a permission or question prompt in `sessionId`. */
  openPrompt(sessionId: string, requestId: string, at = Date.now()): void {
    if (!sessionId || !requestId) return
    const key = `${sessionId}\0${requestId}`
    this.openPrompts.delete(key)
    this.openPrompts.set(key, { sessionId, openedAt: at })
    this.recordActivity(sessionId, at)
  }

  /** The prompt was answered, rejected or cancelled. */
  closePrompt(sessionId: string, requestId: string, at = Date.now()): void {
    if (!sessionId || !requestId) return
    this.openPrompts.delete(`${sessionId}\0${requestId}`)
    this.recordActivity(sessionId, at)
  }

  /**
   * The host started running this tool. A repeated start keeps the original
   * time so a later event cannot extend the 4h ceiling.
   */
  toolStarted(sessionId: string, callId: string, at = Date.now()): void {
    if (!sessionId || !callId || !Number.isFinite(at)) return
    const key = `${sessionId}\0${callId}`
    if (!this.runningTools.has(key)) this.runningTools.set(key, { sessionId, startedAt: at })
    this.recordActivity(sessionId, at)
  }

  /** Drop every running tool for this session. Activity history stays. */
  endRunningTools(sessionId: string, at = Date.now()): void {
    if (!sessionId) return
    let ended = false
    for (const [key, tool] of this.runningTools) {
      if (tool.sessionId !== sessionId) continue
      this.runningTools.delete(key)
      ended = true
    }
    if (ended) this.recordActivity(sessionId, at)
  }

  /** The host finished the tool. The normal inactivity cap applies from now. */
  toolEnded(sessionId: string, callId: string, at = Date.now()): void {
    if (!sessionId || !callId) return
    this.runningTools.delete(`${sessionId}\0${callId}`)
    this.recordActivity(sessionId, at)
  }

  runningToolDeadline(sessionId: string, now: number, toolCapMs: number): number | undefined {
    let deadline: number | undefined
    for (const tool of this.runningTools.values()) {
      if (!this.belongsTo(tool.sessionId, sessionId)) continue
      const cap = tool.startedAt + toolCapMs
      if (now >= cap) continue
      deadline = deadline === undefined ? cap : Math.max(deadline, cap)
    }
    return deadline
  }

  removeSession(sessionId: string): void {
    this.parentBySession.delete(sessionId)
    this.lastActivityBySession.delete(sessionId)
    for (const [key, prompt] of this.openPrompts) {
      if (prompt.sessionId === sessionId) this.openPrompts.delete(key)
    }
    this.clearRunningTools(sessionId)
  }

  clear(): void {
    this.parentBySession.clear()
    this.lastActivityBySession.clear()
    this.openPrompts.clear()
    this.runningTools.clear()
  }

  /** A prompt is open in `sessionId` or in one of its descendants. */
  private awaitsUser(sessionId: string): boolean {
    for (const prompt of this.openPrompts.values()) {
      let current: string | undefined = prompt.sessionId
      for (let depth = 0; current && depth < MAX_ANCESTRY_DEPTH; depth++) {
        if (current === sessionId) return true
        current = this.parentBySession.get(current)
      }
    }
    return false
  }

  private prune(now: number): void {
    const oldestAllowed = now - ACTIVITY_RETENTION_MS
    // A prompt whose reply never arrived must not hold a Run open forever.
    for (const [key, prompt] of this.openPrompts) {
      if (prompt.openedAt >= oldestAllowed) break
      this.openPrompts.delete(key)
    }
    while (this.openPrompts.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.openPrompts.keys().next().value as string | undefined
      if (!oldest) break
      this.openPrompts.delete(oldest)
    }
    for (const [sessionId, activityAt] of this.lastActivityBySession) {
      if (activityAt >= oldestAllowed) break
      this.lastActivityBySession.delete(sessionId)
      this.parentBySession.delete(sessionId)
    }
    while (this.lastActivityBySession.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.lastActivityBySession.keys().next().value as string | undefined
      if (!oldest) break
      this.lastActivityBySession.delete(oldest)
      this.parentBySession.delete(oldest)
    }
    while (this.parentBySession.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.parentBySession.keys().next().value as string | undefined
      if (!oldest) break
      this.parentBySession.delete(oldest)
    }
    for (const [key, tool] of this.runningTools) {
      if (tool.startedAt < oldestAllowed) this.runningTools.delete(key)
    }
    // A tool whose end event never arrived must not grow the map without bound.
    while (this.runningTools.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.runningTools.keys().next().value as string | undefined
      if (!oldest) break
      this.runningTools.delete(oldest)
    }
  }

  private belongsTo(toolSessionId: string, sessionId: string): boolean {
    let current: string | undefined = toolSessionId
    for (let depth = 0; current && depth < MAX_ANCESTRY_DEPTH; depth++) {
      if (current === sessionId) return true
      current = this.parentBySession.get(current)
    }
    return false
  }

  private clearRunningTools(sessionId: string): void {
    for (const [key, tool] of this.runningTools) {
      if (tool.sessionId === sessionId) this.runningTools.delete(key)
    }
  }
}

export const sessionActivity = new SessionActivityTracker(
  processShared("session-activity.v1", createSessionActivityState),
)

/**
 * Open or close a host prompt from an OpenCode event. OpenCode 1.x publishes
 * `permission.asked` / `permission.replied` and `question.asked` /
 * `question.replied` / `question.rejected` (older releases used
 * `permission.updated` and `permissionID`); OpenCode 2 publishes the same
 * permission events plus `form.created` / `form.replied` / `form.cancelled`.
 */
export function applyHostPromptEvent(
  tracker: SessionActivityTracker,
  type: unknown,
  payload: unknown,
): void {
  const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {}
  const text = (value: unknown) => typeof value === "string" ? value : ""
  switch (type) {
    case "permission.asked":
    case "permission.updated":
    case "question.asked":
      tracker.openPrompt(text(data.sessionID), text(data.id))
      break
    case "permission.replied":
    case "question.replied":
    case "question.rejected":
      tracker.closePrompt(text(data.sessionID), text(data.requestID) || text(data.permissionID))
      break
    case "form.created": {
      const form = data.form && typeof data.form === "object" ? data.form as Record<string, unknown> : {}
      tracker.openPrompt(text(form.sessionID), text(form.id))
      break
    }
    case "form.replied":
    case "form.cancelled":
      tracker.closePrompt(text(data.sessionID), text(data.id))
      break
  }
}

/**
 * A host tool that is actually running holds the Run past the inactivity cap.
 * OpenCode 1 reports that on the tool part (`running`, and not provider-executed).
 * OpenCode 2 reports it on `session.tool.called` when `executed` is not true.
 */
export function applyHostToolEvent(
  tracker: SessionActivityTracker,
  type: unknown,
  payload: unknown,
): void {
  const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {}
  const text = (value: unknown) => typeof value === "string" ? value : ""
  if (type === "message.part.updated") {
    const part = data.part && typeof data.part === "object" ? data.part as Record<string, unknown> : undefined
    if (!part || part.type !== "tool") return
    const sessionId = text(part.sessionID)
    const callId = text(part.callID) || text(part.callId)
    const state = part.state && typeof part.state === "object" ? part.state as Record<string, unknown> : undefined
    const metadata = part.metadata && typeof part.metadata === "object"
      ? part.metadata as Record<string, unknown>
      : undefined
    if (!sessionId || !callId || !state) return
    if (state.status === "running" && metadata?.providerExecuted !== true) tracker.toolStarted(sessionId, callId)
    else if (state.status === "completed" || state.status === "error") tracker.toolEnded(sessionId, callId)
    return
  }
  if (type === "session.tool.called") {
    const sessionId = text(data.sessionID)
    const callId = text(data.id) || text(data.callID)
    if (!sessionId || !callId || data.executed === true) return
    tracker.toolStarted(sessionId, callId)
    return
  }
  if (type === "session.tool.success" || type === "session.tool.failed") {
    const sessionId = text(data.sessionID)
    const callId = text(data.id) || text(data.callID)
    if (sessionId && callId) tracker.toolEnded(sessionId, callId)
    return
  }
  if (type === "session.idle") {
    const info = data.info && typeof data.info === "object" ? data.info as Record<string, unknown> : undefined
    const sessionId = text(data.sessionID) || text(info?.id)
    if (sessionId) tracker.endRunningTools(sessionId)
  }
}
