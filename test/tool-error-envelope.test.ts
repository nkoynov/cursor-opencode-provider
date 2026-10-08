import { describe, it, expect, afterEach } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { sessionManager, type CursorSession } from "../src/session.js"
import {
  deliverContinuationResults,
  extractPromptHistory,
  extractTrailingToolResults,
  resetTurnStateForTests,
} from "../src/language-model.js"
import { decodeMessage } from "../src/protocol/messages.js"
import { parseExecServerMessage } from "../src/protocol/tools.js"
import { resetCursorShellCalls } from "../src/shell-timeout.js"

type Prompt = LanguageModelV3CallOptions["prompt"]

// OpenCode 2.0.24 `aisdk.ts` lowers a failed tool to `{ type: "text" }` holding this JSON.
const envelope = (type: string, message: string, content: unknown[] = []) =>
  JSON.stringify({ error: { type, message }, content })

const DENIED_EDIT = envelope("permission.rejected", "Permission denied: edit")
const DENIED_SHELL = envelope("permission.rejected", "Permission denied: shell")
const USER_FEEDBACK = envelope("permission.rejected", "Edit util.py instead")

function heldSession(id: string, writes: Uint8Array[]): CursorSession {
  const session = {
    sessionId: id,
    conversationId: `conv_${id}`,
    runId: `run_${id}`,
    stream: {
      write(frame: Uint8Array) { writes.push(frame); return true },
      end() {},
      frames: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
      destroy() {},
      isClosed: () => false,
    },
    frames: { next: async () => ({ done: true, value: undefined }) },
    pending: new Map(),
    blobs: new Map(),
    toolDescriptors: [],
    requestContext: { env: { workspace_paths: ["/w"] } },
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: false,
    heartbeat: null,
    expiresAt: Date.now() + 10_000,
  } as unknown as CursorSession
  sessionManager.registerSession(session)
  return session
}

const toolResult = (sid: string, execId: number, toolName: string, value: string) => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: `cursor_${sid}_${execId}`, toolName, output: { type: "text", value } }],
})

/** Delivers one OpenCode tool result to a held Run and returns the frames Cursor receives. */
function deliver(
  resultField: string,
  toolName: string,
  value: string,
  resultMetadata?: Record<string, unknown>,
): any[] {
  const sid = `${resultField}_${Math.random().toString(36).slice(2)}`
  const writes: Uint8Array[] = []
  const held = heldSession(sid, writes)
  sessionManager.registerPending(1, held, resultField, toolName, false, resultMetadata, `call_${sid}`)
  const results = extractTrailingToolResults([toolResult(sid, 1, toolName, value)] as Prompt)
  expect(deliverContinuationResults(held, results)).toBe(held)
  return writes.map((frame) => decodeMessage<any>("AgentClientMessage", frame))
}

const execResult = (frames: any[], field: string) => frames[0].exec_client_message[field]

afterEach(() => {
  sessionManager.dispose()
  resetCursorShellCalls()
  resetTurnStateForTests()
})

