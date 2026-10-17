import { afterEach, describe, expect, it, setSystemTime } from "bun:test"
import {
  applyHostPromptEvent,
  applyHostToolEvent,
  createSessionActivityState,
  RUNNING_TOOL_CAP_MS,
  SessionActivityTracker,
} from "../src/activity.js"

afterEach(() => setSystemTime())

describe("SessionActivityTracker retention", () => {
  it("evicts activity that is older than the retention window", () => {
    const tracker = new SessionActivityTracker()
    const now = Date.now()
    tracker.recordActivity("expired", now - 25 * 60 * 60 * 1_000)
    tracker.recordActivity("current", now)

    expect(tracker.lastActivityAt("expired")).toBeUndefined()
    expect(tracker.lastActivityAt("current")).toBe(now)
  })
})

describe("SessionActivityTracker open prompts", () => {
  it("keeps a session and its ancestors active while a prompt waits on the user", () => {
    const start = new Date("2026-10-09T00:00:00Z")
    setSystemTime(start)
    const tracker = new SessionActivityTracker()
    tracker.linkSession("child", "parent")
    tracker.openPrompt("child", "per_1")

    const later = new Date(start.getTime() + 21 * 60_000)
    setSystemTime(later)
    expect(tracker.lastActivityAt("child")).toBe(later.getTime())
    expect(tracker.lastActivityAt("parent")).toBe(later.getTime())
    expect(tracker.lastActivityAt("unrelated")).toBeUndefined()

    tracker.closePrompt("child", "per_1")
    setSystemTime(new Date(later.getTime() + 60_000))
    expect(tracker.lastActivityAt("parent")).toBe(later.getTime())
  })

  it("stays active until every open prompt of the session closes", () => {
    const tracker = new SessionActivityTracker()
    tracker.openPrompt("s", "a")
    tracker.openPrompt("s", "b")
    tracker.closePrompt("s", "a")
    const at = Date.now() + 60_000
    setSystemTime(new Date(at))
    expect(tracker.lastActivityAt("s")).toBe(at)
  })

  it("forgets prompts of a removed session and prompts older than the retention window", () => {
    const tracker = new SessionActivityTracker()
    const start = Date.now()
    tracker.openPrompt("removed", "a")
    tracker.removeSession("removed")
    tracker.openPrompt("stale", "b", start)
    setSystemTime(new Date(start + 25 * 60 * 60 * 1_000))
    expect(tracker.lastActivityAt("removed")).toBeUndefined()
    expect(tracker.lastActivityAt("stale")).toBeUndefined()
  })

  it("ignores prompts without a session or request id", () => {
    const tracker = new SessionActivityTracker()
    tracker.openPrompt("", "a")
    tracker.openPrompt("s", "")
    expect(tracker.lastActivityAt("s")).toBeUndefined()
  })
})

describe("applyHostPromptEvent", () => {
  const openThenClose = (opened: [string, unknown], closed: [string, unknown]) => {
    const tracker = new SessionActivityTracker()
    const start = Date.now()
    applyHostPromptEvent(tracker, ...opened)
    setSystemTime(new Date(start + 3_600_000))
    const whileOpen = tracker.lastActivityAt("s")
    applyHostPromptEvent(tracker, ...closed)
    setSystemTime(new Date(start + 7_200_000))
    return { whileOpen, afterClose: tracker.lastActivityAt("s"), openedAt: start + 3_600_000 }
  }

  for (const [label, opened, closed] of [
    ["OpenCode permission", ["permission.asked", { id: "per_1", sessionID: "s" }], ["permission.replied", { sessionID: "s", requestID: "per_1", reply: "once" }]],
    ["legacy OpenCode permission", ["permission.updated", { id: "per_1", sessionID: "s" }], ["permission.replied", { sessionID: "s", permissionID: "per_1", response: "once" }]],
    ["OpenCode question reply", ["question.asked", { id: "que_1", sessionID: "s" }], ["question.replied", { sessionID: "s", requestID: "que_1" }]],
    ["OpenCode question rejection", ["question.asked", { id: "que_1", sessionID: "s" }], ["question.rejected", { sessionID: "s", requestID: "que_1" }]],
    ["OpenCode 2 form reply", ["form.created", { form: { id: "frm_1", sessionID: "s" } }], ["form.replied", { id: "frm_1", sessionID: "s", answer: {} }]],
    ["OpenCode 2 form cancellation", ["form.created", { form: { id: "frm_1", sessionID: "s" } }], ["form.cancelled", { id: "frm_1", sessionID: "s" }]],
  ] as Array<[string, [string, unknown], [string, unknown]]>) {
    it(`holds and releases on ${label}`, () => {
      const { whileOpen, afterClose, openedAt } = openThenClose(opened, closed)
      expect(whileOpen).toBe(openedAt)
      expect(afterClose).toBe(openedAt)
    })
  }

  it("ignores unrelated events and malformed payloads", () => {
    const tracker = new SessionActivityTracker()
    applyHostPromptEvent(tracker, "message.updated", { id: "x", sessionID: "s" })
    applyHostPromptEvent(tracker, "permission.asked", undefined)
    applyHostPromptEvent(tracker, "form.created", { form: "nope" })
    expect(tracker.lastActivityAt("s")).toBeUndefined()
  })
})

