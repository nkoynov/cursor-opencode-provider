export type SessionActivitySource = {
  lastActivityAt(sessionId: string): number | undefined
  /** Whether the host reports this tool call as started and not yet finished. */
  isToolRunning?(toolCallId: string): boolean
}

const MAX_ANCESTRY_DEPTH = 64
const MAX_TRACKED_SESSIONS = 1_024
const ACTIVITY_RETENTION_MS = 24 * 60 * 60 * 1_000

/** Tracks OpenCode message progress and propagates it through subagent ancestry. */
export class SessionActivityTracker implements SessionActivitySource {
  private readonly parentBySession = new Map<string, string>()
  private readonly lastActivityBySession = new Map<string, number>()

  constructor(private readonly sessionByRunningTool = new Map<string, string>()) {}

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
    this.prune(Date.now())
    return this.lastActivityBySession.get(sessionId)
  }

  removeSession(sessionId: string): void {
    this.parentBySession.delete(sessionId)
    this.lastActivityBySession.delete(sessionId)
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
  }

  private prune(now: number): void {
    const oldestAllowed = now - ACTIVITY_RETENTION_MS
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
// of this module (one per Location), so the plugin's tool events must reach
// the copy that holds the Run.
const RUNNING_TOOLS = Symbol.for("cursor-opencode-provider.running-tools")
const globals = globalThis as typeof globalThis & { [RUNNING_TOOLS]?: Map<string, string> }

export const sessionActivity = new SessionActivityTracker(globals[RUNNING_TOOLS] ??= new Map())
