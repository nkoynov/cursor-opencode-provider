import { afterEach, describe, expect, it } from "bun:test"
import { RUNNING_TOOL_CAP_MS, SessionActivityTracker } from "../src/activity.js"
import { attachSessionHeartbeat } from "../src/language-model.js"
import { ASK_QUESTION_RESULT_FIELD } from "../src/protocol/ask-question.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import {
  DEFAULT_CONTINUATION_POLICY,
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
    tracker.toolStarted("ses_main", `cursor_${session.sessionId}_87`, clock.now())

    clock.advance(20 * MINUTE)
    expect(manager.classify(session.sessionId, 87).kind).toBe("deliverable")

    tracker.toolEnded("ses_main", `cursor_${session.sessionId}_87`, clock.now())
    clock.advance(10 * MINUTE)
    expect(session.closed).toBe(true)
    expect(manager.classify(session.sessionId, 87)).toEqual({ kind: "terminal", reason: "hard-cap-expired" })
  })

  it("holds a finished parallel result while its sibling still runs", () => {
    const { clock, tracker, manager } = leaseFixture()
    const session = heldSession("ses_parallel")
    manager.registerPending(1, session, "read_result", "read")
    manager.registerPending(2, session, "shell_result", "shell")
    tracker.toolStarted("ses_parallel", `cursor_${session.sessionId}_2`, clock.now())

    clock.advance(30 * MINUTE)

    expect(session.closed).toBe(false)
    expect(manager.classify(session.sessionId, 1).kind).toBe("deliverable")
  })

  it("lets the Run go at the ceiling even if the tool never reports an end", () => {
    const { clock, tracker, manager } = leaseFixture()
    const session = heldSession("ses_hung")
    manager.registerPending(5, session, "mcp_result", "slow_mcp")
    tracker.toolStarted("ses_hung", `cursor_${session.sessionId}_5`, clock.now())

    clock.advance(RUNNING_TOOL_CAP_MS - 1)
    expect(session.closed).toBe(false)
    clock.advance(1)
    expect(session.closed).toBe(true)
  })

  it("keeps a configured hardCapMs longer than the ceiling", () => {
    const { clock, tracker, manager } = leaseFixture()
    const session = heldSession("ses_long_cap")
    const hardCapMs = RUNNING_TOOL_CAP_MS + 120 * MINUTE
    session.policy = { ...DEFAULT_CONTINUATION_POLICY, hardCapMs }
    manager.registerPending(6, session, "mcp_result", "slow_mcp")
    tracker.toolStarted("ses_long_cap", `cursor_${session.sessionId}_6`, clock.now())

    clock.advance(hardCapMs - 1)
    expect(session.closed).toBe(false)
    clock.advance(1)
    expect(session.closed).toBe(true)
  })

  it("ignores a running tool of another session", () => {
    const { clock, tracker, manager } = leaseFixture()
    const a = heldSession("ses_a")
    const b = heldSession("ses_b")
    manager.registerPending(1, a, "shell_result", "shell")
    manager.registerPending(1, b, "shell_result", "shell")
    tracker.toolStarted("ses_a", `cursor_${a.sessionId}_1`, clock.now())

    clock.advance(10 * MINUTE)

    expect(a.closed).toBe(false)
    expect(b.closed).toBe(true)
  })

  it("does not hold an exec Cursor aborted for the host's running tool", () => {
    const { clock, tracker, manager } = leaseFixture()
    const session = heldSession("ses_aborted")
    manager.registerPending(1, session, "shell_result", "shell")
    tracker.toolStarted("ses_aborted", `cursor_${session.sessionId}_1`, clock.now())
    clock.advance(20 * MINUTE)
    expect(session.closed).toBe(false)

    manager.markExecAborted(session, 1)
    clock.advance(10 * MINUTE)
    expect(session.closed).toBe(true)
  })

  it("keeps holding the Run for a running tool after Cursor aborts a sibling exec of its step", () => {
    const { clock, tracker, manager } = leaseFixture()
    const session = heldSession("ses_aborted_sibling")
    manager.registerPending(1, session, "shell_result", "shell")
    manager.registerPending(2, session, "shell_result", "shell")
    tracker.toolStarted("ses_aborted_sibling", `cursor_${session.sessionId}_2`, clock.now())
    manager.markExecAborted(session, 1)

    clock.advance(40 * MINUTE)
    expect(session.closed).toBe(false)
  })

  it("sees a tool the plugin's separate copy of the module recorded", async () => {
    const pluginCopy = await import(`../src/activity.js?copy=${Date.now()}`) as typeof import("../src/activity.js")
    const { sessionActivity } = await import("../src/activity.js")
    expect(pluginCopy.sessionActivity).not.toBe(sessionActivity)
    const running = () => sessionActivity.runningToolDeadline("ses_copy", Date.now(), RUNNING_TOOL_CAP_MS) !== undefined
    try {
      pluginCopy.sessionActivity.toolStarted("ses_copy", "cursor_copy_1")
      expect(running()).toBe(true)
      pluginCopy.sessionActivity.toolEnded("ses_copy", "cursor_copy_1")
      expect(running()).toBe(false)
    } finally {
      sessionActivity.clear()
    }
  })

  it("forgets running tools when their session's execution ends or the session is deleted", () => {
    const tracker = new SessionActivityTracker()
    const now = Date.now()
    tracker.toolStarted("ses_x", "cursor_s_1", now)
    tracker.toolStarted("ses_y", "cursor_s_2", now)
    tracker.endRunningTools("ses_x")
    expect(tracker.runningToolDeadline("ses_x", now, RUNNING_TOOL_CAP_MS)).toBeUndefined()
    expect(tracker.runningToolDeadline("ses_y", now, RUNNING_TOOL_CAP_MS)).toBe(now + RUNNING_TOOL_CAP_MS)
    tracker.removeSession("ses_y")
    expect(tracker.runningToolDeadline("ses_y", now, RUNNING_TOOL_CAP_MS)).toBeUndefined()
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

  it("names the execs Cursor still waits on, the ones the tool-call ordering holds back included", async () => {
    const writes: Uint8Array[] = []
    const session = heldSession("ses_beat", writes)
    sessionManager.registerPending(1, session, "shell_stream", "shell")
    sessionManager.registerPending(900_001, session, "todowrite", "todowrite", true)
    sessionManager.registerPending(3, session, ASK_QUESTION_RESULT_FIELD, "question")
    session.toolCallOrder = {
      calls: [],
      deferred: [{ execId: 2, mutating: false, read: { done: false, value: { flags: 0, payload: encodeMessage("AgentServerMessage", {}) } } }],
      progressAt: Date.now(),
    }
    session.policy = { ...DEFAULT_CONTINUATION_POLICY, heartbeatMs: 60_000 }
    live.push(session)
    attachSessionHeartbeat(session)

    for (let i = 0; i < 100 && writes.length < 2; i++) await Bun.sleep(50)
    session.heartbeatCancel?.()

    const messages = writes.map((frame) => decodeMessage<any>("AgentClientMessage", frame))
    expect(messages.slice(0, 2)).toEqual([
      { exec_client_control_message: { heartbeat: { id: 1 } } },
      { exec_client_control_message: { heartbeat: { id: 2 } } },
    ])
  }, 10_000)
})