describe("running host tools", () => {
  it("keeps the original start and the later tool's own ceiling", () => {
    const tracker = new SessionActivityTracker()
    tracker.linkSession("child", "parent")
    tracker.toolStarted("parent", "early", 1_000)
    tracker.toolStarted("parent", "early", 50_000)
    const cap = RUNNING_TOOL_CAP_MS
    expect(tracker.runningToolDeadline("parent", 1_000, cap)).toBe(1_000 + cap)
    tracker.toolStarted("child", "later", 3 * 60 * 60 * 1_000)
    const afterEarly = 1_000 + cap + 1
    expect(tracker.runningToolDeadline("parent", afterEarly, cap)).toBe(3 * 60 * 60 * 1_000 + cap)
    tracker.toolEnded("child", "later", afterEarly)
    expect(tracker.runningToolDeadline("parent", afterEarly, cap)).toBeUndefined()
    setSystemTime(new Date(afterEarly))
    expect(tracker.lastActivityAt("parent")).toBe(afterEarly)
  })

  it("starts from a running tool part and a host call, and stops when the session is idle", () => {
    const tracker = new SessionActivityTracker()
    const started = Date.now()
    applyHostToolEvent(tracker, "message.part.updated", {
      part: {
        type: "tool",
        sessionID: "s",
        callID: "call-1",
        state: { status: "running" },
        metadata: { providerExecuted: true },
      },
    })
    expect(tracker.runningToolDeadline("s", started, RUNNING_TOOL_CAP_MS)).toBeUndefined()
    applyHostToolEvent(tracker, "message.part.updated", {
      part: { type: "tool", sessionID: "s", callID: "call-1", state: { status: "running" } },
    })
    expect(tracker.runningToolDeadline("s", started, RUNNING_TOOL_CAP_MS)).toBeGreaterThan(started)
    applyHostToolEvent(tracker, "session.tool.called", { sessionID: "s", id: "call-2", executed: true })
    applyHostToolEvent(tracker, "session.tool.called", { sessionID: "s", id: "call-2", executed: false })
    applyHostToolEvent(tracker, "message.part.updated", {
      part: { type: "tool", sessionID: "s", callID: "call-1", state: { status: "completed" } },
    })
    expect(tracker.runningToolDeadline("s", Date.now(), RUNNING_TOOL_CAP_MS)).toBeTypeOf("number")
    applyHostToolEvent(tracker, "session.tool.success", { sessionID: "s", id: "call-2" })
    expect(tracker.runningToolDeadline("s", Date.now(), RUNNING_TOOL_CAP_MS)).toBeUndefined()
    applyHostToolEvent(tracker, "session.tool.called", { sessionID: "s", id: "call-3" })
    applyHostToolEvent(tracker, "session.idle", { sessionID: "s" })
    expect(tracker.runningToolDeadline("s", Date.now(), RUNNING_TOOL_CAP_MS)).toBeUndefined()
  })

  it("sees a child's running tool and open prompt from another module copy sharing the state", () => {
    const state = createSessionActivityState()
    // The plugin copy receives host events; the provider copy holds the parent's Run.
    const plugin = new SessionActivityTracker(state)
    const provider = new SessionActivityTracker(state)
    plugin.linkSession("child", "parent")
    applyHostToolEvent(plugin, "session.tool.called", { sessionID: "child", id: "call-1", executed: false })
    const now = Date.now()
    expect(provider.runningToolDeadline("parent", now, RUNNING_TOOL_CAP_MS)).toBeGreaterThan(now)
    applyHostToolEvent(plugin, "session.tool.success", { sessionID: "child", id: "call-1" })
    expect(provider.runningToolDeadline("parent", now, RUNNING_TOOL_CAP_MS)).toBeUndefined()

    setSystemTime(new Date(now + 60_000))
    applyHostPromptEvent(plugin, "permission.asked", { sessionID: "child", id: "perm-1" })
    setSystemTime(new Date(now + 120_000))
    expect(provider.lastActivityAt("parent")).toBe(now + 120_000)
  })
})
