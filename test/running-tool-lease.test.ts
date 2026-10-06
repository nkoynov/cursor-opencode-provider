import { afterEach, describe, expect, it } from "bun:test"
import { SessionActivityTracker } from "../src/activity.js"
import { attachSessionHeartbeat, pendingExecIds } from "../src/language-model.js"
import { ASK_QUESTION_RESULT_FIELD } from "../src/protocol/ask-question.js"
import { decodeMessage } from "../src/protocol/messages.js"
import {
  DEFAULT_CONTINUATION_POLICY,
  RUNNING_TOOL_LEASE_CEILING_MS,
  SessionManager,
  sessionManager,
  type CursorSession,
} from "../src/session.js"

let seq = 0
function heldSession(openCodeSessionId: string, writes: Uint8Array[] = []): CursorSession {
  seq++
  return {
    sessionId: `lease_${seq}`,
    conversationId: `conv_${seq}`,
    openCodeSessionId,
    stream: {
      write(frame: Uint8Array) { writes.push(frame); return true },
      end() {},
      destroy() {},
      isClosed: () => false,
      frames: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
      onTerminal() { return () => {} },
    } as unknown as CursorSession["stream"],
    frames: { next: async () => ({ done: true, value: undefined }) } as CursorSession["frames"],
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolDescriptors: [],
    requestContext: {},
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: false,
    heartbeat: null,
  } as unknown as CursorSession
}

function fakeClock(start = Date.now()) {
  let now = start
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = []
  return {
    now: () => now,
    setTimer: (fn: () => void, delayMs: number) => {
      const timer = { at: now + delayMs, fn, live: true }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (timer: ReturnType<typeof setTimeout>) => { (timer as unknown as { live: boolean }).live = false },
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = timers.filter((timer) => timer.live && timer.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        now = due.at
        due.live = false
        due.fn()
      }
      now = target
    },
  }
}

function leaseFixture() {
  const clock = fakeClock()
  const tracker = new SessionActivityTracker()
  const manager = new SessionManager({ ...clock, activitySource: tracker })
  return { clock, tracker, manager }
}

const MINUTE = 60_000

