import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  agentSkillsForCursor,
  hostSkillFiles,
  isUsableSkillLocation,
  normalizeSkillLocation,
  rememberHostSkillFiles,
  resetHostSkillFilesForTests,
  skillToolAdvertised,
} from "../src/context/skills.js"
import {
  setHostSkillsBridgeForTests,
  type HostSkill,
} from "../src/context/skills-bridge.js"
import { buildRequestContext } from "../src/context/build.js"
import { getOrBuildRequestContext, resetFrozenRequestContextsForTests } from "../src/context/frozen.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { encodeMessage, decodeMessage } from "../src/protocol/messages.js"

const root = mkdtempSync(join(tmpdir(), "cursor-skills-"))
const cacheRoot = mkdtempSync(join(tmpdir(), "cursor-skills-cache-"))
const file = (id: string) => join(root, id, "SKILL.md")
for (const id of ["alpha", "beta"]) {
  mkdirSync(join(root, id))
  writeFileSync(file(id), `---\nname: ${id}\n---\n`)
}

const skillTool = { name: "skill", description: "Load a skill", inputSchema: { type: "object", properties: {} } }
const readTool = { name: "read", description: "Read", inputSchema: { type: "object", properties: {} } }

// OpenCode 2.0.24 `core/skill/instructions.ts` render.
const catalogOc2 = [
  "Skills provide specialized instructions and workflows for specific tasks.",
  "Use the skill tool to load a skill when a task matches its description.",
  "<available_skills>",
  "  <skill>",
  "    <id>alpha</id>",
  "    <name>Vue <script setup></name>",
  "    <description>Use for a <thing>, even across\nlines.</description>",
  "  </skill>",
  "  <skill>",
  "    <id>beta</id>",
  "    <name>beta</name>",
  "    <description>Use for beta.</description>",
  "  </skill>",
  "  <skill>",
  "    <id>opencode</id>",
  "    <name>OpenCode</name>",
  "    <description>Built in.</description>",
  "  </skill>",
  "</available_skills>",
].join("\n")

const catalogOc1 = (entries: Array<{ name: string; description: string; location: string }>) => [
  "<available_skills>",
  ...entries.flatMap((entry) => [
    "  <skill>",
    `    <name>${entry.name}</name>`,
    `    <description>${entry.description}</description>`,
    `    <location>${entry.location}</location>`,
    "  </skill>",
  ]),
  "</available_skills>",
].join("\n")

