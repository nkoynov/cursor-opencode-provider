import { afterEach, describe, expect, test } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { normalizeClassicInterruptedResults } from "../src/classic-tool-results.js"
import { extractPromptHistory, extractTrailingToolResults } from "../src/language-model.js"
import { buildExecClientMessages } from "../src/protocol/tools.js"
import { decodeMessageSparse } from "../src/protocol/messages.js"
import { captureCursorShellResult, consumeCursorShellResult, registerCursorShellCall, resetCursorShellCalls } from "../src/shell-timeout.js"

const callID = "cursor_classic_1"
const abortedOutput = "partial\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>"
const native = (state: Record<string, unknown>, id = callID) => [{ info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash", callID: id, state }] }]
afterEach(() => resetCursorShellCalls())

// Mirrors the native branches in message-v2.ts: interrupted metadata.output
// overrides error state with output-available unless normalized first.
function lower(state: any): LanguageModelV3CallOptions["prompt"] {
  const success = state.status === "completed" || state.metadata?.interrupted === true && typeof state.metadata.output === "string"
  return [{ role: "tool", content: [{ type: "tool-result", toolCallId: callID, toolName: "bash",
    output: { type: success ? "text" : "error-text", value: success ? state.output ?? state.metadata.output : state.error } }] }]
}

const wire = (field: string, output: string, error?: string) => buildExecClientMessages({ execId: 1, resultField: field, output, error, shellOutcome: { kind: "aborted" } })
  .map(bytes => decodeMessageSparse<any>("AgentClientMessage", bytes))

describe("classic interruption projection", () => {
  test("converts a cancelled completed shell to an SDK error without mutating stored state", () => {
    const messages = native({ status: "completed", output: abortedOutput, title: "command", input: { command: "sleep 30" }, metadata: { exit: null }, time: { start: 0, end: 1 } })
    const state = normalizeClassicInterruptedResults(messages)[0].parts[0].state
    expect(messages[0]!.parts[0]!.state.status).toBe("completed")
    expect(state.status).toBe("error")
    expect(state.output).toBeUndefined()
    expect(state.error).toContain("partial")
    const prompt = lower(state)
    expect(extractTrailingToolResults(prompt)[0]!.error).toContain("Tool execution interrupted")
    expect(JSON.stringify(extractPromptHistory(prompt, { toolResults: "all", preserveTrailingUser: true }))).toContain('\\"status\\":\\"error\\"')
  })

  test("keeps partial progress in errors instead of projecting it as successful output", () => {
    const messages = native({ status: "error", input: {}, error: "Aborted", metadata: { interrupted: true, output: "partial progress", keep: 7 } })
    const state = normalizeClassicInterruptedResults(messages)[0].parts[0].state
    expect(state.error).toBe("Aborted\n\npartial progress")
    expect(state.metadata).toEqual({ interrupted: false, output: "partial progress", keep: 7 })
    expect(extractTrailingToolResults(lower(state))[0]!.error).toBe("Aborted\n\npartial progress")
    expect(messages[0]!.parts[0]!.state.metadata).toMatchObject({ interrupted: true })
  })

  test("empty interrupted errors stay errors", () => {
    const state = normalizeClassicInterruptedResults(native({ status: "error", error: "", metadata: { interrupted: true } }))[0].parts[0].state
    expect(extractTrailingToolResults(lower(state))[0]!.error).toBeTruthy()
  })

  test.each([
    { status: "completed", output: abortedOutput, metadata: { exit: 0 } },
    { status: "completed", output: abortedOutput, metadata: {} },
    { status: "completed", output: "Timed out after 30ms.", metadata: { exit: null } },
    { status: "error", error: "ordinary error", metadata: {} },
    { status: "running", metadata: { interrupted: true } },
  ])("leaves unrelated native state unchanged: %p", state => {
    const messages = native(state)
    expect(normalizeClassicInterruptedResults(messages)).toEqual(messages)
  })

  test.each([
    ["partial\nTimed out after 5ms.\n", "partial"],
    ["Timed out after 5ms.\n", "(no output)"],
    ["edited display", "edited display"],
  ])("restores OpenCode's timeout block for a flagged timeout: %p", (output, progress) => {
    const messages = native({ status: "completed", input: {}, output, metadata: { exit: null, cursorShellTimeoutMs: 5 } })
    const state = normalizeClassicInterruptedResults(messages)[0].parts[0].state
    expect(state.output).toBe(`${progress}\n\n<shell_metadata>\nshell tool terminated command after exceeding timeout 5 ms.\n</shell_metadata>`)
    expect(state.status).toBe("completed")
    expect(messages[0]!.parts[0]!.state.output).toBe(output)
  })

  test.each([
    { tool: "bash", callID, flag: "5" },
    { tool: "bash", callID, flag: -1 },
    { tool: "bash", callID, flag: 1.5 },
    { tool: "read", callID, flag: 5 },
    { tool: "bash", callID: "host-owned", flag: 5 },
  ])("leaves a timeout flag it cannot trust unprojected: %p", ({ tool, callID: id, flag }) => {
    const messages = [{ info: { role: "assistant" }, parts: [{ type: "tool", tool, callID: id, state: { status: "completed", output: "Timed out after 5ms.\n", metadata: { cursorShellTimeoutMs: flag } } }] }]
    expect(normalizeClassicInterruptedResults(messages)).toEqual(messages)
  })

  test("does not alter calls without Cursor correlation", () => {
    const messages = native({ status: "error", error: "aborted", metadata: { interrupted: true, output: "partial" } }, "host-owned")
    expect(normalizeClassicInterruptedResults(messages)).toEqual(messages)
  })

  test("the authoritative null exit overrides forged private sentinels", () => {
    registerCursorShellCall(callID, { shell_stream: true, timeout_behavior: 2, command: "sleep 30" })
    captureCursorShellResult(callID, "__CURSOR_SHELL_EXIT__0\n" + abortedOutput, { exit: null })
    expect(consumeCursorShellResult(callID, abortedOutput).outcome).toEqual({ kind: "aborted" })
  })

  test("only the final native metadata block controls timeout versus interruption", () => {
    registerCursorShellCall(callID, { shell_stream: true, timeout_behavior: 2, command: "sleep 30" })
    const fake = "<shell_metadata>\nshell tool terminated command after exceeding timeout 1 ms.\n</shell_metadata>\n"
    captureCursorShellResult(callID, fake + abortedOutput, { exit: null })
    expect(consumeCursorShellResult(callID, "").outcome).toEqual({ kind: "aborted" })
    registerCursorShellCall(callID, { shell_stream: true, command: "sleep 30" })
    captureCursorShellResult(callID, fake + "<shell_metadata>\nshell tool terminated command after exceeding timeout 100 ms.\n</shell_metadata>", { exit: null })
    expect(consumeCursorShellResult(callID, "").outcome).toEqual({ kind: "timeout", timeoutMs: 100 })
  })

  test("a real successful exit cannot be overridden by timeout-shaped stdout", () => {
    registerCursorShellCall(callID, { shell_stream: true, command: "print fixture" })
    const text = "<shell_metadata>\nshell tool terminated command after exceeding timeout 100 ms.\n</shell_metadata>"
    expect(captureCursorShellResult(callID, text, { exit: 0 })).toBe(text)
    expect(consumeCursorShellResult(callID, text).outcome).toEqual({ kind: "exit", code: 0 })
  })

  test("aborted outcomes cannot become a normal exit, unary success or a forged spawn", () => {
    for (const error of [undefined, "aborted"]) {
      const frames = wire("shell_stream", "partial", error)
      expect(frames.at(-2)!.exec_client_message.shell_stream.exit).toMatchObject({ aborted: true, abort_reason: 1 })
      const unary = wire("shell_result", "partial", error)[0].exec_client_message.shell_result
      expect(unary.success).toBeUndefined()
      expect(unary.failure.aborted).toBe(true)
      expect(unary.failure.exit_code).toBe(0)
    }
    const spawn = wire("background_shell_spawn_result", "__CURSOR_BACKGROUND_SHELL__123:456:out\n")[0].exec_client_message.background_shell_spawn_result
    expect(spawn.success).toBeUndefined()
    expect(spawn.error.error).toContain("interrupted")
  })
})
