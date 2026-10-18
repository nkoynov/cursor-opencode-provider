import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { encodeMessage } from "../src/protocol/messages.js"
import { editReadGoesToHost, hostToolForCursorEdit, toolsToDescriptors } from "../src/protocol/tools.js"
import {
  UNBOUND_EXEC_ID,
  cursorEditAnnouncement,
  earlyRowToolCallId,
  parseEarlyRowToolCallId,
  shouldOpenEarlyRow,
} from "../src/early-tool-rows.js"
import { extractTrailingToolResults, findContinuationSession, pump } from "../src/language-model.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { sessionFixture } from "./session-fixture.js"

const tempDirs: string[] = []

afterEach(() => {
  sessionManager.dispose()
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-early-row-"))
  tempDirs.push(dir)
  return dir
}

function existingFile(): string {
  const file = path.join(tempDir(), "existing.txt")
  fs.writeFileSync(file, "one\n")
  return file
}

function partial(callId: string, filePath: string): Uint8Array {
  return encodeMessage("AgentServerMessage", {
    interaction_update: {
      partial_tool_call: {
        call_id: callId,
        tool_call: { edit_tool_call: { args: { path: filePath } } },
      },
    },
  })
}

function turnEnded(): Uint8Array {
  return encodeMessage("AgentServerMessage", {
    interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } },
  })
}

function pumpSession(
  payloads: Uint8Array[],
  tools: Array<{ name: string; description: string }>,
): { session: CursorSession; parts: any[] } {
  let index = 0
  const frames: AsyncIterator<Frame> = {
    next: async () => index < payloads.length
      ? { done: false, value: { flags: 0, payload: payloads[index++]! } }
      : { done: true, value: undefined },
  }
  const descriptors = toolsToDescriptors(tools, "opencode", [])
  const session = sessionFixture({
    sessionId: `early-${Math.random().toString(16).slice(2)}`,
    conversationId: `conv-early-${Math.random().toString(16).slice(2)}`,
    stream: {
      write() {},
      end() {},
      destroy() {},
      isClosed: () => false,
      frames: () => ({ [Symbol.asyncIterator]: () => frames }),
    } as never,
    frames,
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolCatalog: tools,
    toolDescriptors: descriptors,
    requestContext: {},
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: false,
    heartbeat: null,
    heartbeatCancel: null,
    closed: false,
  })
  const parts: any[] = []
  return {
    session,
    parts,
  }
}

async function run(session: CursorSession, parts: any[]): Promise<void> {
  const controller = {
    enqueue(part: unknown) { parts.push(part) },
    close() {},
    error(error: unknown) { throw error },
  } as unknown as ReadableStreamDefaultController<any>
  await pump(session, controller, { textId: "text", reasoningId: "reasoning" })
}

describe("hostToolForCursorEdit", () => {
  it("predicts edit for an existing file, write for a new one, and withholds a patch that would change CRLF", () => {
    const dir = tempDir()
    const crlf = path.join(dir, "crlf.txt")
    const lf = path.join(dir, "lf.txt")
    fs.writeFileSync(crlf, "a\r\nb\r\n")
    fs.writeFileSync(lf, "a\nb\n")
    // A missing file is a creation: it stays a write, else becomes the patch tool's Add File.
    expect(hostToolForCursorEdit(path.join(dir, "missing.txt"), new Set(["edit", "write"]))).toBe("write")
    expect(hostToolForCursorEdit(path.join(dir, "missing.txt"), new Set(["edit"]))).toBeUndefined()
    expect(hostToolForCursorEdit(path.join(dir, "missing.txt"), new Set(["write", "patch"]))).toBe("write")
    expect(hostToolForCursorEdit(lf, new Set(["edit", "write"]))).toBe("edit")
    expect(hostToolForCursorEdit(crlf, new Set(["edit", "patch"]))).toBe("edit")
    expect(hostToolForCursorEdit(path.join(dir, "missing.txt"), new Set(["patch"]))).toBe("patch")
    expect(hostToolForCursorEdit(path.join(dir, "missing.txt"), new Set(["apply_patch"]))).toBe("apply_patch")
    expect(hostToolForCursorEdit(crlf, new Set(["patch"]))).toBeUndefined()
    expect(hostToolForCursorEdit(crlf, new Set(["apply_patch"]))).toBe("apply_patch")
    expect(hostToolForCursorEdit(lf, new Set(["patch"]))).toBe("patch")
    expect(hostToolForCursorEdit(dir, new Set(["patch"]))).toBeUndefined()
    expect(hostToolForCursorEdit("relative.txt", new Set(["patch"]))).toBeUndefined()
    expect(hostToolForCursorEdit(lf, new Set(["write"]))).toBeUndefined()
  })
})

