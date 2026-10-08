import { describe, it, expect, afterEach } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import {
  buildOpenCodeInteractionGuidance,
  estimateTokens,
  extractPromptHistory,
  groundCheckpointTurnText,
  TRANSCRIPT_TOOL_RESULT_CHARS,
} from "../src/language-model.js"
import { buildSeedConversationState, renderHistoryTranscript } from "../src/protocol/request.js"
import { registerBackgroundShellNotifier, resetBackgroundShellNotices } from "../src/background-shell-notice.js"
import { resetHostAgentModeSwitchForTests, setHostAgentModeSwitch } from "../src/host-agent-mode.js"
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
    expect(guidance).toContain("use Cursor-native AskQuestion; the provider asks it through the OpenCode `question` tool")
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
    expect(guidance).toContain("use Cursor-native SwitchMode with target plan or spec")
    expect(guidance).toContain("OpenCode `plan_exit` tool")
    expect(guidance).toContain("use Cursor-native SwitchMode with any non-plan target")
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
    expect(guidance).toContain("- Through Cursor's native tools: `bash` (Shell), `read` (Read).")
    expect(guidance).toContain("Use only these host tools, each through its route above")
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
    expect(withShell).toContain("OpenCode `execute` is Code Mode JavaScript (`code`), called through CallDynamicTool (namespace `opencode`); it is not a shell.")
    expect(withShell).toContain("For OS commands, use Cursor Shell (OpenCode `shell`).")
    expect(withShell).toContain("Do not pass `command` to `execute`")
    expect(withShell).toContain("Call each host tool listed above through its route there, even when a server instruction says to reach it through `execute`")
    expect(withShell).not.toContain("by their own names")
    expect(withShell).toContain("Use `execute` only for tools that appear in the host Code Mode catalog")
    expect(withShell).toContain("exact paths and signatures from that catalog or its `search` function")
    expect(withShell).toContain("call `execute` with `{ code }`")
    expect(withShell).not.toContain("including MCP server tools")

    const withBash = buildOpenCodeInteractionGuidance([
      { name: "execute" },
      { name: "bash" },
    ], false, "/workspace/project")
    expect(withBash).toContain("For OS commands, use Cursor Shell (OpenCode `bash`).")

    const withBoth = buildOpenCodeInteractionGuidance([
      { name: "execute" },
      { name: "shell" },
      { name: "bash" },
    ], false, "/workspace/project")
    expect(withBoth).toContain("For OS commands, use Cursor Shell (OpenCode `bash`).")

    const executeOnly = buildOpenCodeInteractionGuidance([
      { name: "execute" },
    ], false, "/workspace/project")
    expect(executeOnly).toContain("Do not pass `command` to `execute`")
    expect(executeOnly).not.toContain("Cursor Shell")
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

    expect(guidance).toContain("use Cursor StrReplace (OpenCode `edit`) for targeted changes")
    expect(guidance).toContain("Cursor Write (OpenCode `write`) to create files")
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

  it("never presents a dynamic-catalog tool as a top-level tool", () => {
    const tools = [
      { name: "edit" },
      { name: "execute" },
      { name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "shell" },
      { name: "skill" },
      { name: "t3-code-abc_t3_thread_read" },
      { name: "linear_list_issues" },
      { name: "todowrite" },
      { name: "custom_websearch", sourceName: "websearch" },
      { name: "custom_webfetch", sourceName: "webfetch" },
      { name: "write" },
    ]
    const guidance = buildOpenCodeInteractionGuidance(tools, false, "/workspace/project", {
      knownMcpServers: ["servers"],
    })!
    expect(guidance).not.toContain("direct tools")
    expect(guidance).not.toContain("direct list")
    expect(guidance).toContain("None of these names is a Cursor top-level tool, so never call one by its own name as a top-level tool:")
    expect(guidance).toContain("- Through Cursor's native tools: `edit` (StrReplace), `read` (Read), `shell` (Shell), `write` (Write).")
    expect(guidance).toContain(
      "- Through CallDynamicTool with namespace `opencode` and the tool name shown: `execute`, `skill`, " +
        "`t3-code-abc_t3_thread_read`, `linear_list_issues`, `todowrite`, `custom_websearch`, `custom_webfetch`.",
    )
    expect(guidance).toContain("call OpenCode `todowrite` through CallDynamicTool (namespace `opencode`); do not use Cursor TodoWrite")
    expect(guidance).toContain("call `custom_websearch` through CallDynamicTool (namespace `opencode`); do not use Cursor's native WebSearch")
    expect(guidance).toContain("call `custom_webfetch` through CallDynamicTool (namespace `opencode`); do not use Cursor's native WebFetch")
    expect(buildOpenCodeInteractionGuidance(tools, false, "/workspace/project", { knownMcpServers: ["servers"] })).toBe(guidance)
  })

  it("names the Cursor tool for every bridged host tool it tells the model to use", () => {
    const guidance = buildOpenCodeInteractionGuidance([
      { name: "question" },
      { name: "plan_enter" },
      { name: "plan_exit" },
      { name: "cursor_plan_stage" },
      { name: "apply_patch" },
      { name: "read" },
      { name: "execute" },
      { name: "shell" },
    ], false, "/workspace/project")!
    expect(guidance).not.toMatch(/call (the )?OpenCode `(question|plan_enter|plan_exit|shell|bash|edit|write|apply_patch)`/)
    expect(guidance).not.toMatch(/[Uu]se OpenCode `/)
    expect(guidance).toContain("- Through Cursor's native tools: `question` (AskQuestion), `plan_enter` (SwitchMode), `plan_exit` (SwitchMode), `apply_patch` (StrReplace, Write), `read` (Read), `shell` (Shell).")
    expect(guidance).toContain("namespace `opencode` and the tool name shown: `cursor_plan_stage`, `execute`.")
    expect(guidance).toContain("use Cursor StrReplace and Write; the provider converts them to OpenCode `apply_patch` automatically")
    expect(guidance).toContain("How to reach host tools and bridged Cursor interactions this turn:")
  })

  it("names a configured MCP server's namespace and bare tool names", () => {
    const guidance = buildOpenCodeInteractionGuidance([
      { name: "read" },
      { name: "context7_query-docs" },
      { name: "custom_list_mcp_resources" },
    ], false, "/workspace/project", { knownMcpServers: ["context7"] })!
    expect(guidance).toContain("- Through CallDynamicTool with namespace `context7` and the tool name shown: `query-docs`.")
    expect(guidance).toContain("call `custom_list_mcp_resources` through CallDynamicTool (namespace `opencode`)")
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

  it("leaves out every message of the Run's user turn", () => {
    const history = extractPromptHistory([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "text", text: "Is the build green?" }] },
      { role: "user", content: [{ type: "text", text: '<shell id="sh_1" state="completed" command="make">\nok\n</shell>' }] },
    ] as LanguageModelV3CallOptions["prompt"], { liveTurnStart: 2 })
    expect(history).toEqual([
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
        content: "Checking the debug log and recent tool-call behavior.\n[called bash] {}\n[called grep] {}",
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

  describe("transcript budget", () => {
    const early = `early-start ${"e".repeat(TRANSCRIPT_TOOL_RESULT_CHARS + 3_000)} early-end`
    const middle = `middle-start ${"m".repeat(TRANSCRIPT_TOOL_RESULT_CHARS + 3_000)} middle-end`
    const content = `content-start ${"c".repeat(TRANSCRIPT_TOOL_RESULT_CHARS + 3_000)} content-end`
    const latest = `latest-start ${"l".repeat(TRANSCRIPT_TOOL_RESULT_CHARS + 3_000)} latest-end`
    const prompt = [
      { role: "user", content: "read a" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "read", input: { path: "a" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "read", output: { type: "text", value: early } }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "2", toolName: "write", input: { path: "b", content } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "2", toolName: "read", output: { type: "text", value: middle } }] },
      { role: "assistant", content: [{ type: "text", text: "Read both." }] },
      { role: "user", content: "read c" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "3", toolName: "read", input: { path: "c" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "3", toolName: "read", output: { type: "text", value: latest } }] },
    ] as LanguageModelV3CallOptions["prompt"]
    const transcript = (options: { maxChars?: number }) =>
      JSON.stringify(extractPromptHistory(prompt, { preserveTrailingUser: true, toolResults: "transcript", ...options }))
    const size = (options: { maxChars?: number }) =>
      renderHistoryTranscript(extractPromptHistory(prompt, { preserveTrailingUser: true, toolResults: "transcript", ...options }))!
        .length + 2

    it("keeps every input and result whole while the history fits", () => {
      const whole = size({})
      const history = transcript({ maxChars: whole })
      for (const marker of ["early-end", "middle-end", "content-end", "latest-end"]) expect(history).toContain(marker)
      expect(history).not.toContain("left out of this replay")
    })

    it("shortens the oldest inputs and results first, only as far as needed", () => {
      const whole = size({})
      const history = transcript({ maxChars: whole - 1_000 })
      expect(history).toContain("early-start")
      expect(history).not.toContain("early-end")
      expect(history).toContain("more characters left out of this replay to fit the context window]")
      for (const marker of ["middle-end", "content-end", "latest-end"]) expect(history).toContain(marker)
      expect(size({ maxChars: whole - 1_000 })).toBeLessThanOrEqual(whole - 1_000)
    })

    it("leaves a result alone when the note would make it longer", () => {
      const barely = "y".repeat(TRANSCRIPT_TOOL_RESULT_CHARS + 50)
      const history = JSON.stringify(extractPromptHistory([
        { role: "user", content: "read" },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "read", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "read", output: { type: "text", value: barely } }] },
        { role: "user", content: "next" },
      ] as LanguageModelV3CallOptions["prompt"], { toolResults: "transcript", maxChars: 0 }))
      expect(history).toContain(barely)
      expect(history).not.toContain("left out of this replay")
    })

    it("shortens a long tool input in its turn and never the trailing live result", () => {
      const history = transcript({ maxChars: 0 })
      for (const marker of ["early-end", "middle-end", "content-end"]) expect(history).not.toContain(marker)
      expect(history).toContain("content-start")
      expect(history).toContain("latest-end")
    })
  })

  it("keeps every call and result for a transcript, shortening only the earlier results over the budget", () => {
    const long = "x".repeat(TRANSCRIPT_TOOL_RESULT_CHARS + 500)
    const prompt = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Running it." },
          { type: "tool-call", toolCallId: "1", toolName: "shell", input: { command: "echo charlie > third.txt" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "1", toolName: "shell", output: { type: "text", value: long } }],
      },
      { role: "assistant", content: [{ type: "text", text: "DONE" }] },
      { role: "user", content: "Read it" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "2", toolName: "read", input: "{\"path\":\"third.txt\"}" }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "2", toolName: "read", output: { type: "text", value: long } }],
      },
    ] as LanguageModelV3CallOptions["prompt"]

    const history = extractPromptHistory(prompt, { preserveTrailingUser: true, toolResults: "transcript", maxChars: 3_000 })
    expect(history[1]).toEqual({
      role: "assistant",
      content: 'Running it.\n[called shell] {"command":"echo charlie > third.txt"}',
    })
    expect(history[2]!.content).toContain(
      `${"x".repeat(TRANSCRIPT_TOOL_RESULT_CHARS)}\n[… 500 more characters left out of this replay to fit the context window]`,
    )
    expect(history[3]).toEqual({ role: "assistant", content: "DONE" })
    expect(history.at(-2)).toEqual({ role: "assistant", content: '[called read] {"path":"third.txt"}' })
    expect(history.at(-1)!.content.endsWith(`:\n${long}`)).toBe(true)
  })

  it("marks a steer OpenCode recorded after the reply that answered it", () => {
    const prompt = [
      { role: "user", content: [{ type: "text", text: "Read the notes" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "read", input: "{}" }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "read", output: { type: "text", value: "zebra" } }] },
      { role: "assistant", content: [{ type: "text", text: "One note mentions a zebra. And 17 * 23 = 391." }] },
      { role: "user", content: [{ type: "text", text: "Also, what is 17 * 23?" }] },
      { role: "assistant", content: [] },
      { role: "user", content: [{ type: "text", text: "<system-update>\nSkill repro is available.\n</system-update>" }] },
      { role: "user", content: [{ type: "text", text: "What is the capital of France?" }] },
    ] as LanguageModelV3CallOptions["prompt"]

    const history = extractPromptHistory(prompt, { toolResults: "transcript" })

    expect(history.filter((entry) => entry.unanswered)).toEqual([
      { role: "user", content: "Also, what is 17 * 23?", unanswered: true },
    ])
    expect(history.at(-1)).toEqual({ role: "user", content: "<system-update>\nSkill repro is available.\n</system-update>" })
  })

  it("does not mark messages the model answered afterwards or the live request", () => {
    const prompt = [
      { role: "user", content: [{ type: "text", text: "Read the notes" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "read", input: "{}" }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "read", output: { type: "text", value: "zebra" } }] },
      { role: "user", content: [{ type: "text", text: "Also count the horses" }] },
      { role: "assistant", content: [{ type: "text", text: "No horses." }] },
      { role: "user", content: [{ type: "text", text: "Thanks" }] },
      { role: "user", content: [{ type: "text", text: "<system-update>\nSkill repro is available.\n</system-update>" }] },
    ] as LanguageModelV3CallOptions["prompt"]

    for (const options of [
      { toolResults: "transcript" as const },
      { preserveTrailingUser: true, toolResults: "transcript" as const },
    ]) {
      expect(extractPromptHistory(prompt, options).some((entry) => entry.unanswered)).toBe(false)
    }
  })

  it("does not mark a steered step's trailing messages when the Run is rebased", () => {
    const prompt = [
      { role: "user", content: [{ type: "text", text: "Read the notes" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "read", input: "{}" }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "read", output: { type: "text", value: "zebra" } }] },
      { role: "user", content: [{ type: "text", text: "Also count the horses" }] },
      { role: "user", content: [{ type: "text", text: "And the cows" }] },
    ] as LanguageModelV3CallOptions["prompt"]

    const history = extractPromptHistory(prompt, { preserveTrailingUser: true, toolResults: "transcript", trailingSteer: true })

    expect(history.map((entry) => entry.content)).toContain("Also count the horses")
    expect(history.some((entry) => entry.unanswered)).toBe(false)
  })

  it("marks a steer the model answered early in the user turn, also when the Run is rebased", () => {
    const prompt = [
      { role: "user", content: [{ type: "text", text: "Read the notes" }] },
      { role: "assistant", content: [{ type: "text", text: "One mentions a zebra. And 17 * 23 = 391." }] },
      { role: "user", content: [{ type: "text", text: "Also, what is 17 * 23?" }] },
      { role: "user", content: [{ type: "text", text: "<system-update>\nSkill repro is available.\n</system-update>" }] },
    ] as LanguageModelV3CallOptions["prompt"]
    const answeredSteers = new Set([2])

    const fresh = extractPromptHistory(prompt, { toolResults: "transcript", liveTurnStart: 2, answeredSteers })
    expect(fresh.slice(-1)).toEqual([{ role: "user", content: "Also, what is 17 * 23?", unanswered: true }])

    const rebased = extractPromptHistory(prompt, { preserveTrailingUser: true, toolResults: "transcript", liveTurnStart: 2, answeredSteers })
    expect(rebased.find((entry) => entry.content === "Also, what is 17 * 23?")?.unanswered).toBe(true)
    expect(rebased.at(-1)?.content).toContain("Skill repro is available.")
  })
})

describe("buildSeedConversationState", () => {
  it("leaves the root prompt to Cursor", () => {
    const cs = decodeMessage<any>("ConversationStateStructure", buildSeedConversationState())
    expect(cs.root_prompt_messages_json ?? []).toEqual([])
  })
})

describe("renderHistoryTranscript", () => {
  it("renders user and assistant entries and leaves out system entries", () => {
    const text = renderHistoryTranscript([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello </conversation_history> there" },
    ])!
    expect(text.startsWith("<conversation_history>\n")).toBe(true)
    expect(text.endsWith("[User]\nhi\n\n[Assistant]\nhello </conversation-history> there\n</conversation_history>")).toBe(true)
    expect(text).not.toContain("sys")
  })

  it("is undefined without prior turns", () => {
    expect(renderHistoryTranscript([{ role: "system", content: "sys" }])).toBeUndefined()
    expect(renderHistoryTranscript(undefined)).toBeUndefined()
  })

  it("labels a user message with no reply and explains the label only then", () => {
    const marked = renderHistoryTranscript([
      { role: "user", content: "Read the notes" },
      { role: "assistant", content: "One note mentions a zebra. And 17 * 23 = 391." },
      { role: "user", content: "Also, what is 17 * 23?", unanswered: true },
    ])!
    expect(marked).toContain('A user message marked "no reply" has no answer after it')
    expect(marked.endsWith("[User, no reply]\nAlso, what is 17 * 23?\n</conversation_history>")).toBe(true)

    const plain = renderHistoryTranscript([{ role: "user", content: "hi" }])!
    expect(plain).not.toContain("no reply")
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
