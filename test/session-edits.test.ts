import { beforeEach, describe, expect, it } from "bun:test"
import {
  loadSessionForPermissions,
  notPermittedThisTurnReason,
  permissionsFromSession,
  resetSessionEditsGuidanceForTests,
  recordSessionEditsGuidance,
  restoreSessionEditsDenySent,
  sessionEditsDenySent,
  sessionEditsGuidance,
  sessionRulesDenyEdits,
  SHELL_NOT_FOR_FILE_WRITES,
} from "../src/protocol/session-edits.js"

const denyStar = { action: "edit", resource: "*", effect: "deny" as const }
const allowPlan = { action: "edit", resource: "/plans/*", effect: "allow" as const }
const allowStar = { action: "edit", resource: "*", effect: "allow" as const }

describe("sessionRulesDenyEdits", () => {
  it("uses the last edit rule on * and ignores a later plan-path allow", () => {
    expect(sessionRulesDenyEdits([denyStar, allowPlan])).toBe(true)
    expect(sessionRulesDenyEdits([denyStar, allowPlan, allowStar])).toBe(false)
    expect(sessionRulesDenyEdits([{ action: "*", resource: "*", effect: "deny" }])).toBe(true)
    expect(sessionRulesDenyEdits([{ action: "edit", resource: "*", effect: "ask" }])).toBe(false)
    expect(sessionRulesDenyEdits([{ action: "write", resource: "*", effect: "deny" }])).toBe(false)
    expect(sessionRulesDenyEdits(undefined)).toBe(false)
    expect(sessionRulesDenyEdits([])).toBe(false)
  })

  it("reads permissions from a bare session and from a wrapped classic session", () => {
    const rules = [denyStar, allowPlan]
    expect(sessionRulesDenyEdits(permissionsFromSession({ permissions: rules }))).toBe(true)
    expect(sessionRulesDenyEdits(permissionsFromSession({ data: { permissions: rules } }))).toBe(true)
    expect(sessionRulesDenyEdits(permissionsFromSession({ data: { slug: "quiet-owl" } }))).toBe(false)
    expect(sessionRulesDenyEdits(permissionsFromSession(undefined))).toBe(false)
  })

  it("rejects wrapped classic responses whose data payload is missing", async () => {
    let calls = 0
    await expect(loadSessionForPermissions(async () => {
      calls++
      return { data: undefined }
    })).rejects.toThrow("Could not read OpenCode session permissions")
    expect(calls).toBe(2)
  })

  it("reads native 1.x permission rules without treating plan-file access as a global allow", () => {
    const permission = [
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "/plans/*", action: "allow" },
    ]
    for (const session of [{ permission }, { data: { permission } }]) {
      expect(sessionRulesDenyEdits(permissionsFromSession(session))).toBe(true)
    }
    permission.push({ permission: "edit", pattern: "*", action: "allow" })
    expect(sessionRulesDenyEdits(permissionsFromSession({ permission }))).toBe(false)
  })

  it("matches the host's action wildcards and ignores malformed rules", () => {
    for (const action of ["e?it", "e*", "edit *", "**"]) {
      expect(sessionRulesDenyEdits([{ action, resource: "*", effect: "deny" }])).toBe(true)
    }
    expect(sessionRulesDenyEdits([{ action: "EDIT", resource: "*", effect: "deny" }])).toBe(process.platform === "win32")
    expect(sessionRulesDenyEdits([null, {}, { resource: "*", effect: "deny" }, { action: "edit", resource: "*", effect: "invalid" }])).toBe(false)
  })
})

describe("notPermittedThisTurnReason", () => {
  it("tells both majors' mutation tools not to write through the shell", () => {
    for (const tool of ["edit", "write", "apply_patch", "patch"]) {
      const reason = notPermittedThisTurnReason(tool, ["read", "bash", "shell"])
      expect(reason).toContain(`'${tool}' is not permitted`)
      expect(reason).toContain(SHELL_NOT_FOR_FILE_WRITES)
    }
    const shell = notPermittedThisTurnReason("bash", ["read"])
    expect(shell).not.toContain(SHELL_NOT_FOR_FILE_WRITES)
    expect(shell).toContain("Permitted tools: read")
  })
})

