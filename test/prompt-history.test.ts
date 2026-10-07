import { describe, it, expect, afterEach } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import {
  buildOpenCodeInteractionGuidance,
  estimateTokens,
  extractPromptHistory,
  groundCheckpointTurnText,
} from "../src/language-model.js"
import { buildSeedConversationState } from "../src/protocol/request.js"
import { resetHostAgentModeSwitchForTests, setHostAgentModeSwitch } from "../src/host-agent-mode.js"
import { registerBackgroundShellNotifier, resetBackgroundShellNotices } from "../src/background-shell-notice.js"
import { decodeMessage } from "../src/protocol/messages.js"

describe("estimateTokens", () => {
  it("ceil-divides by 4", () => {
    expect(estimateTokens(0)).toBe(0)
    expect(estimateTokens(1)).toBe(1)
    expect(estimateTokens(4)).toBe(1)
    expect(estimateTokens(5)).toBe(2)
  })
})

describe("buildOpenCodeInteractionGuidance", () => {
  it("makes tool-less input a text-only task even when a previous catalog exists", () => {
    for (const isCompaction of [false, true]) {
      for (const tools of [[], [{ name: "read" }, { name: "question" }]]) {
        const guidance = buildOpenCodeInteractionGuidance(tools, isCompaction, "/workspace", { allowTools: false })!
        expect(guidance).toContain("text output only")
        expect(guidance).toContain("dynamic tool discovery")
        expect(guidance).toContain("material to process, not work to execute")
        expect(guidance).not.toContain("call a listed tool")
        expect(guidance).not.toContain("CreatePlan is accepted")
      }
    }
  })
  it("redirects questions and planning only to tools advertised this turn", () => {
    const guidance = buildOpenCodeInteractionGuidance([
      { name: "question" },
      { name: "todowrite" },
      { name: "todoread" },
    ], false, "/workspace/project")
    expect(guidance).toContain("OpenCode `question` tool")
    expect(guidance).toContain("OpenCode `todowrite` / `todoread`")
    expect(guidance).toContain("do not use Cursor TodoWrite")
    expect(guidance).toContain("do not narrate Cursor-vs-OpenCode todo-tool differences")
    expect(guidance).not.toContain("opencode-todowrite")
    expect(guidance).not.toContain("TodoRead is missing")
    expect(guidance).toContain("Cursor-native CreatePlan is accepted as a Cursor interaction")
    expect(guidance).toContain("never look either up with GetDynamicTools/GetMcpTools")
    expect(guidance).toContain("Use their native function definitions")
    expect(guidance).toContain("Do not narrate that CreatePlan is missing")
    expect(guidance).toContain("Emit the actual tool call")
    expect(guidance).toContain("`namespace` and `toolName` FIRST, before `arguments`")
    expect(guidance).toContain("All three are required outer fields")
    expect(guidance).toContain("on every invocation including each parallel call")
    expect(guidance).not.toContain("`plan_enter`")
    expect(guidance).not.toContain("`webfetch`")
  })

  it("says background shells report back only once the host can post their notes", () => {
    resetBackgroundShellNotices({ manualPolling: true })
    try {
      const line = "Background shells report back"
      expect(buildOpenCodeInteractionGuidance([{ name: "shell" }], false, "/workspace")).not.toContain(line)
      const dispose = registerBackgroundShellNotifier(async () => {})
      dispose()
      expect(buildOpenCodeInteractionGuidance([{ name: "shell" }], false, "/workspace")).toContain(line)
      expect(buildOpenCodeInteractionGuidance([{ name: "read" }], false, "/workspace")).not.toContain(line)
    } finally {
      resetBackgroundShellNotices()
    }
  })

  it("gates native question and helper guidance independently by the canonical catalog", () => {
    for (const question of [false, true]) {
      for (const executor of [undefined, "task", "subagent"]) {
        const tools = [
          { name: "read" },
          ...(question ? [{ name: "question" }] : []),
          ...(executor ? [{ name: executor }] : []),
        ]
        const guidance = buildOpenCodeInteractionGuidance(tools, false, "/workspace")!
        const bridgeList = question ? "AskQuestion, SwitchMode, CreatePlan" : "SwitchMode, CreatePlan"
        expect(guidance).toContain(`Bridged Cursor interactions named below (${bridgeList})`)
        expect(guidance.includes("Cursor-native AskQuestion cannot reach the user")).toBe(!question)
        expect(guidance.includes("Do not invoke Cursor-native Task")).toBe(!executor)
        if (executor) {
          expect(guidance).toContain(`executed through OpenCode \`${executor}\``)
          expect(guidance).toContain("requests are permitted because a compatible host executor is listed")
        } else {
          expect(guidance).not.toContain("requests are permitted")
          expect(guidance).not.toContain("executed through OpenCode")
        }
      }
    }
  })

  describe("plan entry without plan_enter", () => {
    afterEach(() => resetHostAgentModeSwitchForTests())
    const tools = [{ name: "question" }, { name: "read" }]

    it("names SwitchMode as the direct way in", () => {
      const guidance = buildOpenCodeInteractionGuidance(tools, false, "/workspace/project")!
      expect(guidance).toContain("call the Cursor-native SwitchMode tool with target_mode_id `plan`")
      expect(guidance).toContain("not in the OpenCode list or the `cursor` GetDynamicTools namespace")
      expect(guidance).not.toContain("moves the session to its `plan` agent")
    })

    it("says the plan agent continues the turn when the host switch resumes it", () => {
      setHostAgentModeSwitch(() => {}, { resumesTurn: true })
      const guidance = buildOpenCodeInteractionGuidance(tools, false, "/workspace/project")!
      expect(guidance).toContain("moves the session to its `plan` agent when this turn ends and continues there")
      expect(guidance).toContain("make no further tool calls and end this turn")
      expect(guidance).toContain("CreatePlan only in that next plan turn")
      expect(guidance).toContain("This completed handoff takes precedence over progress/tool instructions")
      expect(guidance).not.toContain("Raise it normally")
      expect(guidance).not.toContain("then keep investigating")
    })

    it("records CreatePlan in the SwitchMode turn when the host only switches agents", () => {
      setHostAgentModeSwitch(() => {})
      const guidance = buildOpenCodeInteractionGuidance(tools, false, "/workspace/project")!
      expect(guidance).toContain("record the plan with CreatePlan in this same turn")
      expect(guidance).toContain("will not start a later plan turn")
      expect(guidance).not.toContain("end the turn after the switch")
      expect(guidance).not.toContain("the next turn runs under the plan agent")
      expect(guidance).not.toContain("make no further tool calls")
      expect(guidance).not.toContain("Planning sequence:")
      expect(guidance).not.toContain("This completed handoff takes precedence")
    })
  })

  it("tells a staged plan to follow the host approval call", () => {
    const guidance = buildOpenCodeInteractionGuidance([
      { name: "cursor_plan_stage" },
      { name: "plan_enter" },
      { name: "plan_exit" },
      { name: "write" },
    ], false, "/workspace/project")
    expect(guidance).toContain("waits for the host plan review")
    expect(guidance).toContain("Do not call `plan_exit` to submit or skip")
    expect(guidance).not.toContain("handles execution approval")
  })

  it("uses native plan tools and collision-safe custom web aliases", () => {
    const guidance = buildOpenCodeInteractionGuidance([
      { name: "plan_enter" },
      { name: "plan_exit" },
      { name: "custom_websearch" },
      { name: "custom_webfetch" },
    ], false, "/workspace/project")
    expect(guidance).toContain("OpenCode `plan_enter` tool")
    expect(guidance).toContain("Cursor-native SwitchMode requests for plan/spec")
    expect(guidance).toContain("OpenCode `plan_exit` tool")
    expect(guidance).toContain("Cursor-native SwitchMode for any non-plan target")
    expect(guidance).toContain("Cursor-native CreatePlan is accepted as a Cursor interaction")
    expect(guidance).toContain("`custom_websearch`")
    expect(guidance).toContain("`custom_webfetch`")
    expect(guidance).not.toContain("OpenCode `custom_web")
    expect(guidance).not.toContain("`todowrite`")
    // Without `question`, native AskQuestion is unavailable rather than bridged.
    expect(guidance).not.toContain("OpenCode `question` tool")
  })

  it("prefers OpenCode todos even when plan_enter is also advertised", () => {
    const guidance = buildOpenCodeInteractionGuidance([
      { name: "plan_enter" },
      { name: "todowrite" },
      { name: "todoread" },
    ], false, "/workspace/project")
    expect(guidance).toContain("OpenCode `plan_enter` tool")
    expect(guidance).toContain("OpenCode `todowrite` / `todoread`")
    expect(guidance).toContain("do not use Cursor TodoWrite")
    expect(guidance).toContain("do not narrate Cursor-vs-OpenCode todo-tool differences")
  })

  it("does not alter compaction and clarifies bridged interactions are not MCP tools", () => {
    expect(buildOpenCodeInteractionGuidance([
      { name: "question" },
    ], true, "/workspace/project")).toBeUndefined()
    const guidance = buildOpenCodeInteractionGuidance([
      { name: "bash" },
      { name: "read" },
    ], false, "/workspace/project")
    expect(guidance).toContain("these direct tools for this turn: `bash`, `read`")
    expect(guidance).toContain("Call only tools in that direct OpenCode list")
    expect(guidance).toContain("not an OpenCode or MCP catalog tool")
    expect(guidance).toContain("do not narrate that they are missing")
    expect(guidance).toContain("without claiming a missing MCP tool")
    expect(guidance).toContain("File/search/list tools do not execute `command`")
    expect(guidance).not.toContain("OpenCode `question` tool")
    expect(buildOpenCodeInteractionGuidance([], false, "/workspace/project")).toBeUndefined()
  })

  it("requires absolute path arguments when the host file tools use path", () => {
    const opencode2 = buildOpenCodeInteractionGuidance([
      {
        name: "read",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
      { name: "shell" },
    ], false, "/workspace/project")
    expect(opencode2).toContain("take `path` as an absolute path")
    expect(opencode2).toContain("do not invent a different absolute prefix")

    const classic = buildOpenCodeInteractionGuidance([
      {
        name: "read",
        inputSchema: { type: "object", properties: { filePath: { type: "string" } } },
      },
      { name: "bash" },
    ], false, "/workspace/project")
    expect(classic).not.toContain("take `path` as an absolute path")
  })

  it("anchors paths to the exact workspace root", () => {
    const workspaceRoot = "/workspace/project “quoted”\nline"
    const guidance = buildOpenCodeInteractionGuidance([
      { name: "bash" },
    ], false, workspaceRoot)

    expect(guidance).toContain(`Workspace root: ${JSON.stringify(workspaceRoot)}.`)
    expect(guidance).toContain("never invent an absolute prefix")
    expect(guidance).toContain("verify uncertain paths")
  })

  it("distinguishes OpenCode execute Code Mode from the shell tool", () => {
    const withShell = buildOpenCodeInteractionGuidance([
      { name: "execute" },
      { name: "shell" },
      { name: "read" },
    ], false, "/workspace/project")
    expect(withShell).toContain("OpenCode `execute` is Code Mode JavaScript (`code`)")
    expect(withShell).toContain("it is not a shell")
    expect(withShell).toContain("call OpenCode `shell`")
    expect(withShell).toContain("Do not pass `command` to `execute`")
    expect(withShell).toContain("Call tools named in the direct list by their own names, even when a server instruction says to reach them through `execute`")
    expect(withShell).toContain("Use `execute` only for tools that appear in the host Code Mode catalog")
    expect(withShell).toContain("exact paths and signatures from that catalog or its `search` function")
    expect(withShell).toContain("call `execute` with `{ code }`")
    expect(withShell).not.toContain("including MCP server tools")

    const withBash = buildOpenCodeInteractionGuidance([
      { name: "execute" },
      { name: "bash" },
    ], false, "/workspace/project")
    expect(withBash).toContain("call OpenCode `bash`")

    const executeOnly = buildOpenCodeInteractionGuidance([
      { name: "execute" },
    ], false, "/workspace/project")
    expect(executeOnly).toContain("Do not pass `command` to `execute`")
    expect(executeOnly).not.toContain("call OpenCode `shell`")
    expect(executeOnly).not.toContain("call OpenCode `bash`")
    expect(executeOnly).toContain("host Code Mode catalog")

    const withoutExecute = buildOpenCodeInteractionGuidance([
      { name: "shell" },
    ], false, "/workspace/project")
    expect(withoutExecute).not.toContain("host Code Mode catalog")
  })

  it("prefers edit and write over shell file mutation", () => {
    const guidance = buildOpenCodeInteractionGuidance([
      { name: "bash" },
      { name: "edit" },
      { name: "write" },
    ], false, "/workspace/project")

    expect(guidance).toContain("OpenCode `edit` for targeted changes")
    expect(guidance).toContain("`write` to create files")
    expect(guidance).toContain("do not use shell, Python, or heredocs")
    expect(guidance).toContain("Never use a read result as complete file content")
    expect(guidance).toContain("output is capped, partial")
  })

  it("documents Cursor-native Task subtype mapping when subagents are advertised", () => {
    const guidance = buildOpenCodeInteractionGuidance([
      {
        name: "task",
        inputSchema: {
          properties: {
            subagent_type: { enum: ["general", "explore", "scout"] },
          },
        },
      },
    ], false, "/workspace/project")

    expect(guidance).toContain("Native Cursor Task/subagent requests are executed through OpenCode `task`")
    expect(guidance).toContain("`generalPurpose`")
    expect(guidance).toContain("`bugbot`, `security-review`, and `explore` select host `explore`")
    expect(guidance).toContain("Host `scout` is available")
    expect(guidance).toContain("local repository discovery still uses `bugbot`/`explore`")
  })

  it("documents Cursor-native Task routing through OpenCode 2 subagent", () => {
    const guidance = buildOpenCodeInteractionGuidance([
      {
        name: "subagent",
        description: "Available subagents: - explore: Fast. - general: General-purpose.",
        inputSchema: {
          properties: {
            agent: { type: "string" },
          },
        },
      },
    ], false, "/workspace/project")

    expect(guidance).toContain("Native Cursor Task/subagent requests are executed through OpenCode `subagent`")
    expect(guidance).toContain("Spawnable host agents this turn: `explore`, `general`.")
    expect(guidance).not.toContain("OpenCode `task`")
  })

  it("routes advertised skill and MCP tools through the dynamic catalog (issue #29)", () => {
    const withBoth = buildOpenCodeInteractionGuidance([
      { name: "skill" },
      { name: "context7_resolve-library-id" },
      { name: "context7_query-docs" },
      { name: "codesearch_find" },
      { name: "apply_patch" },
      { name: "read" },
      { name: "grep" },
    ], false, "/workspace/project", { knownMcpServers: ["context7", "codesearch"] })
    expect(withBoth).toContain("`skill`")
    expect(withBoth).toContain("MCP servers such as `context7`, `codesearch`")
    expect(withBoth).toContain("GetDynamicTools / CallDynamicTool")
    expect(withBoth).toContain("before Grep/Shell fallbacks")
    expect(withBoth).toContain("Do not narrate that they are unavailable")

    const skillOnly = buildOpenCodeInteractionGuidance([
      { name: "skill" },
      { name: "read" },
    ], false, "/workspace/project")
    expect(skillOnly).toContain("including `skill`")
    expect(skillOnly).not.toContain("MCP servers such as")

    const withoutExtras = buildOpenCodeInteractionGuidance([
      { name: "read" },
      { name: "grep" },
      { name: "custom_websearch" },
    ], false, "/workspace/project")
    expect(withoutExtras).not.toContain("GetDynamicTools / CallDynamicTool")

    const unconfigured = buildOpenCodeInteractionGuidance([
      { name: "context7_query-docs" },
      { name: "read" },
    ], false, "/workspace/project")
    expect(unconfigured).not.toContain("GetDynamicTools / CallDynamicTool")

    // Collision-safe aliases keep the OpenCode id on sourceName; guidance must
    // still resolve the configured MCP server from that id, not the alias.
    const aliased = buildOpenCodeInteractionGuidance([
      { name: "custom_docs", sourceName: "context7_query-docs" },
      { name: "read" },
    ], false, "/workspace/project", { knownMcpServers: ["context7"] })
    expect(aliased).toContain("MCP servers such as `context7`")
    expect(aliased).toContain("GetDynamicTools / CallDynamicTool")
  })
})

describe("extractPromptHistory", () => {
  it("keeps prior turns and drops the trailing live user message", () => {
    const history = extractPromptHistory([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "Update the anchored summary" },
    ] as LanguageModelV3CallOptions["prompt"])
    expect(history).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ])
  })

  const toolHistoryPrompt = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking the debug log and recent tool-call behavior." },
          { type: "tool-call", toolCallId: "1", toolName: "bash", input: "{}" },
          { type: "tool-call", toolCallId: "2", toolName: "grep", input: "{}" },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "1", toolName: "bash", output: { type: "text", value: "ACTUAL DEBUG LOG OUTPUT" } },
          { type: "tool-result", toolCallId: "2", toolName: "grep", output: { type: "error-text", value: "ACTUAL GREP ERROR" } },
        ],
      },
      { role: "user", content: "Continue" },
    ] as LanguageModelV3CallOptions["prompt"]

  it("omits historical tool results from normal rebases", () => {
    const history = extractPromptHistory(toolHistoryPrompt)
    expect(history).toEqual([
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: "Checking the debug log and recent tool-call behavior.",
      },
    ])
    expect(JSON.stringify(history)).not.toContain("Tool result")
    expect(JSON.stringify(history)).not.toContain("ACTUAL DEBUG LOG OUTPUT")
  })

  it("keeps compaction tool evidence as OpenCode host observations", () => {
    const history = extractPromptHistory(toolHistoryPrompt, { toolResults: "all" })
    expect(history).toEqual([
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: "Checking the debug log and recent tool-call behavior.",
      },
      {
        role: "user",
        content:
          'OpenCode host observation {"source":"opencode-tool","tool":"bash","callId":"1","status":"completed"}:\n' +
          "ACTUAL DEBUG LOG OUTPUT\n\n" +
          'OpenCode host observation {"source":"opencode-tool","tool":"grep","callId":"2","status":"error"}:\n' +
          "ACTUAL GREP ERROR",
      },
    ])
    expect(history[2]?.content).not.toContain("Tool result")
  })

  it("keeps only trailing tool results for interrupted continuation recovery", () => {
    const prompt = [
      ...toolHistoryPrompt.slice(0, -1),
      { role: "user", content: "Run one more check" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "3", toolName: "read", input: "{}" },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "3", toolName: "read", output: { type: "text", value: "LATEST FILE" } },
        ],
      },
    ] as LanguageModelV3CallOptions["prompt"]

    const history = extractPromptHistory(prompt, {
      preserveTrailingUser: true,
      toolResults: "trailing",
    })
    expect(JSON.stringify(history)).not.toContain("ACTUAL DEBUG LOG OUTPUT")
    expect(JSON.stringify(history)).toContain("LATEST FILE")
    expect(history.at(-1)).toEqual({
      role: "user",
      content:
        "Run one more check\n\n" +
        'OpenCode host observation {"source":"opencode-tool","tool":"read","callId":"3","status":"completed"}:\nLATEST FILE',
    })
  })
})

