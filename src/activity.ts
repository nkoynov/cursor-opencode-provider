export type SessionActivitySource = {
  lastActivityAt(sessionId: string): number | undefined
  /** Whether the host reports this tool call as started and not yet finished. */
  isToolRunning?(toolCallId: string): boolean
}

type OpenPrompt = { sessionId: string; openedAt: number }

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
  private readonly parentBySession = new Map<string, string>()
  private readonly lastActivityBySession = new Map<string, number>()
  constructor(
    private readonly sessionByRunningTool = new Map<string, string>(),
    /** Open host prompts: `${sessionId}\0${requestId}` → session id and when it opened. */
    private readonly openPrompts = new Map<string, OpenPrompt>(),
  ) {}

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

  removeSession(sessionId: string): void {
    this.parentBySession.delete(sessionId)
    this.lastActivityBySession.delete(sessionId)
    for (const [key, prompt] of this.openPrompts) {
      if (prompt.sessionId === sessionId) this.openPrompts.delete(key)
    }
    this.endSessionTools(sessionId)
  }

  toolStarted(sessionId: string, toolCallId: string): void {
    if (!sessionId || !toolCallId) return
    this.sessionByRunningTool.delete(toolCallId)
    this.sessionByRunningTool.set(toolCallId, sessionId)
    while (this.sessionByRunningTool.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.sessionByRunningTool.keys().next().value as string | undefined
      if (!oldest) break
      this.sessionByRunningTool.delete(oldest)
    }
  }

  toolEnded(toolCallId: string): void {
    this.sessionByRunningTool.delete(toolCallId)
  }

  /** The session's execution ended, so none of its tools still runs. */
  endSessionTools(sessionId: string): void {
    for (const [toolCallId, owner] of this.sessionByRunningTool) {
      if (owner === sessionId) this.sessionByRunningTool.delete(toolCallId)
    }
  }

  isToolRunning(toolCallId: string): boolean {
    return this.sessionByRunningTool.has(toolCallId)
  }

  clear(): void {
    this.parentBySession.clear()
    this.lastActivityBySession.clear()
    this.sessionByRunningTool.clear()
    this.openPrompts.clear()
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
  }
}

// OpenCode 2 can evaluate the plugin and the AI SDK model as separate copies
// of this module (one per Location), so the plugin's tool and prompt events
// must reach the copy that holds the Run.
const RUNNING_TOOLS = Symbol.for("cursor-opencode-provider.running-tools")
const OPEN_PROMPTS = Symbol.for("cursor-opencode-provider.open-prompts")
const globals = globalThis as typeof globalThis & {
  [RUNNING_TOOLS]?: Map<string, string>
  [OPEN_PROMPTS]?: Map<string, OpenPrompt>
}

export const sessionActivity = new SessionActivityTracker(
  globals[RUNNING_TOOLS] ??= new Map(),
  globals[OPEN_PROMPTS] ??= new Map(),
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
