import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test"
import { mkdir, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { buildRequestContextResult } from "../src/protocol/tools.js"
import { decodeMessage } from "../src/protocol/messages.js"
import { SYSTEM_INSTRUCTIONS_RULE_PATH } from "../src/context/build.js"
import { rememberHostSkillFiles, resetHostSkillFilesForTests } from "../src/context/host-skills.js"
import {
  clearFrozenRequestContext,
  getFrozenRequestContext,
  getOrBuildRequestContext,
  MAX_FROZEN_REQUEST_CONTEXTS,
  resetFrozenRequestContextsForTests,
  setFrozenRequestContext,
} from "../src/context/frozen.js"
import {
  bindConversationId,
  MAX_ACTIVE_CONVERSATION_BINDINGS,
  resetConversationBindingsForTests,
} from "../src/protocol/conversation-bind.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationBlobsForTests } from "../src/protocol/blob-store.js"
import { HOST_PATH_BRIDGE, setHostCacheDirOverride } from "../src/context/paths.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import {
  hydrateConversationState,
  persistConversationState,
} from "../src/protocol/conversation-state.js"
import {
  resetTurnStateForTests,
  resolveTurnToolState,
} from "../src/language-model.js"

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** Wire-encode RequestContext the way exec #10 does, for byte-identity asserts. */
function encodeRequestContext(context: Record<string, unknown>): Uint8Array {
  return buildRequestContextResult(1, context)
}

type SlimMetaTool = { tool_name: string; description?: unknown; input_schema?: unknown }

function slimMetaDescriptors(context: Record<string, unknown>): Array<{
  server_identifier: string
  tools: SlimMetaTool[]
}> {
  const meta = context.mcp_meta_tool_options
  if (!meta || typeof meta !== "object") return []
  const descriptors = (meta as { mcp_descriptors?: unknown }).mcp_descriptors
  if (!Array.isArray(descriptors)) return []
  return descriptors.map((descriptor) => {
    const record = descriptor && typeof descriptor === "object"
      ? descriptor as { server_identifier?: unknown; tools?: unknown }
      : {}
    return {
      server_identifier: typeof record.server_identifier === "string" ? record.server_identifier : "",
      tools: Array.isArray(record.tools)
        ? record.tools.filter((tool): tool is SlimMetaTool =>
            !!tool && typeof tool === "object" && typeof (tool as SlimMetaTool).tool_name === "string")
        : [],
    }
  })
}

function slimMetaTools(context: Record<string, unknown>): SlimMetaTool[] {
  return slimMetaDescriptors(context).flatMap((descriptor) => descriptor.tools)
}