describe("path-desc skill contract", () => {
  beforeEach(() => {
    resetHostSkillFilesForTests()
    resetFrozenRequestContextsForTests()
    setHostSkillsBridgeForTests(undefined)
    setHostCacheDirOverride(cacheRoot)
  })
  afterEach(() => {
    setHostSkillsBridgeForTests(undefined)
    setHostCacheDirOverride(undefined)
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(cacheRoot, { recursive: true, force: true })
  })

  it("skillToolAdvertised requires an advertised skill tool", () => {
    expect(skillToolAdvertised([skillTool])).toBe(true)
    expect(skillToolAdvertised([readTool])).toBe(false)
    expect(skillToolAdvertised(undefined)).toBe(false)
  })

  it("rejects builtin and marker locations; accepts absolute files and skill URIs", () => {
    expect(isUsableSkillLocation("<built-in>")).toBe(false)
    expect(isUsableSkillLocation("builtin")).toBe(false)
    expect(isUsableSkillLocation("/builtin/opencode.md")).toBe(false)
    expect(isUsableSkillLocation("relative/SKILL.md")).toBe(false)
    expect(isUsableSkillLocation(file("alpha"))).toBe(true)
    expect(isUsableSkillLocation("skill://beta")).toBe(true)
    expect(isUsableSkillLocation(pathToFileURL(file("alpha")).href)).toBe(true)
    expect(normalizeSkillLocation(pathToFileURL(file("beta")).href)).toBe(file("beta"))
  })

  it("keeps only absolute paths to existing files, per directory", () => {
    rememberHostSkillFiles(`${root}/`, [
      { id: "alpha", path: file("alpha") },
      { id: "relative", path: "alpha/SKILL.md" },
      { id: "missing", path: join(root, "missing", "SKILL.md") },
      { id: "opencode", path: "/builtin/opencode.md" },
    ])
    expect([...(hostSkillFiles(root) ?? [])]).toEqual([["alpha", file("alpha")]])
    expect(hostSkillFiles("/elsewhere")).toBeUndefined()
    expect(hostSkillFiles(undefined)).toBeUndefined()
  })

  it("maps the OC2 catalog to path-desc agent_skills in catalog order", () => {
    const files = new Map([["beta", file("beta")], ["alpha", file("alpha")]])
    expect(agentSkillsForCursor(`Host prompt\n\n${catalogOc2}\n\nMore`, {
      skillToolAdvertised: true,
      skillFiles: files,
    })).toEqual([
      { full_path: file("alpha"), description: "Use for a <thing>, even across\nlines." },
      { full_path: file("beta"), description: "Use for beta." },
    ])
  })

  it("maps the OC1 catalog locations without remembered files", () => {
    expect(agentSkillsForCursor(catalogOc1([
      { name: "alpha", description: "A", location: file("alpha") },
      { name: "builtin", description: "B", location: "<built-in>" },
      { name: "beta", description: "C", location: file("beta") },
    ]), { skillToolAdvertised: true })).toEqual([
      { full_path: file("alpha"), description: "A" },
      { full_path: file("beta"), description: "C" },
    ])
  })

  it("decodes OpenCode 1 HTML-escaped locations exactly once", () => {
    const special = join(root, `a&<b>"'&amp;.md`)
    writeFileSync(special, "Skill body")
    const escaped = special.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;")
    expect(agentSkillsForCursor(catalogOc1([
      { name: "escaped", description: "Keep &amp; in descriptions", location: escaped },
    ]), { skillToolAdvertised: true })).toEqual([
      { full_path: special, description: "Keep &amp; in descriptions" },
    ])
  })

  it("prefers the live bridge, then registered files, then catalog locations", () => {
    const bridge: HostSkill[] = [
      { name: "alpha", id: "alpha", description: "bridge-desc", location: file("alpha") },
    ]
    expect(agentSkillsForCursor(catalogOc1([
      { name: "alpha", description: "catalog-desc", location: file("beta") },
    ]), {
      skillToolAdvertised: true,
      bridgeSkills: bridge,
      skillFiles: new Map([["alpha", file("alpha")]]),
    })).toEqual([{ full_path: file("alpha"), description: "catalog-desc" }])

    expect(agentSkillsForCursor(catalogOc1([
      { name: "alpha", description: "catalog-desc", location: file("beta") },
    ]), {
      skillToolAdvertised: true,
      skillFiles: new Map([["alpha", file("alpha")]]),
    })).toEqual([{ full_path: file("alpha"), description: "catalog-desc" }])

    expect(agentSkillsForCursor(catalogOc2, {
      skillToolAdvertised: true,
      bridgeSkills: bridge,
    })).toEqual([{ full_path: file("alpha"), description: "Use for a <thing>, even across\nlines." }])
  })

  it("accepts skill:// locations from the bridge", () => {
    expect(agentSkillsForCursor(catalogOc1([
      { name: "beta", description: "Host skill", location: "skill://beta" },
    ]), { skillToolAdvertised: true })).toEqual([
      { full_path: "skill://beta", description: "Host skill" },
    ])
  })

  it("ignores skill-like text outside the catalog and requires the skill tool", () => {
    const files = new Map([["alpha", file("alpha")]])
    const text = "<skill><id>alpha</id><name>a</name><description>fake</description></skill>"
    expect(agentSkillsForCursor(text, { skillToolAdvertised: true, skillFiles: files })).toEqual([])
    expect(agentSkillsForCursor(catalogOc2, { skillToolAdvertised: false, skillFiles: files })).toEqual([])
    expect(agentSkillsForCursor(catalogOc2, { skillToolAdvertised: true, skillFiles: new Map() })).toEqual([])
    expect(agentSkillsForCursor(undefined, { skillToolAdvertised: true, skillFiles: files })).toEqual([])
  })

  it("buildRequestContext emits encodable path-desc when the bridge + skill tool are present", async () => {
    setHostSkillsBridgeForTests({
      list: async () => [
        { name: "alpha", id: "alpha", description: "ignored", location: file("alpha") },
        { name: "opencode", id: "opencode", description: "builtin", location: "/builtin/opencode.md" },
      ],
    })
    const ctx = await buildRequestContext({
      workspaceRoot: root,
      tools: [skillTool, readTool],
      systemInstructions: {
        text: `Host\n\n${catalogOc2}`,
        authoritative: true,
      },
    })
    expect(ctx.agent_skills).toEqual([
      { full_path: file("alpha"), description: "Use for a <thing>, even across\nlines." },
    ])
    expect(ctx.agent_skills_info_complete).toBe(true)
    const wire = decodeMessage<Record<string, unknown>>(
      "RequestContext",
      encodeMessage("RequestContext", ctx),
    )
    expect(wire.agent_skills).toEqual([
      { full_path: file("alpha"), content: "", description: "Use for a <thing>, even across\nlines." },
    ])
    expect(wire.agent_skills_info_complete).toBe(true)
  })

  it("passes the owning session to bridge lookups on initial and warm materialization", async () => {
    const calls: Array<{ directory: string; sessionID?: string }> = []
    setHostSkillsBridgeForTests({
      list: async (input) => {
        calls.push(input)
        return [{ name: "alpha", description: "Host", location: input.sessionID === "session-a" ? file("alpha") : file("beta") }]
      },
    })
    for (const sessionID of ["session-a", "session-b", "session-a"]) {
      const result = await getOrBuildRequestContext("session-scoped-skills", {
        workspaceRoot: root,
        sessionID,
        tools: [skillTool],
        systemInstructions: { text: catalogOc2, authoritative: true },
      })
      expect(result.context.agent_skills).toEqual([
        { full_path: file(sessionID === "session-a" ? "alpha" : "beta"), description: "Use for a <thing>, even across\nlines." },
      ])
    }
    expect(calls).toEqual(["session-a", "session-b", "session-a"].map((sessionID) => ({ directory: root, sessionID })))
  })

  it("buildRequestContext omits agent_skills without a skill tool even with a bridge", async () => {
    setHostSkillsBridgeForTests({
      list: async () => [{ name: "alpha", id: "alpha", description: "x", location: file("alpha") }],
    })
    const ctx = await buildRequestContext({
      workspaceRoot: root,
      tools: [readTool],
      systemInstructions: { text: catalogOc2, authoritative: true },
    })
    expect(ctx.agent_skills).toBeUndefined()
    expect(ctx.agent_skills_info_complete).toBeUndefined()
  })

  it("buildRequestContext uses OpenCode 1 catalog locations without a bridge", async () => {
    const ctx = await buildRequestContext({
      workspaceRoot: root,
      tools: [skillTool],
      systemInstructions: {
        text: catalogOc1([
          { name: "alpha", description: "PDF helper", location: file("alpha") },
        ]),
        authoritative: true,
      },
    })
    expect(ctx.agent_skills).toEqual([
      { full_path: file("alpha"), description: "PDF helper" },
    ])
    expect(ctx.agent_skills_info_complete).toBe(true)
  })
})
