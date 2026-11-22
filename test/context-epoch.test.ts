import { describe, expect, it, beforeEach } from "bun:test"
import {
  admitContextEpoch,
  appendMidConversationMessage,
  clearContextEpoch,
  endContextEpoch,
  getContextEpoch,
  peekContextEpoch,
  resetContextEpochsForTests,
  restoreContextEpoch,
} from "../src/context/epoch.js"
import { transferFrozenRequestContext, resetFrozenRequestContextsForTests } from "../src/context/frozen.js"

describe("context epoch (V2-style)", () => {
  beforeEach(() => {
    resetContextEpochsForTests()
    resetFrozenRequestContextsForTests()
  })

  it("initializes a frozen baseline on first seed", () => {
    const result = admitContextEpoch({
      conversationId: "conv-1",
      hasCheckpoint: false,
      hostSystem: "You are build.",
      guidance: "- Use question when needed.",
      hostAgent: "build",
      workspaceRoot: "/workspace/demo",
      oneShotReminders: ["<system_reminder>\nPlan mode active.\n</system_reminder>"],
    })
    expect(result.action).toBe("initialize")
    expect(result.seedSystemPrompt).toBe(
      "You are build.\n\n- Use question when needed.",
    )
    // One-shots stay chronological — not in the baseline.
    expect(result.seedSystemPrompt).not.toContain("Plan mode active")
    expect(result.midConversationMessage).toContain("Plan mode active")
    expect(result.epoch.baselineHash).toHaveLength(64)
  })

  it("reseeds the same frozen baseline when host system text changes", () => {
    admitContextEpoch({
      conversationId: "conv-1",
      hasCheckpoint: false,
      hostSystem: "You are build.",
      guidance: "guidance-a",
      hostAgent: "build",
      workspaceRoot: "/workspace",
    })
    const again = admitContextEpoch({
      conversationId: "conv-1",
      hasCheckpoint: false,
      hostSystem: "You are plan. No edits.",
      guidance: "guidance-a",
      hostAgent: "plan",
      workspaceRoot: "/workspace",
    })
    expect(again.action).toBe("updated")
    expect(again.seedSystemPrompt).toBe("You are build.\n\nguidance-a")
    expect(again.midConversationMessage).toContain("Host primary agent is now \"plan\"")
    expect(again.midConversationMessage).toContain("Host system instructions were updated")
    expect(again.midConversationMessage).toContain("You are plan. No edits.")
  })

  it("restores an unsent admission unless the epoch was cleared or replaced since", () => {
    const admit = (hostSystem: string, conversationId = "conv-1") =>
      admitContextEpoch({ conversationId, hasCheckpoint: true, hostSystem, workspaceRoot: "/workspace" })
    const first = admit("rules A")
    restoreContextEpoch(first.epoch, undefined)
    expect(getContextEpoch("conv-1")).toBeUndefined()

    admit("rules A")
    const before = peekContextEpoch("conv-1")
    const unsent = admit("rules B")
    restoreContextEpoch(unsent.epoch, before)
    expect(admit("rules B").midConversationMessage).toContain("rules B")

    const stale = admit("rules C")
    clearContextEpoch("conv-1")
    const replacement = admit("rules D")
    restoreContextEpoch(stale.epoch, before)
    expect(getContextEpoch("conv-1")).toBe(replacement.epoch)

    const beforeOverlap = peekContextEpoch("conv-1")
    const overtaken = admit("rules E")
    const later = admit("rules F")
    restoreContextEpoch(overtaken.epoch, beforeOverlap)
    expect(getContextEpoch("conv-1")).toBe(later.epoch)
    expect(admit("rules F").action).toBe("unchanged")
  })

  it("admits source updates on checkpoint turns without a seed system prompt", () => {
    admitContextEpoch({
      conversationId: "conv-1",
      hasCheckpoint: false,
      hostSystem: "baseline",
      hostAgent: "build",
      workspaceRoot: "/workspace",
    })
    const next = admitContextEpoch({
      conversationId: "conv-1",
      hasCheckpoint: true,
      hostSystem: "baseline",
      hostAgent: "plan",
      workspaceRoot: "/workspace",
      oneShotReminders: ["<system_reminder>\nKickoff.\n</system_reminder>"],
    })
    expect(next.seedSystemPrompt).toBeUndefined()
    expect(next.action).toBe("updated")
    expect(next.midConversationMessage).toContain("Host primary agent is now \"plan\"")
    expect(next.midConversationMessage).toContain("Kickoff.")
  })

  it("does not treat unavailable optional sources as explicit removals", () => {
    admitContextEpoch({
      conversationId: "conv-clear",
      hasCheckpoint: false,
      hostSystem: "temporary system",
      guidance: "temporary guidance",
      hostAgent: "plan",
      workspaceRoot: "/workspace",
    })
    const cleared = admitContextEpoch({
      conversationId: "conv-clear",
      hasCheckpoint: true,
      hostSystem: "",
      guidance: "",
      hostAgent: "",
      workspaceRoot: "/workspace",
    })
    expect(cleared.action).toBe("unchanged")
    expect(cleared.midConversationMessage).toBeUndefined()

    const stable = admitContextEpoch({
      conversationId: "conv-clear",
      hasCheckpoint: true,
      hostSystem: "",
      guidance: "",
      hostAgent: "",
      workspaceRoot: "/workspace",
    })
    expect(stable.action).toBe("unchanged")
    expect(stable.midConversationMessage).toBeUndefined()
  })

  it("recovers past a checkpoint without reseeding live host text later", () => {
    const recovered = admitContextEpoch({
      conversationId: "conv-restart",
      hasCheckpoint: true,
      hostSystem: "live host",
      hostAgent: "build",
      workspaceRoot: "/workspace",
    })
    expect(recovered.action).toBe("recovered")
    expect(recovered.seedSystemPrompt).toBeUndefined()
    expect(recovered.epoch.recovered).toBe(true)
    expect(recovered.epoch.baselineSystemPrompt).toBe("")
    expect(recovered.epoch.baselineHash).toBe("")

    const later = admitContextEpoch({
      conversationId: "conv-restart",
      hasCheckpoint: false,
      hostSystem: "live host",
      guidance: "g",
      hostAgent: "build",
      workspaceRoot: "/workspace",
    })
    expect(later.action).toBe("updated")
    expect(later.seedSystemPrompt).toBeUndefined()
    expect(later.epoch.recovered).toBe(true)
    expect(later.epoch.baselineSystemPrompt).toBe("")
    expect(later.midConversationMessage).toContain("OpenCode interaction guidance was updated")
    expect(later.midConversationMessage).toContain("g")

    const held = admitContextEpoch({
      conversationId: "conv-restart",
      hasCheckpoint: false,
      hostSystem: "live host",
      guidance: "g",
      hostAgent: "build",
      workspaceRoot: "/workspace",
    })
    expect(held.action).toBe("recovered")
    expect(held.seedSystemPrompt).toBeUndefined()
    expect(held.midConversationMessage).toBeUndefined()
  })

  it("delivers current instructions once when recovering a changed persisted rule", () => {
    const input = {
      conversationId: "conv-rule-restart",
      hasCheckpoint: true,
      hostSystem: "Plan only. Do not edit files.",
      guidance: "Use the question tool.",
      hostAgent: "plan",
      workspaceRoot: "/workspace",
      recoveredBaseline: "Build and edit files.\n\nUse the question tool.",
    }
    const recovered = admitContextEpoch(input)
    expect(recovered.midConversationMessage).toContain("Plan only. Do not edit files.")
    expect(recovered.midConversationMessage).toContain("Use the question tool.")
    expect(recovered.epoch.baselineSystemPrompt).toBe(input.recoveredBaseline)
    expect(recovered.seedSystemPrompt).toBeUndefined()
    expect(admitContextEpoch(input).midConversationMessage).toBeUndefined()
  })

  it("reasserts a recovered baseline in case the checkpoint contains an intervening update", () => {
    const recovered = admitContextEpoch({
      conversationId: "conv-rule-unchanged",
      hasCheckpoint: true,
      hostSystem: "baseline",
      guidance: "guidance",
      workspaceRoot: "/workspace",
      recoveredBaseline: "baseline\n\nguidance",
    })
    expect(recovered.midConversationMessage).toContain("baseline\n\nguidance")
    expect(recovered.epoch.baselineSystemPrompt).toBe("baseline\n\nguidance")
  })

  it("ends the epoch on conversation remint (compaction transfer)", () => {
    admitContextEpoch({
      conversationId: "old",
      hasCheckpoint: false,
      hostSystem: "old baseline",
      workspaceRoot: "/workspace",
    })
    endContextEpoch("old", "new")
    expect(getContextEpoch("old")).toBeUndefined()
    expect(getContextEpoch("new")).toBeUndefined()

    const next = admitContextEpoch({
      conversationId: "new",
      hasCheckpoint: false,
      hostSystem: "fresh baseline",
      workspaceRoot: "/workspace",
    })
    expect(next.action).toBe("initialize")
    expect(next.seedSystemPrompt).toBe("fresh baseline")
  })

  it("clears epoch when frozen RequestContext transfers across remint", () => {
    admitContextEpoch({
      conversationId: "prev",
      hasCheckpoint: false,
      hostSystem: "sys",
      workspaceRoot: "/workspace",
    })
    transferFrozenRequestContext("prev", "next")
    expect(getContextEpoch("prev")).toBeUndefined()
    expect(getContextEpoch("next")).toBeUndefined()
  })

  it("appendMidConversationMessage places updates after user text", () => {
    expect(appendMidConversationMessage("hello", "<system_reminder>\nx\n</system_reminder>"))
      .toBe("hello\n\n<system_reminder>\nx\n</system_reminder>")
    expect(appendMidConversationMessage("", "<system_reminder>\nx\n</system_reminder>"))
      .toBe("<system_reminder>\nx\n</system_reminder>")
  })

  it("clearContextEpoch is idempotent", () => {
    clearContextEpoch("missing")
    admitContextEpoch({
      conversationId: "c",
      hasCheckpoint: false,
      hostSystem: "s",
      workspaceRoot: "/workspace",
    })
    clearContextEpoch("c")
    clearContextEpoch("c")
    expect(getContextEpoch("c")).toBeUndefined()
  })
})