describe("frozen request_context", () => {
  let root: string
  let cacheRoot: string
  let sandboxHome: string
  const previousHome = process.env.HOME
  const previousXdgConfig = process.env.XDG_CONFIG_HOME
  const previousUserProfile = process.env.USERPROFILE
  const previousBridge = (globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE]

  beforeAll(async () => {
    root = path.join(os.tmpdir(), `cursor-frozen-ctx-${process.pid}-${Date.now()}`)
    cacheRoot = path.join(os.tmpdir(), `cursor-frozen-cache-${process.pid}-${Date.now()}`)
    sandboxHome = path.join(os.tmpdir(), `cursor-frozen-home-${process.pid}-${Date.now()}`)
    // loadMergedConfig overlays the global OpenCode config ($XDG_CONFIG_HOME,
    // else $HOME/.config). A developer machine with mcp.github in that global
    // file would make github_create_issue look like a configured MCP tool
    // before the project opencode.json exists.
    process.env.HOME = sandboxHome
    delete process.env.XDG_CONFIG_HOME
    process.env.USERPROFILE = sandboxHome
    delete (globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE]
    setHostCacheDirOverride(cacheRoot)
    await mkdir(path.join(sandboxHome, ".config", "opencode"), { recursive: true })
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, "AGENTS.md"), "# freeze test\n")
    // Init a tiny git repo so collectGit has porcelain status to freeze.
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const execFileAsync = promisify(execFile)
    await execFileAsync("git", ["init"], { cwd: root })
    await execFileAsync("git", ["config", "user.email", "t@example.com"], { cwd: root })
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: root })
    await execFileAsync("git", ["add", "AGENTS.md"], { cwd: root })
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: root })
  })

  afterAll(async () => {
    setHostCacheDirOverride(undefined)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdgConfig
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
    if (previousBridge === undefined) delete (globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE]
    else (globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE] = previousBridge
    await rm(root, { recursive: true, force: true })
    await rm(cacheRoot, { recursive: true, force: true })
    await rm(sandboxHome, { recursive: true, force: true })
  })

  beforeEach(() => {
    resetFrozenRequestContextsForTests()
    resetConversationBindingsForTests()
    resetCheckpointsForTests()
    resetConversationBlobsForTests()
    resetConversationPersistenceForTests()
    resetTurnStateForTests()
  })

  it("builds once then reuses the same object across calls", async () => {
    const conversationId = "conv-freeze-1"
    const first = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    expect(first.reused).toBe(false)

    const second = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    expect(second.reused).toBe(true)
    expect(second.context).toBe(first.context)
    expect(Object.isFrozen(first.context)).toBe(true)
    expect(Object.isFrozen(first.context.mcp_meta_tool_options)).toBe(true)
  })

  it("deduplicates overlapping builds for one conversation", async () => {
    const conversationId = "conv-freeze-concurrent"
    const [first, second] = await Promise.all([
      getOrBuildRequestContext(conversationId, { workspaceRoot: root }),
      getOrBuildRequestContext(conversationId, { workspaceRoot: root }),
    ])

    expect(first.context).toBe(second.context)
    expect([first.reused, second.reused].sort()).toEqual([false, true])
  })

  it("prevents callers from mutating the retained snapshot", async () => {
    const first = await getOrBuildRequestContext("conv-freeze-immutable", {
      workspaceRoot: root,
      tools: [{ name: "read" }],
    })
    const meta = first.context.mcp_meta_tool_options as {
      mcp_descriptors: Array<{ tools: SlimMetaTool[] }>
    }
    const tools = meta.mcp_descriptors[0]!.tools

    expect(() => tools.push({ tool_name: "write" })).toThrow()
    expect(() => { tools[0]!.tool_name = "write" }).toThrow()

    const reused = await getOrBuildRequestContext("conv-freeze-immutable", {
      workspaceRoot: root,
      tools: [{ name: "read" }],
    })
    expect(slimMetaTools(reused.context)[0]).toEqual({ tool_name: "read" })
    expect(reused.context.tools).toBeUndefined()
  })

  it("keeps encoded request_context bytes identical after workspace changes", async () => {
    const conversationId = "conv-freeze-bytes"
    const first = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    const bytes1 = encodeRequestContext(first.context)

    // Mutate the workspace so a fresh build would embed different git status /
    // layout — the frozen snapshot must ignore that.
    await writeFile(path.join(root, "volatile.txt"), `changed-${Date.now()}\n`)

    const second = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    expect(second.reused).toBe(true)
    const bytes2 = encodeRequestContext(second.context)
    expect(sha(bytes2)).toBe(sha(bytes1))
  })

  it("refresh forces a rebuild", async () => {
    const conversationId = "conv-freeze-refresh"
    const first = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    const refreshed = await getOrBuildRequestContext(
      conversationId,
      { workspaceRoot: root },
      { refresh: true },
    )
    expect(refreshed.reused).toBe(false)
    expect(refreshed.context).not.toBe(first.context)
  })

  it("updates live tools and then reuses byte-identical capabilities", async () => {
    const conversationId = "conv-freeze-tools"
    const empty = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    expect(slimMetaTools(empty.context)).toEqual([])
    expect(empty.context.tools).toBeUndefined()

    const upgraded = await getOrBuildRequestContext(conversationId, {
      workspaceRoot: root,
      tools: [{ name: "read" }],
    })
    expect(upgraded.reused).toBe(false)
    expect(slimMetaTools(upgraded.context)).toEqual([{ tool_name: "read" }])

    const stable = await getOrBuildRequestContext(conversationId, {
      workspaceRoot: root,
      tools: [{ name: "read" }],
    })
    expect(stable.reused).toBe(true)
    expect(stable.context).toBe(upgraded.context)
    expect(slimMetaTools(stable.context)).toEqual([{ tool_name: "read" }])

    const changed = await getOrBuildRequestContext(conversationId, {
      workspaceRoot: root,
      tools: [{
        name: "read",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }],
    })
    expect(changed.reused).toBe(true)
    expect(changed.context).toBe(stable.context)
    expect(slimMetaTools(changed.context)).toEqual([{ tool_name: "read" }])
  })

  it("reuses the prefix when the host enumerates the same tools in a different order", async () => {
    const sessionKey = "ses-freeze-tool-order"
    const conversationId = "conv-freeze-tool-order"
    const tools = [
      { name: "read", description: "Read a file" },
      { name: "github_get_me", description: "Get the current user" },
      { name: "bash", description: "Run a shell command" },
    ]
    await writeFile(path.join(root, "opencode.json"), JSON.stringify({
      mcp: { github: { type: "remote" } },
    }))
    try {
      const firstState = await resolveTurnToolState({
        sessionKey,
        incomingTools: tools,
        isCompaction: false,
      })
      const first = await getOrBuildRequestContext(conversationId, {
        workspaceRoot: root,
        tools: firstState.advertisedTools,
      })
      const reorderedState = await resolveTurnToolState({
        sessionKey,
        incomingTools: [...tools].reverse(),
        isCompaction: false,
      })
      expect(reorderedState.advertisedTools.map((tool) => tool.name))
        .toEqual(firstState.advertisedTools.map((tool) => tool.name))
      const reordered = await getOrBuildRequestContext(conversationId, {
        workspaceRoot: root,
        tools: reorderedState.advertisedTools,
      })

      expect(reordered.reused).toBe(true)
      expect(reordered.context).toBe(first.context)
      expect(sha(encodeRequestContext(reordered.context)))
        .toBe(sha(encodeRequestContext(first.context)))
    } finally {
      await rm(path.join(root, "opencode.json"), { force: true })
    }
  })

  it("keeps existing tool descriptors when a name is appended", async () => {
    const sessionKey = "ses-freeze-tool-append"
    const conversationId = "conv-freeze-tool-append"
    const firstState = await resolveTurnToolState({
      sessionKey,
      incomingTools: [{ name: "write", description: "Write a file" }],
      isCompaction: false,
    })
    const first = await getOrBuildRequestContext(conversationId, {
      workspaceRoot: root,
      tools: firstState.advertisedTools,
    })
    const grownState = await resolveTurnToolState({
      sessionKey,
      incomingTools: [
        { name: "bash", description: "Run a shell command" },
        { name: "write", description: "Write a file" },
      ],
      isCompaction: false,
    })
    expect(grownState.advertisedTools.map((tool) => tool.name)).toEqual(["write", "bash"])
    const grown = await getOrBuildRequestContext(conversationId, {
      workspaceRoot: root,
      tools: grownState.advertisedTools,
    })

    expect(grown.reused).toBe(false)
    const firstTools = slimMetaTools(first.context)
    const grownTools = slimMetaTools(grown.context)
    expect(grownTools).toHaveLength(2)
    expect(grownTools[0]).toEqual(firstTools[0])
    expect(grownTools[1]?.tool_name).toBe("bash")
  })

  it("rebuilds a byte-identical prefix after durable restart hydration", async () => {
    const sessionKey = "ses-freeze-restart"
    const conversationId = bindConversationId(sessionKey).conversationId
    const tools = [
      { name: "read", description: "Read a file" },
      { name: "bash", description: "Run a shell command" },
    ]
    const first = await getOrBuildRequestContext(conversationId, { workspaceRoot: root, tools })
    const firstHash = sha(encodeRequestContext(first.context))
    await persistConversationState(cacheRoot, {
      sessionKey,
      conversationId,
      requestContext: first.context,
      toolCatalog: tools,
    })

    resetConversationPersistenceForTests()
    resetConversationBindingsForTests()
    resetCheckpointsForTests()
    resetConversationBlobsForTests()
    resetFrozenRequestContextsForTests()

    const hydrated = await hydrateConversationState(cacheRoot, sessionKey)
    expect(hydrated?.conversationId).toBe(conversationId)
    expect(hydrated?.toolCatalog).toEqual(tools)
    const rebuilt = await getOrBuildRequestContext(conversationId, {
      workspaceRoot: root,
      tools: hydrated!.toolCatalog,
    })

    // A process restart cannot retain object identity, but it must retain the
    // exact serialized prefix. Subsequent in-process calls regain object reuse.
    expect(rebuilt.reused).toBe(false)
    expect(sha(encodeRequestContext(rebuilt.context))).toBe(firstHash)
    const reused = await getOrBuildRequestContext(conversationId, {
      workspaceRoot: root,
      tools: hydrated!.toolCatalog,
    })
    expect(reused.reused).toBe(true)
    expect(reused.context).toBe(rebuilt.context)
  })

  it("removes tools on an ordinary restricted/no-tool turn", async () => {
    const conversationId = "conv-freeze-no-downgrade"
    const populated = await getOrBuildRequestContext(conversationId, {
      workspaceRoot: root,
      tools: [{ name: "read" }],
    })
    const empty = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })

    expect(empty.reused).toBe(false)
    expect(empty.context).not.toBe(populated.context)
    expect(slimMetaTools(empty.context)).toEqual([])
    expect(empty.context.tools).toBeUndefined()
  })

  it("omits agent_skills from RequestContext when skills appear on disk", async () => {
    const conversationId = "conv-live-skills"
    const skillDir = path.join(root, ".opencode", "skills", "live-skill")
    const first = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    expect(first.context.agent_skills).toBeUndefined()

    await mkdir(skillDir, { recursive: true })
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: live-skill\ndescription: Added during chat\n---\nUse this live skill.\n",
    )
    const added = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    expect(added.context.agent_skills).toBeUndefined()
    expect(added.context).toBe(first.context)

    await rm(skillDir, { recursive: true, force: true })
  })

  describe("agent_skills from the host skill catalog", () => {
    const catalog = (ids: string[]) => [
      "Host prompt",
      "Skills provide specialized instructions and workflows for specific tasks.",
      "<available_skills>",
      ...ids.flatMap((id) => ["  <skill>", `    <id>${id}</id>`, `    <name>${id}</name>`, `    <description>Use for ${id}.</description>`, "  </skill>"]),
      "</available_skills>",
    ].join("\n")
    let skillRoot: string
    const file = (id: string) => path.join(skillRoot, id, "SKILL.md")

    beforeEach(async () => {
      resetHostSkillFilesForTests()
      skillRoot = path.join(root, ".skills-fixture")
      for (const id of ["alpha", "beta"]) {
        await mkdir(path.dirname(file(id)), { recursive: true })
        await writeFile(file(id), `---\nname: ${id}\ndescription: Use for ${id}.\n---\nBody.\n`)
      }
    })

    it("advertises cataloged skills that have a file, with path and description only", async () => {
      rememberHostSkillFiles(root, [
        { id: "alpha", path: file("alpha") },
        { id: "beta", path: file("beta") },
        { id: "opencode", path: "/builtin/opencode.md" },
      ])
      const conversationId = "conv-agent-skills"
      const systemInstructions = { text: catalog(["alpha", "opencode", "unlisted-file"]), authoritative: true }
      const first = await getOrBuildRequestContext(conversationId, { workspaceRoot: root, systemInstructions })
      expect(first.context.agent_skills).toEqual([{ full_path: file("alpha"), description: "Use for alpha." }])
      expect(first.context.agent_skills_info_complete).toBe(true)
      expect(getFrozenRequestContext(conversationId)?.agent_skills).toBeUndefined()

      const again = await getOrBuildRequestContext(conversationId, { workspaceRoot: root, systemInstructions })
      expect(again.reused).toBe(true)
      expect(again.context).toBe(first.context)
      const wire = decodeMessage<any>("AgentClientMessage", encodeRequestContext(again.context))
      // The decoder fills proto defaults: an empty content was never sent.
      expect(wire.exec_client_message.request_context_result.success.request_context.agent_skills)
        .toEqual([{ full_path: file("alpha"), content: "", description: "Use for alpha." }])
    })

    it("follows the frozen rule's catalog, not a recovered epoch's live text", async () => {
      rememberHostSkillFiles(root, [
        { id: "alpha", path: file("alpha") },
        { id: "beta", path: file("beta") },
      ])
      const conversationId = "conv-agent-skills-epoch"
      await getOrBuildRequestContext(conversationId, {
        workspaceRoot: root,
        systemInstructions: { text: catalog(["alpha"]), authoritative: true },
      })
      const recovered = await getOrBuildRequestContext(conversationId, {
        workspaceRoot: root,
        systemInstructions: { text: catalog(["alpha", "beta"]), authoritative: false },
      })
      expect((recovered.context.agent_skills as Array<{ full_path: string }>).map((s) => s.full_path))
        .toEqual([file("alpha")])
    })

    it("sends no agent_skills without a catalog or without known files", async () => {
      const noFiles = await getOrBuildRequestContext("conv-agent-skills-nofiles", {
        workspaceRoot: root,
        systemInstructions: { text: catalog(["alpha"]), authoritative: true },
      })
      expect(noFiles.context.agent_skills).toBeUndefined()
      expect(noFiles.context.agent_skills_info_complete).toBeUndefined()

      rememberHostSkillFiles(root, [{ id: "alpha", path: file("alpha") }])
      const noCatalog = await getOrBuildRequestContext("conv-agent-skills-nocatalog", {
        workspaceRoot: root,
        systemInstructions: { text: "Host prompt without skills", authoritative: true },
      })
      expect(noCatalog.context.agent_skills).toBeUndefined()
    })

    it("drops a skill once the host no longer registers its file", async () => {
      rememberHostSkillFiles(root, [{ id: "alpha", path: file("alpha") }])
      const conversationId = "conv-agent-skills-removed"
      const systemInstructions = { text: catalog(["alpha"]), authoritative: true }
      const first = await getOrBuildRequestContext(conversationId, { workspaceRoot: root, systemInstructions })
      expect(first.context.agent_skills).toHaveLength(1)
      rememberHostSkillFiles(root, [])
      const after = await getOrBuildRequestContext(conversationId, { workspaceRoot: root, systemInstructions })
      expect(after.reused).toBe(false)
      expect(after.context.agent_skills).toBeUndefined()
    })
  })

  describe("system-instructions rule", () => {
    const rule = (text: string) => ({
      full_path: SYSTEM_INSTRUCTIONS_RULE_PATH,
      content: text,
      type: { global: {} },
    })

    it("freezes the host system context as one global rule on every Run", async () => {
      const conversationId = "conv-system-rule"
      const systemInstructions = { text: "Host prompt\n\nGuidance", authoritative: true }
      const first = await getOrBuildRequestContext(conversationId, { workspaceRoot: root, systemInstructions })
      expect(first.context.rules).toEqual([rule("Host prompt\n\nGuidance")])
      // Checkpoint Run: same epoch baseline, same bytes, reused object.
      const again = await getOrBuildRequestContext(conversationId, { workspaceRoot: root, systemInstructions })
      expect(again.reused).toBe(true)
      expect(again.context).toBe(first.context)
      // Wire encoding keeps the rule type (an untyped rule is never applied).
      const wire = decodeMessage<any>("AgentClientMessage", encodeRequestContext(again.context))
      expect(wire.exec_client_message.request_context_result.success.request_context.rules)
        .toEqual([rule("Host prompt\n\nGuidance")])
    })

    it("replaces the rule for a new epoch baseline but not for a recovered epoch", async () => {
      const conversationId = "conv-system-rule-epoch"
      await getOrBuildRequestContext(conversationId, {
        workspaceRoot: root,
        systemInstructions: { text: "baseline A", authoritative: true },
      })
      const recovered = await getOrBuildRequestContext(conversationId, {
        workspaceRoot: root,
        systemInstructions: { text: "live text", authoritative: false },
      })
      expect(recovered.context.rules).toEqual([rule("baseline A")])
      const reseeded = await getOrBuildRequestContext(conversationId, {
        workspaceRoot: root,
        systemInstructions: { text: "baseline B", authoritative: true },
      })
      expect(reseeded.context.rules).toEqual([rule("baseline B")])
    })

    it("fills a persisted base that has no rule and drops legacy untyped rules", async () => {
      const conversationId = "conv-system-rule-legacy"
      setFrozenRequestContext(conversationId, {
        rules: [{ full_path: "/tmp/AGENTS.md", content: "# untyped, never applied" }],
        env: { workspace_paths: [root] },
      })
      const filled = await getOrBuildRequestContext(conversationId, {
        workspaceRoot: root,
        systemInstructions: { text: "live text", authoritative: false },
      })
      expect(filled.context.rules).toEqual([rule("live text")])
    })

    it("survives a durable restart byte-identically", async () => {
      const sessionKey = "ses-system-rule-restart"
      const conversationId = bindConversationId(sessionKey).conversationId
      const first = await getOrBuildRequestContext(conversationId, {
        workspaceRoot: root,
        systemInstructions: { text: "frozen baseline", authoritative: true },
      })
      await persistConversationState(cacheRoot, { sessionKey, conversationId, requestContext: first.context })
      resetConversationPersistenceForTests()
      resetConversationBindingsForTests()
      resetFrozenRequestContextsForTests()

      await hydrateConversationState(cacheRoot, sessionKey)
      // After restart the epoch is recovered (no baseline bytes): live text must not win.
      const rebuilt = await getOrBuildRequestContext(conversationId, {
        workspaceRoot: root,
        systemInstructions: { text: "changed live text", authoritative: false },
      })
      expect(rebuilt.context.rules).toEqual([rule("frozen baseline")])
      expect(sha(encodeRequestContext(rebuilt.context))).toBe(sha(encodeRequestContext(first.context)))
    })
  })

  it("strips rules from a hydrated frozen base", async () => {
    const conversationId = "conv-strip-rules"
    setFrozenRequestContext(conversationId, {
      rules: [{ full_path: "/tmp/AGENTS.md", content: "# leftover" }],
      agent_skills: [{ full_path: "/tmp/SKILL.md", content: "nope" }],
      env: { workspace_paths: [root] },
    })
    const frozen = getFrozenRequestContext(conversationId)
    expect(frozen?.rules).toBeUndefined()
    expect(frozen?.agent_skills).toBeUndefined()
    const rebuilt = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    expect(rebuilt.context.rules).toBeUndefined()
    expect(rebuilt.context.agent_skills).toBeUndefined()
  })

  it("holds custom subagents when the host omits the executor", async () => {
    const conversationId = "conv-hold-subagents"
    const tools = [{
      name: "task",
      description: "Launch a subagent with subagent_type.",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string" },
          prompt: { type: "string" },
          subagent_type: { type: "string", enum: ["general", "explore"] },
        },
      },
    }]
    const first = await getOrBuildRequestContext(conversationId, { workspaceRoot: root, tools })
    const firstAgents = (first.context.custom_subagents as Array<Record<string, unknown>>)
      .map((agent) => agent.name)
    expect(firstAgents).toEqual(["explore", "general"])

    const empty = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    expect(empty.reused).toBe(false)
    expect((empty.context.custom_subagents as Array<Record<string, unknown>>)
      .map((agent) => agent.name)).toEqual(firstAgents)
    expect(empty.context.tools).toBeUndefined()
    expect(slimMetaTools(empty.context)).toEqual([])
  })

  it("appends a plugin line at the tail instead of re-sorting", async () => {
    const conversationId = "conv-plugin-append"
    const pluginDir = path.join(root, ".opencode", "plugins")
    await mkdir(pluginDir, { recursive: true })
    await writeFile(path.join(pluginDir, "zeta.js"), "export {}")
    const first = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    expect(first.context.hooks_additional_context).toBe("opencode-plugin:local:zeta")

    await writeFile(path.join(pluginDir, "alpha.js"), "export {}")
    const grown = await getOrBuildRequestContext(conversationId, { workspaceRoot: root })
    expect(grown.reused).toBe(false)
    expect(grown.context.hooks_additional_context).toBe(
      "opencode-plugin:local:zeta\nopencode-plugin:local:alpha",
    )
    await rm(pluginDir, { recursive: true, force: true })
  })

  it("refreshes MCP server identity when configuration changes", async () => {
    const conversationId = "conv-live-mcp"
    const configPath = path.join(root, "opencode.json")
    const tools = [{ name: "github_create_issue", description: "Create issue" }]
    const first = await getOrBuildRequestContext(conversationId, { workspaceRoot: root, tools })
    expect(slimMetaDescriptors(first.context)[0]?.server_identifier)
      .toBe("opencode")

    await writeFile(configPath, JSON.stringify({ mcp: { github: { type: "remote" } } }))
    const enabled = await getOrBuildRequestContext(conversationId, { workspaceRoot: root, tools })
    expect(enabled.reused).toBe(false)
    expect(slimMetaDescriptors(enabled.context)[0]?.server_identifier)
      .toBe("github")

    const unchanged = await getOrBuildRequestContext(conversationId, { workspaceRoot: root, tools })
    expect(unchanged.reused).toBe(true)
    expect(unchanged.context).toBe(enabled.context)

    await rm(configPath, { force: true })
    const disabled = await getOrBuildRequestContext(conversationId, { workspaceRoot: root, tools })
    expect(disabled.reused).toBe(false)
    expect(slimMetaDescriptors(disabled.context)[0]?.server_identifier)
      .toBe("opencode")
  })

  it("conversation reset transfers the stable base and refreshes live overlays", async () => {
    const firstId = bindConversationId("ses_freeze").conversationId
    const tools = [{ name: "read" }]
    const first = await getOrBuildRequestContext(firstId, { workspaceRoot: root, tools })
    const firstBytes = encodeRequestContext(first.context)

    // A volatile base change after the first build must not shift the reset
    // prefix; the reset belongs to the same OpenCode workspace/session.
    await writeFile(path.join(root, "after-freeze.txt"), "must stay outside the frozen base\n")
    const reset = bindConversationId("ses_freeze", { reset: true })
    expect(getFrozenRequestContext(firstId)).toBeUndefined()
    expect(getFrozenRequestContext(reset.conversationId)).toBeDefined()

    const transferred = await getOrBuildRequestContext(reset.conversationId, {
      workspaceRoot: root,
      tools,
    })
    expect(transferred.reused).toBe(true)
    expect(sha(encodeRequestContext(transferred.context))).toBe(sha(firstBytes))

    const rebased = bindConversationId("ses_freeze", { reset: true })
    const retransferred = await getOrBuildRequestContext(rebased.conversationId, {
      workspaceRoot: root,
      tools,
    })
    expect(retransferred.reused).toBe(true)
    expect(sha(encodeRequestContext(retransferred.context))).toBe(sha(firstBytes))

    // Live capabilities are still rediscovered rather than frozen across the
    // id boundary.
    const changed = await getOrBuildRequestContext(rebased.conversationId, {
      workspaceRoot: root,
      tools: [...tools, { name: "write" }],
    })
    expect(changed.reused).toBe(false)
    expect(slimMetaTools(changed.context)).toHaveLength(2)
  })

  it("binding LRU eviction keeps the frozen context warm", () => {
    const first = bindConversationId("oldest-freeze").conversationId
    setFrozenRequestContext(first, { tools: [] })
    expect(getFrozenRequestContext(first)).toBeDefined()

    for (let i = 0; i < MAX_ACTIVE_CONVERSATION_BINDINGS; i++) {
      bindConversationId(`new-freeze-${i}`)
    }

    expect(getFrozenRequestContext(first)).toBeDefined()
  })

  it("clearFrozenRequestContext is a no-op for unknown ids", () => {
    clearFrozenRequestContext("missing")
  })

  it("caps the freeze store", () => {
    for (let i = 0; i < MAX_FROZEN_REQUEST_CONTEXTS + 5; i++) {
      setFrozenRequestContext(`cap-${i}`, { i })
    }
    expect(getFrozenRequestContext("cap-0")).toBeUndefined()
    expect(getFrozenRequestContext(`cap-${MAX_FROZEN_REQUEST_CONTEXTS + 4}`)).toBeDefined()
  })
})