describe("buildSeedConversationState history", () => {
  it("embeds history into root_prompt_messages_json and drops system entries", () => {
    const bytes = buildSeedConversationState({
      history: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    })
    const cs = decodeMessage<any>("ConversationStateStructure", bytes)
    const root = (cs.root_prompt_messages_json ?? []).map((s: string) => JSON.parse(s))
    expect(root).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ])
  })
})

describe("groundCheckpointTurnText", () => {
  const root = "/workspace/project"
  const pathTools = [{
    name: "read",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  }]
  const filePathTools = [
    {
      name: "read",
      inputSchema: { type: "object", properties: { filePath: { type: "string" } } },
    },
    { name: "bash" },
  ]

  it("leaves a fresh turn unchanged", () => {
    expect(groundCheckpointTurnText("fix it", false, root, pathTools)).toBe("fix it")
  })

  it("restates the root on a checkpoint and requires path only for that dialect", () => {
    const grounded = groundCheckpointTurnText("fix it", true, root, pathTools)
    expect(grounded.startsWith("fix it\n\nWorkspace root:")).toBe(true)
    expect(grounded).toContain(JSON.stringify(root))
    expect(grounded).toContain("take `path` as an absolute path")
    expect(grounded).toContain("never invent an absolute prefix")
    expect(groundCheckpointTurnText(grounded, true, "/other", pathTools)).toBe(grounded)

    const classic = groundCheckpointTurnText("fix it", true, root, filePathTools)
    expect(classic).toContain("Workspace root:")
    expect(classic).not.toContain("take `path` as an absolute path")

    const inferred = groundCheckpointTurnText("fix it", true, root, [{ name: "shell" }])
    expect(inferred).toContain("take `path` as an absolute path")
    expect(groundCheckpointTurnText("fix it", true, root, [{ name: "bash" }])).not.toContain(
      "take `path` as an absolute path",
    )
  })

  it("does not invent a root when none is known", () => {
    expect(groundCheckpointTurnText("fix it", true, "  ", pathTools)).toBe("fix it")
    expect(groundCheckpointTurnText("", true, root, pathTools).startsWith("Workspace root:")).toBe(true)
  })
})
