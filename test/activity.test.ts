import { afterEach, describe, expect, it, setSystemTime } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { applyHostPromptEvent, SessionActivityTracker, sessionActivity } from "../src/activity.js"

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

describe("sessionActivity across module copies", () => {
  it("shares one state, so a child's prompt seen by the plugin's copy holds the parent Run in the model's copy", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-activity-copies-"))
    const load = async (name: string): Promise<typeof import("../src/activity.js")> => {
      fs.copyFileSync(new URL("../src/activity.ts", import.meta.url), path.join(dir, `${name}.ts`))
      return await import(path.join(dir, `${name}.ts`))
    }
    const start = Date.now()
    try {
      const plugin = await load("plugin")
      const model = await load("model")
      expect(plugin.SessionActivityTracker).not.toBe(model.SessionActivityTracker)
      expect(plugin.sessionActivity).not.toBe(model.sessionActivity)
      plugin.sessionActivity.linkSession("child-copy", "parent-copy")
      plugin.applyHostPromptEvent(plugin.sessionActivity, "permission.asked", { id: "per_copy", sessionID: "child-copy" })
      setSystemTime(new Date(start + 3_600_000))
      expect(model.sessionActivity.lastActivityAt("parent-copy")).toBe(start + 3_600_000)
    } finally {
      sessionActivity.clear()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