describe("early edit rows", () => {
  it("opens only while the step can wait for the exec", () => {
    expect(shouldOpenEarlyRow({
      allowTools: true,
      hostInterrupted: false,
      holdingParallelStep: false,
      emittedHostTools: 0,
      owedPending: 0,
    })).toBe(true)
    expect(shouldOpenEarlyRow({
      allowTools: true,
      hostInterrupted: false,
      holdingParallelStep: true,
      emittedHostTools: 2,
      owedPending: 1,
    })).toBe(true)
    expect(shouldOpenEarlyRow({
      allowTools: false,
      hostInterrupted: false,
      holdingParallelStep: false,
      emittedHostTools: 0,
      owedPending: 0,
    })).toBe(false)
    expect(shouldOpenEarlyRow({
      allowTools: true,
      hostInterrupted: true,
      holdingParallelStep: false,
      emittedHostTools: 0,
      owedPending: 0,
    })).toBe(false)
    expect(shouldOpenEarlyRow({
      allowTools: true,
      hostInterrupted: false,
      holdingParallelStep: false,
      emittedHostTools: 1,
      owedPending: 0,
    })).toBe(false)
    expect(cursorEditAnnouncement({
      call_id: "task-1",
      tool_call: { task_tool_call: { args: { description: "look" } } },
    })).toBeUndefined()
    // Cursor call ids can hold a newline (seen live with grok-4.7); the row id stays opaque and bounded.
    const liveCallId = "call-4e1f2d3b-b444-4c6f-8ee9-02b61bd2da60-0\nfc_05d8d1a5-117d-961c-95f3-ed00349cd3e3_0"
    const id = earlyRowToolCallId("2e64e80f-746e-413e-a3f2-27a0b7645ad8", liveCallId)
    expect(id).toMatch(/^cursor-early_2e64e80f-746e-413e-a3f2-27a0b7645ad8_[0-9a-f]{12}$/)
    expect(id.length).toBeLessThanOrEqual(64)
    expect(earlyRowToolCallId("2e64e80f-746e-413e-a3f2-27a0b7645ad8", liveCallId)).toBe(id)
    expect(earlyRowToolCallId("2e64e80f-746e-413e-a3f2-27a0b7645ad8", "other")).not.toBe(id)
    expect(parseEarlyRowToolCallId(earlyRowToolCallId("sess", "toolu_01_x")))
      .toEqual({ sessionId: "sess", execId: UNBOUND_EXEC_ID })
    expect(parseEarlyRowToolCallId("cursor_sess_4")).toBeUndefined()
    expect(parseEarlyRowToolCallId("cursor-early_sess")).toBeUndefined()
    expect(parseEarlyRowToolCallId("cursor-early_sess_")).toBeUndefined()
  })

  it("binds the announced row to the exec and routes its result", async () => {
    const dir = tempDir()
    const target = path.join(dir, "notes.txt")
    fs.writeFileSync(target, "line one\nline two\n")
    const callId = "edit-1"
    const { session, parts } = pumpSession([
      partial(callId, target),
      encodeMessage("AgentServerMessage", {
        interaction_update: {
          tool_call_started: {
            call_id: callId,
            tool_call: { edit_tool_call: { args: { path: target } } },
          },
        },
      }),
      encodeMessage("AgentServerMessage", {
        exec_server_message: { id: 17, read_args: { path: target, tool_call_id: callId } },
      }),
      encodeMessage("AgentServerMessage", {
        exec_server_message: {
          id: 18,
          write_args: {
            path: target,
            file_text: "edited one\nline two\n",
            tool_call_id: callId,
          },
        },
      }),
    ], [
      { name: "read", description: "Read" },
      { name: "edit", description: "Edit" },
      { name: "write", description: "Write" },
    ])
    session.requestContext.env = { workspace_paths: [dir] }
    await run(session, parts)

    const start = parts.find((part) => part.type === "tool-input-start")
    const call = parts.find((part) => part.type === "tool-call" && !part.providerExecuted)
    expect(start?.toolName).toBe("edit")
    expect(call?.toolCallId).toBe(start?.id)
    expect(call?.toolCallId.startsWith("cursor-early_")).toBe(true)
    expect(parts.filter((part) => part.type === "tool-call" && !part.providerExecuted)).toHaveLength(1)
    expect(parts.findIndex((part) => part.type === "tool-input-start"))
      .toBeLessThan(parts.findIndex((part) => part.type === "tool-input-end"))
    const prompt = [
      { role: "assistant", content: [{ type: "text", text: "editing" }] },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: "edit",
          output: { type: "text", value: "ok" },
        }],
      },
    ] as never
    const continued = extractTrailingToolResults(prompt)
    expect(continued).toMatchObject([{ sessionId: session.sessionId, execId: 18 }])

    // A result that arrives after the Run closed still names its exec, so the
    // turn rebuilds from host history instead of dropping the completed edit.
    sessionManager.close(session, "hard-cap-expired")
    const late = extractTrailingToolResults(prompt)
    expect(late).toMatchObject([{ sessionId: session.sessionId, execId: 18 }])
    expect(findContinuationSession(late)).toBeUndefined()
    expect(sessionManager.classify(session.sessionId, 18)).toEqual({ kind: "terminal", reason: "hard-cap-expired" })

    // After a restart the route is gone; the id is still recognized as this provider's.
    sessionManager.dispose()
    expect(extractTrailingToolResults(prompt)).toMatchObject([{ sessionId: session.sessionId, execId: UNBOUND_EXEC_ID }])
  })

  it("binds a new file's announced row to its write instead of showing a failed edit", async () => {
    const dir = tempDir()
    const target = path.join(dir, "big.txt")
    const callId = "edit-new"
    const { session, parts } = pumpSession([
      partial(callId, target),
      encodeMessage("AgentServerMessage", {
        exec_server_message: {
          id: 5,
          write_args: { path: target, file_text: "line 1\n", tool_call_id: callId },
        },
      }),
    ], [
      { name: "edit", description: "Edit" },
      { name: "write", description: "Write" },
    ])
    session.requestContext.env = { workspace_paths: [dir] }
    await run(session, parts)

    const start = parts.find((part) => part.type === "tool-input-start")
    const calls = parts.filter((part) => part.type === "tool-call")
    expect(start?.toolName).toBe("write")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ toolCallId: start?.id, toolName: "write" })
    expect(calls[0].providerExecuted).toBeUndefined()
    sessionManager.resolve(session.sessionId, 5)
  })

  it("binds an empty file's announced row to its write, which the edit remap leaves a write", async () => {
    const dir = tempDir()
    const target = path.join(dir, "empty.txt")
    fs.writeFileSync(target, "")
    const callId = "edit-empty"
    const { session, parts } = pumpSession([
      partial(callId, target),
      encodeMessage("AgentServerMessage", {
        interaction_update: { tool_call_started: { call_id: callId, tool_call: { edit_tool_call: { args: { path: target } } } } },
      }),
      encodeMessage("AgentServerMessage", { exec_server_message: { id: 7, read_args: { path: target, tool_call_id: callId } } }),
      encodeMessage("AgentServerMessage", {
        exec_server_message: { id: 8, write_args: { path: target, file_text: "now filled\n", tool_call_id: callId } },
      }),
    ], [
      { name: "read", description: "Read" },
      { name: "edit", description: "Edit" },
      { name: "write", description: "Write" },
    ])
    session.requestContext.env = { workspace_paths: [dir] }
    await run(session, parts)

    const start = parts.find((part) => part.type === "tool-input-start")
    const calls = parts.filter((part) => part.type === "tool-call")
    expect(start?.toolName).toBe("write")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ toolCallId: start?.id, toolName: "write" })
    sessionManager.resolve(session.sessionId, 8)
  })

  it("opens no row for a call announced behind another whose exec has not come", async () => {
    const dir = tempDir()
    const first = path.join(dir, "first.txt")
    const second = path.join(dir, "second.txt")
    const { session, parts } = pumpSession([
      partial("edit-a", first),
      partial("edit-b", second),
      encodeMessage("AgentServerMessage", {
        exec_server_message: { id: 9, write_args: { path: first, file_text: "a\n", tool_call_id: "edit-a" } },
      }),
    ], [
      { name: "edit", description: "Edit" },
      { name: "write", description: "Write" },
    ])
    session.requestContext.env = { workspace_paths: [dir] }
    await run(session, parts)

    const starts = parts.filter((part) => part.type === "tool-input-start")
    expect(starts.map((part) => part.id)).toEqual([earlyRowToolCallId(session.sessionId, "edit-a")])
    expect(parts.filter((part) => part.type === "tool-call" && part.providerExecuted)).toEqual([])
    sessionManager.resolve(session.sessionId, 9)
  })

  it("opens no row for an edit whose private read goes to the host, so no failed edit precedes the read", async () => {
    const workspace = tempDir()
    const outside = path.join(tempDir(), "outside.txt")
    fs.writeFileSync(outside, "one\n")
    const callId = "edit-outside"
    const { session, parts } = pumpSession([
      partial(callId, outside),
      encodeMessage("AgentServerMessage", {
        interaction_update: {
          tool_call_started: { call_id: callId, tool_call: { edit_tool_call: { args: { path: outside } } } },
        },
      }),
      // Outside the workspace, the edit's private read goes through the host's permission-aware read.
      encodeMessage("AgentServerMessage", {
        exec_server_message: { id: 3, read_args: { path: outside, tool_call_id: callId } },
      }),
    ], [
      { name: "read", description: "Read" },
      { name: "edit", description: "Edit" },
    ])
    session.requestContext.env = { workspace_paths: [workspace] }
    await run(session, parts)

    const read = parts.find((part) => part.type === "tool-call" && !part.providerExecuted)
    expect(parts.some((part) => part.type === "tool-input-start" && part.id.startsWith("cursor-early_"))).toBe(false)
    expect(parts.filter((part) => part.type === "tool-call" && part.providerExecuted)).toEqual([])
    expect(parts.some((part) => part.type === "tool-result" && part.isError)).toBe(false)
    expect(read?.toolName).toBe("read")
    expect(read?.toolCallId.startsWith("cursor_")).toBe(true)
    sessionManager.resolve(session.sessionId, 3)
  })

  it("treats a workspace symlink to an outside file like the outside file", async () => {
    const workspace = tempDir()
    const outside = path.join(tempDir(), "outside.txt")
    fs.writeFileSync(outside, "one\n")
    const link = path.join(workspace, "link.txt")
    fs.symlinkSync(outside, link)
    const { session, parts } = pumpSession([
      partial("edit-link", link),
      encodeMessage("AgentServerMessage", {
        interaction_update: {
          tool_call_started: { call_id: "edit-link", tool_call: { edit_tool_call: { args: { path: link } } } },
        },
      }),
      encodeMessage("AgentServerMessage", {
        exec_server_message: { id: 6, read_args: { path: link, tool_call_id: "edit-link" } },
      }),
    ], [
      { name: "read", description: "Read" },
      { name: "edit", description: "Edit" },
    ])
    session.requestContext.env = { workspace_paths: [workspace] }
    await run(session, parts)

    expect(parts.some((part) => part.type === "tool-input-start" && part.id.startsWith("cursor-early_"))).toBe(false)
    expect(parts.find((part) => part.type === "tool-call")?.toolName).toBe("read")
    sessionManager.resolve(session.sessionId, 6)
  })

  it("predicts which edits' private reads go to the host", () => {
    const workspace = tempDir()
    const inside = path.join(workspace, "inside.txt")
    fs.writeFileSync(inside, "one\n")
    const outside = path.join(tempDir(), "outside.txt")
    fs.writeFileSync(outside, "one\n")
    fs.symlinkSync(outside, path.join(workspace, "link.txt"))
    expect(editReadGoesToHost(inside, workspace)).toBe(false)
    expect(editReadGoesToHost("inside.txt", workspace)).toBe(false)
    expect(editReadGoesToHost(path.join(workspace, "missing.txt"), workspace)).toBe(false)
    expect(editReadGoesToHost(path.join(path.dirname(outside), "missing.txt"), workspace)).toBe(false)
    expect(editReadGoesToHost(outside, workspace)).toBe(true)
    expect(editReadGoesToHost(path.join(workspace, "link.txt"), workspace)).toBe(true)
  })

  it("closes the row when the exec is a different tool", async () => {
    const file = existingFile()
    const { session, parts } = pumpSession([
      partial("edit-1", file),
      encodeMessage("AgentServerMessage", {
        exec_server_message: { id: 4, shell_args: { command: "pwd", tool_call_id: "shell-1" } },
      }),
    ], [
      { name: "edit", description: "Edit" },
      { name: "bash", description: "Shell" },
    ])
    session.requestContext.env = { workspace_paths: [path.dirname(file)] }
    await run(session, parts)
    const start = parts.find((part) => part.type === "tool-input-start")
    const closed = parts.find((part) => part.type === "tool-call" && part.providerExecuted)
    const shell = parts.find((part) => part.type === "tool-call" && part.toolName === "bash")
    expect(start?.toolName).toBe("edit")
    expect(closed?.toolCallId).toBe(start?.id)
    expect(shell?.toolCallId.startsWith("cursor_")).toBe(true)
    expect(parts.findIndex((part) => part === closed)).toBeLessThan(parts.findIndex((part) => part === shell))
    expect(parts.at(-1)?.type).toBe("finish")
    sessionManager.resolve(session.sessionId, 4)
  })

  it("stays open across later text and closes before the step finishes", async () => {
    const file = existingFile()
    const { session, parts } = pumpSession([
      partial("edit-1", file),
      encodeMessage("AgentServerMessage", { interaction_update: { text_delta: { text: "still writing" } } }),
      turnEnded(),
    ], [{ name: "edit", description: "Edit" }])
    session.requestContext.env = { workspace_paths: [path.dirname(file)] }
    await run(session, parts)
    const startAt = parts.findIndex((part) => part.type === "tool-input-start")
    const textAt = parts.findIndex((part) => part.type === "text-delta")
    const textEndAt = parts.findIndex((part) => part.type === "text-end")
    const closedAt = parts.findIndex((part) => part.type === "tool-call" && part.providerExecuted)
    const finishAt = parts.findIndex((part) => part.type === "finish")
    expect(startAt).toBeGreaterThanOrEqual(0)
    expect(textAt).toBeGreaterThan(startAt)
    // Open text ends before the closing tool-call, as at every other tool-call.
    expect(textEndAt).toBeGreaterThan(textAt)
    expect(closedAt).toBeGreaterThan(textEndAt)
    expect(finishAt).toBeGreaterThan(closedAt)
  })

  it("does not open a row a patch conversion would refuse, or on a tool-less turn", async () => {
    const dir = tempDir()
    const crlf = path.join(dir, "crlf.txt")
    fs.writeFileSync(crlf, "a\r\nb\r\n")
    const refused = pumpSession([
      partial("edit-1", crlf),
      encodeMessage("AgentServerMessage", { interaction_update: { text_delta: { text: "no row" } } }),
      turnEnded(),
    ], [{ name: "patch", description: "Patch" }])
    await run(refused.session, refused.parts)
    expect(refused.parts.some((part) => part.type === "tool-input-start")).toBe(false)

    const lifecycle = pumpSession([
      partial("edit-1", crlf),
      encodeMessage("AgentServerMessage", { interaction_update: { text_delta: { text: "title" } } }),
      turnEnded(),
    ], [{ name: "edit", description: "Edit" }])
    lifecycle.session.allowTools = false
    await run(lifecycle.session, lifecycle.parts)
    expect(lifecycle.parts.some((part) => part.type === "tool-input-start")).toBe(false)
  })
})
