import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { encodeMessage } from "../src/protocol/messages.js"
import { toolsToDescriptors } from "../src/protocol/tools.js"
import { applyExecControl, deliverContinuationResults, pump, resetTurnStateForTests } from "../src/language-model.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import {
  displayToolCallMutates,
  readOnlyShellCommand,
  readOnlyToolName,
  toolCallOrderTiming,
} from "../src/tool-call-order.js"

const frame = (message: Record<string, unknown>): Frame => ({
  flags: 0,
  payload: encodeMessage("AgentServerMessage", message),
})
const started = (callId: string, toolCall: Record<string, unknown>) =>
  frame({ interaction_update: { tool_call_started: { call_id: callId, tool_call: toolCall } } })
const listed = (count: number) => frame({ interaction_update: { tool_requests_listed: { call_count: count } } })
const shellStarted = (callId: string, command: string) =>
  started(callId, { shell_tool_call: { args: { command, tool_call_id: callId } } })
const shellExec = (id: number, callId: string, command: string) =>
  frame({ exec_server_message: { id, shell_stream_args: { command, tool_call_id: callId } } })
const shell = (id: number, callId: string, command: string) => [shellStarted(callId, command), shellExec(id, callId, command)]
const read = (id: number, callId: string, target: string) => [
  started(callId, { read_tool_call: { args: { path: target } } }),
  frame({ exec_server_message: { id, read_args: { path: target, tool_call_id: callId } } }),
]
const editStarted = (callId: string, target: string) => started(callId, { edit_tool_call: { args: { path: target } } })
const editRead = (id: number, callId: string, target: string) =>
  frame({ exec_server_message: { id, read_args: { path: target, tool_call_id: callId } } })
const editWrite = (id: number, callId: string, target: string) =>
  frame({ exec_server_message: { id, write_args: { path: target, file_text: "new\n", tool_call_id: callId } } })

function scriptedFrames(initial: Frame[]) {
  const queue = [...initial]
  let waiting: ((result: IteratorResult<Frame>) => void) | undefined
  const frames: AsyncIterator<Frame> = {
    next: () => {
      const next = queue.shift()
      if (next) return Promise.resolve({ done: false, value: next })
      return new Promise((resolve) => { waiting = resolve })
    },
  }
  return {
    frames,
    push(next: Frame) {
      if (waiting) {
        const resolve = waiting
        waiting = undefined
        resolve({ done: false, value: next })
      } else queue.push(next)
    },
  }
}

const roots: string[] = []
function fakeSession(frames: AsyncIterator<Frame>): CursorSession {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ordered-tools-"))
  roots.push(root)
  const definitions = ["read", "write", "edit", "bash"].map((name) => ({ name, description: name }))
  const tools = toolsToDescriptors(definitions, "opencode", [])
  return {
    sessionId: "ordered",
    conversationId: "ordered-conversation",
    stream: {
      write() {},
      end() {},
      destroy() {},
      isClosed: () => false,
      frames: () => ({ [Symbol.asyncIterator]: () => frames }),
    } as any,
    frames,
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolCatalog: definitions,
    knownMcpServers: [],
    toolDescriptors: tools,
    requestContext: { tools, env: { workspace_paths: [root] } },
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: true,
    heartbeat: null,
    expiresAt: Date.now() + 10_000,
  } as unknown as CursorSession
}
const rootOf = (session: CursorSession) => (session.requestContext.env as { workspace_paths: string[] }).workspace_paths[0]!

async function pumpOnce(session: CursorSession) {
  const parts: any[] = []
  const controller = {
    enqueue(part: unknown) { parts.push(part) },
    error(error: Error) { throw error },
  } as unknown as ReadableStreamDefaultController<any>
  await pump(session, controller, { textId: "text", reasoningId: "reasoning" })
  return parts
}

const calls = (parts: any[]) => parts.filter((p) => p.type === "tool-call").map((p) => `${p.toolName}#${p.toolCallId.split("_").pop()}`)
const finishes = (parts: any[]) => parts.filter((p) => p.type === "finish").map((p) => p.finishReason.unified)

/** OpenCode ran the step's calls: hand every pending result back, as the next doStream does. */
function deliverAll(session: CursorSession) {
  const results = [...session.pending.entries()].map(([execId, pending]) => ({
    toolCallId: `cursor_${session.sessionId}_${execId}`,
    sessionId: session.sessionId,
    execId,
    toolName: pending.toolName ?? "bash",
    output: "ok",
  }))
  expect(deliverContinuationResults(session, results)).toBe(session)
}