describe("sessionEditsGuidance", () => {
  beforeEach(() => resetSessionEditsGuidanceForTests())
  const fresh = { carriesEarlierState: false }
  const carried = { carriesEarlierState: true }
  const sent = (id: string, denied: boolean, state: typeof fresh) => {
    const guidance = sessionEditsGuidance(id, denied, state)
    recordSessionEditsGuidance(id, denied)
    return guidance
  }

  it("states nothing when the host reported no edit state", () => {
    expect(sessionEditsGuidance("conv", undefined, carried)).toBeUndefined()
  })

  it("states every deny, and no deny once after it", () => {
    expect(sent("conv", true, fresh)).toBe(true)
    expect(sent("conv", true, carried)).toBe(true)
    expect(sent("conv", false, carried)).toBe(false)
    expect(sessionEditsGuidance("conv", false, carried)).toBeUndefined()
  })

  it("states no deny for an unknown state only when earlier state reaches Cursor", () => {
    expect(sent("fresh", false, fresh)).toBeUndefined()
    expect(sessionEditsGuidance("fresh", false, carried)).toBeUndefined()
    expect(sent("resumed", false, carried)).toBe(false)
    expect(sessionEditsGuidance("resumed", false, carried)).toBeUndefined()
  })

  it("keeps conversations apart", () => {
    expect(sent("a", true, fresh)).toBe(true)
    expect(sent("b", false, fresh)).toBeUndefined()
    expect(sessionEditsGuidance("a", false, carried)).toBe(false)
  })

  it("does not consume a correction before it is sent", () => {
    sent("conv", true, fresh)
    expect(sessionEditsGuidance("conv", false, carried)).toBe(false)
    expect(sessionEditsGuidance("conv", false, carried)).toBe(false)
    recordSessionEditsGuidance("conv", false)
    expect(sessionEditsGuidance("conv", false, carried)).toBeUndefined()
    expect(sessionEditsGuidance("conv", false, { ...carried, carriesEditDeny: true })).toBe(false)
  })

  it("bounds retained states and safely restates evicted checkpoint state", () => {
    recordSessionEditsGuidance("absent", undefined)
    for (let i = 0; i <= 256; i++) recordSessionEditsGuidance(`conv-${i}`, false)
    expect(sessionEditsGuidance("conv-0", false, carried)).toBe(false)
    expect(sessionEditsGuidance("conv-256", false, carried)).toBeUndefined()
    expect(sessionEditsDenySent("conv-0")).toBe(true)
  })

  it("after a restart, supersedes only a conversation that ever received a deny", () => {
    restoreSessionEditsDenySent("never-denied", false)
    expect(sessionEditsGuidance("never-denied", false, carried)).toBeUndefined()
    restoreSessionEditsDenySent("was-denied", true)
    expect(sent("was-denied", false, carried)).toBe(false)
    expect(sessionEditsGuidance("was-denied", false, carried)).toBeUndefined()
    expect(sessionEditsDenySent("was-denied")).toBe(true)
    // A carried deny note still needs the correction.
    expect(sessionEditsGuidance("never-denied", false, { ...carried, carriesEditDeny: true })).toBe(false)
  })

  it("keeps live state over a later snapshot restore and remembers a sent deny", () => {
    expect(sent("live", true, fresh)).toBe(true)
    restoreSessionEditsDenySent("live", false)
    expect(sessionEditsDenySent("live")).toBe(true)
    recordSessionEditsGuidance("live", false)
    expect(sessionEditsDenySent("live")).toBe(true)
    recordSessionEditsGuidance("clean", false)
    expect(sessionEditsDenySent("clean")).toBe(false)
  })
})