describe("OpenCode 2 tool error envelope", () => {
  it("is extracted as a failed result holding the host's message", () => {
    const [result] = extractTrailingToolResults([toolResult("s", 1, "edit", DENIED_EDIT)] as Prompt)
    expect(result).toMatchObject({
      execId: 1,
      output: "Permission denied: edit",
      error: "Permission denied: edit",
      hostError: { type: "permission.rejected", message: "Permission denied: edit" },
    })
  })

  it("keeps a failure with an empty message a failure", () => {
    const [result] = extractTrailingToolResults([toolResult("s", 1, "edit", envelope("tool.execution", ""))] as Prompt)
    expect(result!.error).toBe("OpenCode tool failed (tool.execution)")
  })

  it("accepts OpenCode's optional status and response on the error", () => {
    const value = JSON.stringify({
      error: { type: "provider.rate-limit", message: "slow down", status: 429, response: { body: "{}" } },
      content: [],
    })
    const [result] = extractTrailingToolResults([toolResult("s", 1, "webfetch", value)] as Prompt)
    expect(result!.error).toBe("slow down")
  })

  it("keeps the output a tool produced before it failed after the message", () => {
    const value = envelope("tool.execution", "Command failed", [{ type: "text", text: "partial line" }])
    const [result] = extractTrailingToolResults([toolResult("s", 1, "shell", value)] as Prompt)
    expect(result!.error).toBe("Command failed\n\npartial line")
  })

  it("leaves completed output that only resembles the envelope a success", () => {
    for (const value of [
      `${DENIED_EDIT}\nmore`,
      JSON.stringify({ error: { type: "permission.rejected", message: "x" }, content: [], exitCode: 0 }),
      JSON.stringify({ error: { type: "permission.rejected", message: "x" }, content: [] }, null, 2),
      JSON.stringify({ error: { message: "x" }, content: [] }),
      JSON.stringify({ error: { type: "tool.execution", message: "x", code: 200 }, content: [] }),
      JSON.stringify({ error: { message: "x", type: "tool.execution" }, content: [] }),
      JSON.stringify({ error: { type: "tool.execution", message: "x", status: "500" }, content: [] }),
      JSON.stringify({ error: { type: "tool.execution", message: "x", status: 500.5 }, content: [] }),
      JSON.stringify({ error: { type: "api", message: "x", response: { body: "", headers: {} } }, content: [] }),
    ]) {
      const [result] = extractTrailingToolResults([toolResult("s", 1, "read", value)] as Prompt)
      expect({ value, error: result!.error }).toEqual({ value, error: undefined })
    }
  })

  it("answers a denied edit with Cursor's permission_denied, not WriteSuccess", () => {
    const write = execResult(deliver("write_result", "edit", DENIED_EDIT, { path: "/w/cli.py" }), "write_result")
    expect(write.success).toBeUndefined()
    expect(write.permission_denied).toMatchObject({
      path: "/w/cli.py",
      directory: "/w",
      operation: "write",
      error: "Permission denied: edit",
    })
  })

  it("answers a user's rejection with feedback as Cursor's rejected, keeping the reason", () => {
    const write = execResult(deliver("write_result", "edit", USER_FEEDBACK, { path: "/w/cli.py" }), "write_result")
    expect(write).toEqual({ rejected: { path: "/w/cli.py", reason: "Edit util.py instead" } })
  })

  it("answers a failed edit with WriteError", () => {
    const value = envelope("tool.execution", "oldString not found in content")
    const write = execResult(deliver("write_result", "edit", value, { path: "/w/cli.py" }), "write_result")
    expect(write).toEqual({ error: { path: "/w/cli.py", error: "oldString not found in content" } })
  })

  it("answers a failed or refused read with an error, not file content", () => {
    const failed = execResult(
      deliver("read_result", "read", envelope("tool.execution", "File not found: /w/nope.py"), { path: "/w/nope.py" }),
      "read_result",
    )
    expect(failed).toEqual({ error: { path: "/w/nope.py", error: "File not found: /w/nope.py" } })
    const denied = execResult(
      deliver("read_result", "read", envelope("permission.rejected", "Permission denied: read"), { path: "/w/.env" }),
      "read_result",
    )
    expect(denied).toEqual({ rejected: { path: "/w/.env", reason: "Permission denied: read" } })
  })

  it("answers a denied shell command with a lone permission_denied event, as Cursor's client does", () => {
    const frames = deliver("shell_stream", "shell", DENIED_SHELL, {
      shell_stream: true,
      command: "rm -rf build",
      working_directory: "/w",
    })
    const events = frames.map((f) => f.exec_client_message?.shell_stream).filter(Boolean)
    expect(events).toEqual([
      { permission_denied: { command: "rm -rf build", working_directory: "/w", error: "Permission denied: shell" } },
    ])
    expect(frames.at(-1).exec_client_control_message.stream_close.id).toBe(1)
  })

  it("answers a failed shell call with stderr and a nonzero exit, not stdout and exit 0", () => {
    const frames = deliver("shell_stream", "shell", envelope("tool.execution", "workdir does not exist: /nope"), {
      shell_stream: true,
      command: "ls",
      working_directory: "/nope",
    })
    const events = frames.map((f) => f.exec_client_message?.shell_stream).filter(Boolean)
    expect(events.some((e) => e.stdout)).toBe(false)
    expect(events.find((e) => e.stderr).stderr.data).toBe("workdir does not exist: /nope")
    expect(events.find((e) => e.exit).exit.code).toBe(1)
  })

  it("answers shell_result and background spawns with their refusal arms", () => {
    const metadata = { command: "make", working_directory: "/w" }
    expect(execResult(deliver("shell_result", "shell", DENIED_SHELL, metadata), "shell_result")).toMatchObject({
      permission_denied: { command: "make", working_directory: "/w", error: "Permission denied: shell" },
    })
    expect(execResult(
      deliver("background_shell_spawn_result", "shell", envelope("permission.rejected", "not now"), metadata),
      "background_shell_spawn_result",
    )).toEqual({ rejected: { command: "make", working_directory: "/w", reason: "not now" } })
  })

  it("answers grep, MCP, ls, delete and Pi tools with their failure arms", () => {
    const failed = envelope("tool.execution", "boom")
    expect(execResult(deliver("grep_result", "grep", failed), "grep_result")).toEqual({ error: { error: "boom" } })
    expect(execResult(deliver("mcp_result", "github_search", failed), "mcp_result")).toMatchObject({ error: { error: "boom" } })
    expect(execResult(deliver("mcp_result", "github_search", envelope("permission.rejected", "Permission denied: github_search")), "mcp_result"))
      .toMatchObject({ permission_denied: { error: "Permission denied: github_search" } })
    expect(execResult(deliver("mcp_result", "github_search", USER_FEEDBACK), "mcp_result"))
      .toMatchObject({ rejected: { reason: "Edit util.py instead" } })
    const ls = parseExecServerMessage({ id: 1, ls_args: { path: "src", tool_call_id: "tc" } })!
    expect(execResult(deliver("ls_result", "read", envelope("permission.rejected", "Permission denied: read"), ls.resultMetadata), "ls_result"))
      .toEqual({ rejected: { path: "/w/src", reason: "Permission denied: read" } })
    expect(execResult(deliver("ls_result", "read", envelope("tool.execution", "EACCES: src"), ls.resultMetadata), "ls_result"))
      .toEqual({ error: { path: "/w/src", error: "EACCES: src" } })
    const del = parseExecServerMessage({ id: 1, delete_args: { path: "/w/old.txt", tool_call_id: "tc" } })!
    expect(execResult(deliver("delete_result", "shell", envelope("tool.execution", "busy"), del.resultMetadata), "delete_result"))
      .toEqual({ error: { path: "/w/old.txt", error: "busy" } })
    expect(execResult(deliver("delete_result", "shell", DENIED_SHELL, del.resultMetadata), "delete_result"))
      .toMatchObject({ permission_denied: { path: "/w/old.txt", client_visible_error: "Permission denied: shell" } })
    expect(execResult(deliver("pi_edit_result", "edit", DENIED_EDIT), "pi_edit_result"))
      .toEqual({ rejected: { reason: "Permission denied: edit" } })
    expect(execResult(deliver("pi_bash_result", "shell", DENIED_SHELL), "pi_bash_result"))
      .toEqual({ error: { error: "Permission denied: shell" } })
  })

  it("answers an unknown tool with an error carrying OpenCode's message", () => {
    const message = 'No tool named "frobnicate" is currently available. Please use a tool from the available tool list.'
    expect(execResult(deliver("mcp_result", "frobnicate", envelope("tool.unknown", message)), "mcp_result"))
      .toMatchObject({ error: { error: message } })
  })

  it("marks the envelope as a failed observation in replayed history", () => {
    const history = extractPromptHistory([
      { role: "user", content: [{ type: "text", text: "edit cli.py" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "cursor_h_1", toolName: "edit", input: "{}" }] },
      toolResult("h", 1, "edit", DENIED_EDIT),
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as Prompt, { toolResults: "all" })
    const observation = history.map((m) => m.content).find((c) => c.includes("OpenCode host observation"))!
    expect(observation).toContain('"status":"error"')
    expect(observation).toContain("Permission denied: edit")
    expect(observation).not.toContain('"content":[]')
  })
})