describe("ordered tool calls", () => {
  afterEach(() => {
    sessionManager.dispose()
    resetTurnStateForTests()
    toolCallOrderTiming.releaseQuietMs = 15_000
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it("runs a command written after an edit only once the edit's result is back", async () => {
    // Live order: Cursor answers the edit's read, and its write comes back after the command's exec.
    const script = scriptedFrames([])
    const session = fakeSession(script.frames)
    const target = path.join(rootOf(session), "NOTES.md")
    for (const next of [
      editStarted("edit", target),
      editRead(1, "edit", target),
      ...shell(2, "commit", "git commit -am notes"),
      listed(2),
      editWrite(3, "edit", target),
    ]) script.push(next)

    const first = await pumpOnce(session)
    expect(calls(first)).toEqual(["write#3"])
    expect(finishes(first)).toEqual(["tool-calls"])

    deliverAll(session)
    const second = await pumpOnce(session)
    expect(calls(second)).toEqual(["bash#2"])
    expect(finishes(second)).toEqual(["tool-calls"])
    expect(session.toolCallOrder?.deferred).toEqual([])
  })

  it("waits for an edit whose read goes through the host before running the next command", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ordered-outside-"))
    roots.push(outside)
    const target = path.join(outside, "memory.md")
    fs.writeFileSync(target, "old\n")
    const script = scriptedFrames([])
    const session = fakeSession(script.frames)
    for (const next of [
      editStarted("edit", target),
      editRead(1, "edit", target),
      ...shell(2, "post", "gh pr comment 1 --body-file memory.md"),
      listed(2),
    ]) script.push(next)

    const first = await pumpOnce(session)
    expect(calls(first)).toEqual(["read#1"])

    deliverAll(session)
    const pumping = pumpOnce(session)
    await new Promise((resolve) => setTimeout(resolve, 50))
    script.push(editWrite(3, "edit", target))
    const second = await pumping
    expect(calls(second)).toEqual(["edit#3"])

    deliverAll(session)
    const third = await pumpOnce(session)
    expect(calls(third)).toEqual(["bash#2"])
  })

  it("keeps read-only calls together and runs a state-changing call between them alone", async () => {
    const script = scriptedFrames([])
    const session = fakeSession(script.frames)
    const root = rootOf(session)
    for (const name of ["a", "b", "c"]) fs.writeFileSync(path.join(root, name), name)
    for (const next of [
      listed(4),
      ...read(1, "ra", path.join(root, "a")),
      ...shell(2, "status", "git status --short"),
      ...shell(3, "touch", "touch out.txt"),
      ...read(4, "rc", path.join(root, "c")),
    ]) script.push(next)

    const first = await pumpOnce(session)
    expect(calls(first)).toEqual(["read#1", "bash#2"])
    deliverAll(session)
    const second = await pumpOnce(session)
    expect(calls(second)).toEqual(["bash#3"])
    deliverAll(session)
    const third = await pumpOnce(session)
    expect(calls(third)).toEqual(["read#4"])
    expect(finishes(third)).toEqual(["tool-calls"])
  })

  it("closes a resumed step on Cursor's count instead of waiting for a quiet Run", async () => {
    const script = scriptedFrames([])
    const session = fakeSession(script.frames)
    const root = rootOf(session)
    for (const name of ["a", "b"]) fs.writeFileSync(path.join(root, name), name)
    // Live order: Cursor lists the count after the step's first execs.
    for (const next of [
      started("lookup", { get_mcp_tools_tool_call: {} }),
      listed(1),
      frame({ interaction_update: { tool_call_completed: { call_id: "lookup", tool_call: { get_mcp_tools_tool_call: {} } } } }),
      ...shell(1, "mk", "mkdir -p out"),
      ...read(2, "ra", path.join(root, "a")),
      listed(3),
      ...read(3, "rb", path.join(root, "b")),
    ]) script.push(next)

    const first = await pumpOnce(session)
    expect(calls(first)).toEqual(["bash#1"])
    deliverAll(session)
    const startedAt = Date.now()
    const second = await pumpOnce(session)
    expect(calls(second)).toEqual(["read#2", "read#3"])
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it("runs the read-only calls held behind a state-changing call together", async () => {
    const script = scriptedFrames([])
    const session = fakeSession(script.frames)
    const root = rootOf(session)
    for (const name of ["a", "b", "c"]) fs.writeFileSync(path.join(root, name), name)
    const target = path.join(root, "NOTES.md")
    // The reads arrive while the edit's write is still to come, so they are held in the same pass.
    for (const next of [
      editStarted("edit", target),
      editRead(1, "edit", target),
      ...read(2, "ra", path.join(root, "a")),
      ...read(3, "rb", path.join(root, "b")),
      ...read(4, "rc", path.join(root, "c")),
      listed(4),
      editWrite(5, "edit", target),
    ]) script.push(next)

    expect(calls(await pumpOnce(session))).toEqual(["write#5"])
    expect(session.toolCallOrder?.deferred.map((exec) => exec.execId)).toEqual([2, 3, 4])
    deliverAll(session)
    const second = await pumpOnce(session)
    expect(calls(second)).toEqual(["read#2", "read#3", "read#4"])
    expect(finishes(second)).toEqual(["tool-calls"])
  })

  it("forgets a held exec that Cursor aborts", async () => {
    const script = scriptedFrames([...shell(1, "a", "touch a"), ...shell(2, "b", "touch b"), listed(2)])
    const session = fakeSession(script.frames)

    const first = await pumpOnce(session)
    expect(calls(first)).toEqual(["bash#1"])
    const second = scriptedFrames([])
    session.frames = second.frames
    applyExecControl(session, { abort: { id: 2 } }, "test")
    expect(session.toolCallOrder?.deferred).toEqual([])
    expect(session.toolCallOrder?.calls.map((call) => call.callId)).toEqual(["a"])
  })

  it("releases a held exec when the Run makes no progress", async () => {
    toolCallOrderTiming.releaseQuietMs = 100
    // `x` never gets an exec or a completion, so nothing would release `y`.
    const script = scriptedFrames([shellStarted("x", "touch x"), ...shell(1, "y", "touch y")])
    const session = fakeSession(script.frames)

    const parts = await pumpOnce(session)
    expect(calls(parts)).toEqual(["bash#1"])
  })
})

describe("tool call classification", () => {
  it("treats reads, searches, subagents and waits as read-only", () => {
    for (const variant of ["read_tool_call", "grep_tool_call", "glob_tool_call", "task_tool_call", "await_tool_call", "web_fetch_tool_call"]) {
      expect(displayToolCallMutates(variant, {})).toBe(false)
    }
    for (const variant of ["edit_tool_call", "delete_tool_call", "pi_write_tool_call", "generate_image_tool_call", "unknown_tool_call"]) {
      expect(displayToolCallMutates(variant, {})).toBe(true)
    }
    expect(displayToolCallMutates("shell_tool_call", {})).toBeUndefined()
  })

  it("classifies MCP tools by name, defaulting to state-changing", () => {
    for (const name of ["linear_list_issues", "slack_slack_read_channel", "linear_get_issue", "t3-code-1_t3_thread_read", "t3-code-1_delegate_task", "skill"]) {
      expect(readOnlyToolName(name)).toBe(true)
    }
    for (const name of [
      "execute",
      "linear_save_issue",
      "slack_slack_send_message",
      "t3-code-1_t3_thread_send",
      "linear_mark_notification",
      "linear_update_issue_status",
      "database_find_or_create_record",
    ]) {
      expect(readOnlyToolName(name)).toBe(false)
    }
    expect(displayToolCallMutates("mcp_tool_call", {}, "linear_save_issue")).toBe(true)
  })

  it("accepts only shell lines it can tell are read-only", () => {
    for (const command of [
      "git status",
      "git -C /etc/nixos --no-pager log --oneline -5",
      "rg -n foo src | head -20",
      "cd src && ls -la",
      "cat a.txt 2>/dev/null",
      "git diff HEAD~1 --stat 2>&1",
      "sed -n 10,40p file.ts",
      "git branch --show-current",
      "git config --get user.email",
      "find . -name '*.ts'",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(true)
    }
    for (const command of [
      "git commit -am x",
      "echo hi > out.txt",
      "cat a | tee b",
      "ls; rm -rf build",
      "find . -name x -delete",
      "git diff --output=patch",
      "sed -i s/a/b/ f",
      "sort -o out in",
      "sleep 5 &",
      "echo $(rm x)",
      "FOO=1 ls",
      "npm test",
      "git branch -D old",
      "git config user.email x",
      "rg --pre ./run foo",
      "fd --exec=rm x",
      "fd -xrm x",
      "sort -uo out in",
      "",
    ]) {
      expect(readOnlyShellCommand(command)).toBe(false)
    }
  })
})