describe("held Run lease while the host still runs a tool", () => {
  it("outlives hardCapMs while the tool runs silently, then applies the normal cap", () => {
    const { clock, tracker, manager } = leaseFixture()
    const session = heldSession("ses_main")
    manager.registerPending(87, session, "shell_result", "shell")
    tracker.toolStarted("ses_main", `cursor_${session.sessionId}_87`)

    clock.advance(20 * MINUTE)
    expect(manager.classify(session.sessionId, 87).kind).toBe("deliverable")

    tracker.toolEnded(`cursor_${session.sessionId}_87`)
    clock.advance(10 * MINUTE)
    expect(session.closed).toBe(true)
    expect(manager.classify(session.sessionId, 87)).toEqual({ kind: "terminal", reason: "hard-cap-expired" })
  })

  it("holds a finished parallel result while its sibling still runs", () => {
    const { clock, tracker, manager } = leaseFixture()
    const session = heldSession("ses_parallel")
    manager.registerPending(1, session, "read_result", "read")
    manager.registerPending(2, session, "shell_result", "shell")
    tracker.toolStarted("ses_parallel", `cursor_${session.sessionId}_2`)

    clock.advance(30 * MINUTE)

    expect(session.closed).toBe(false)
    expect(manager.classify(session.sessionId, 1).kind).toBe("deliverable")
  })

  it("lets the Run go at the ceiling even if the tool never reports an end", () => {
    const { clock, tracker, manager } = leaseFixture()
    const session = heldSession("ses_hung")
    manager.registerPending(5, session, "mcp_result", "slow_mcp")
    tracker.toolStarted("ses_hung", `cursor_${session.sessionId}_5`)

    clock.advance(RUNNING_TOOL_LEASE_CEILING_MS - 1)
    expect(session.closed).toBe(false)
    clock.advance(1)
    expect(session.closed).toBe(true)
  })

  it("keeps a configured hardCapMs longer than the ceiling", () => {
    const { clock, tracker, manager } = leaseFixture()
    const session = heldSession("ses_long_cap")
    const hardCapMs = RUNNING_TOOL_LEASE_CEILING_MS + 120 * MINUTE
    session.policy = { ...DEFAULT_CONTINUATION_POLICY, hardCapMs }
    manager.registerPending(6, session, "mcp_result", "slow_mcp")
    tracker.toolStarted("ses_long_cap", `cursor_${session.sessionId}_6`)

    clock.advance(hardCapMs - 1)
    expect(session.closed).toBe(false)
    clock.advance(1)
    expect(session.closed).toBe(true)
  })

  it("ignores a running tool of another Run with the same exec id", () => {
    const { clock, tracker, manager } = leaseFixture()
    const a = heldSession("ses_a")
    const b = heldSession("ses_b")
    manager.registerPending(1, a, "shell_result", "shell")
    manager.registerPending(1, b, "shell_result", "shell")
    tracker.toolStarted("ses_a", `cursor_${a.sessionId}_1`)

    clock.advance(10 * MINUTE)

    expect(a.closed).toBe(false)
    expect(b.closed).toBe(true)
  })

  it("sees a tool the plugin's separate copy of the module recorded", async () => {
    const pluginCopy = await import(`../src/activity.js?copy=${Date.now()}`) as typeof import("../src/activity.js")
    const { sessionActivity } = await import("../src/activity.js")
    expect(pluginCopy.sessionActivity).not.toBe(sessionActivity)
    try {
      pluginCopy.sessionActivity.toolStarted("ses_copy", "cursor_copy_1")
      expect(sessionActivity.isToolRunning("cursor_copy_1")).toBe(true)
      pluginCopy.sessionActivity.toolEnded("cursor_copy_1")
      expect(sessionActivity.isToolRunning("cursor_copy_1")).toBe(false)
    } finally {
      sessionActivity.clear()
    }
  })

  it("forgets running tools when their session's execution ends or the session is deleted", () => {
    const tracker = new SessionActivityTracker()
    tracker.toolStarted("ses_x", "cursor_s_1")
    tracker.toolStarted("ses_y", "cursor_s_2")
    tracker.endSessionTools("ses_x")
    expect(tracker.isToolRunning("cursor_s_1")).toBe(false)
    expect(tracker.isToolRunning("cursor_s_2")).toBe(true)
    tracker.removeSession("ses_y")
    expect(tracker.isToolRunning("cursor_s_2")).toBe(false)
  })
})

describe("exec heartbeats", () => {
  const live: CursorSession[] = []
  afterEach(() => {
    for (const session of live.splice(0)) {
      session.heartbeatCancel?.()
      if (!session.closed) sessionManager.close(session, "ordinary-cleanup")
    }
  })

  it("names only the execs Cursor still waits on", () => {
    const session = heldSession("ses_ids")
    sessionManager.registerPending(1, session, "shell_stream", "shell")
    sessionManager.registerPending(2, session, "read_result", "read")
    sessionManager.registerPending(900_001, session, "todowrite", "todowrite", true)
    sessionManager.registerPending(3, session, ASK_QUESTION_RESULT_FIELD, "question")
    live.push(session)
    expect(pendingExecIds(session)).toEqual([1, 2])
  })

  it("follows each client heartbeat with one per pending exec", async () => {
    const writes: Uint8Array[] = []
    const session = heldSession("ses_beat", writes)
    sessionManager.registerPending(7, session, "shell_stream", "shell")
    sessionManager.registerPending(900_002, session, "todowrite", "todowrite", true)
    session.policy = { ...session.policy, heartbeatMs: 10 }
    live.push(session)
    attachSessionHeartbeat(session)

    for (let i = 0; i < 50 && writes.length < 4; i++) await Bun.sleep(10)
    session.heartbeatCancel?.()

    const messages = writes.map((frame) => decodeMessage<any>("AgentClientMessage", frame))
    expect(messages.slice(0, 4)).toEqual([
      { client_heartbeat: {} },
      { exec_client_control_message: { heartbeat: { id: 7 } } },
      { client_heartbeat: {} },
      { exec_client_control_message: { heartbeat: { id: 7 } } },
    ])
  })
})
