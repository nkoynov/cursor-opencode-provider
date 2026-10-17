import { afterEach, describe, expect, it, spyOn } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { buildTaskAttachmentReadMessages, toolsToDescriptors } from "../src/protocol/tools.js"
import { taskToolCallAttachments } from "../src/protocol/tool-call-bridge.js"
import { pump, resetTurnStateForTests } from "../src/language-model.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { sessionFixture } from "./session-fixture.js"
import { runtimeLayout } from "../src/runtime-files.js"

const tempDirs: string[] = []

afterEach(() => {
  sessionManager.dispose()
  resetTurnStateForTests()
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-task-attachment-"))
  tempDirs.push(dir)
  return dir
}

function writeVarint(out: number[], value: number): void {
  let remaining = value >>> 0
  while (remaining > 0x7f) {
    out.push((remaining & 0x7f) | 0x80)
    remaining >>>= 7
  }
  out.push(remaining)
}

function display(kind: "started" | "completed", callId: string, args: Record<string, unknown>): Uint8Array {
  const key = kind === "started" ? "tool_call_started" : "tool_call_completed"
  return encodeMessage("AgentServerMessage", {
    interaction_update: { [key]: { call_id: callId, tool_call: { task_tool_call: { args } } } },
  })
}

function exec(message: Record<string, unknown>): Uint8Array {
  return encodeMessage("AgentServerMessage", { exec_server_message: message })
}

function turnEnded(): Uint8Array {
  return encodeMessage("AgentServerMessage", {
    interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } },
  })
}

function pumpSession(
  payloads: Uint8Array[],
  root: string,
  tools: Array<{ name: string; description: string }>,
): { session: CursorSession; parts: any[]; writes: Uint8Array[] } {
  let index = 0
  const frames: AsyncIterator<Frame> = {
    next: async () => index < payloads.length
      ? { done: false, value: { flags: 0, payload: payloads[index++]! } }
      : { done: true, value: undefined },
  }
  const writes: Uint8Array[] = []
  const session = sessionFixture({
    sessionId: `task-attachment-${Math.random().toString(16).slice(2)}`,
    conversationId: `conv-task-attachment-${Math.random().toString(16).slice(2)}`,
    stream: {
      write(data: Uint8Array) { writes.push(data) },
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
    toolDescriptors: toolsToDescriptors(tools, "opencode", []),
    requestContext: { env: { workspace_paths: [root] } },
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: false,
    heartbeat: null,
    heartbeatCancel: null,
    closed: false,
  })
  return { session, parts: [], writes }
}

async function run(session: CursorSession, parts: any[]): Promise<void> {
  const controller = {
    enqueue(part: unknown) { parts.push(part) },
    close() {},
    error(error: unknown) { throw error },
  } as unknown as ReadableStreamDefaultController<any>
  await pump(session, controller, { textId: "text", reasoningId: "reasoning" })
}

function readResult(writes: Uint8Array[], execId: number): Record<string, any> | undefined {
  return writes
    .map((frame) => decodeMessage<any>("AgentClientMessage", frame).exec_client_message)
    .find((message) => message?.id === execId && message.read_result)?.read_result
}

const toolCalls = (parts: any[]) => parts.filter((part) => part.type === "tool-call")

describe("Task attachments", () => {
  it("decodes TaskArgs.attachments (field 7) from independent bytes", () => {
    // agent.v1 TaskArgs: string description = 1; repeated string attachments = 7.
    const bytes: number[] = []
    for (const [field, value] of [[1, "Look"], [7, "a.png"], [7, "b.png"]] as const) {
      const encoded = new TextEncoder().encode(value)
      writeVarint(bytes, (field << 3) | 2)
      writeVarint(bytes, encoded.length)
      bytes.push(...encoded)
    }
    const args = decodeMessage<Record<string, unknown>>("TaskToolArgs", Uint8Array.from(bytes))
    expect(taskToolCallAttachments({ task_tool_call: { args } })).toEqual(["a.png", "b.png"])
    expect(taskToolCallAttachments({ task_tool_call: { args: { attachments: ["", "  "] } } })).toEqual([])
    expect(taskToolCallAttachments({ edit_tool_call: { args: { attachments: ["a.png"] } } })).toEqual([])
  })

  it("answers an attachment read with placeholder bytes and typed rejections, never the file", () => {
    const root = workspace()
    const file = path.join(root, "shot.png")
    fs.writeFileSync(file, "secret bytes")
    const [reply, close] = buildTaskAttachmentReadMessages(7, file, "shot.png")
    const success = decodeMessage<any>("AgentClientMessage", reply!).exec_client_message.read_result.success
    expect(success.path).toBe("shot.png")
    expect(success.data.length).toBeGreaterThan(0)
    expect(Buffer.from(success.data).toString()).not.toContain("secret bytes")
    expect(success.content).toBeUndefined()
    expect(decodeMessage<any>("AgentClientMessage", close!).exec_client_control_message.stream_close.id).toBe(7)

    const missing = path.join(root, "gone.png")
    const [gone] = buildTaskAttachmentReadMessages(8, missing, "gone.png")
    expect(decodeMessage<any>("AgentClientMessage", gone!).exec_client_message.read_result)
      .toEqual({ file_not_found: { path: missing } })
    const [directory] = buildTaskAttachmentReadMessages(9, root, ".")
    expect(decodeMessage<any>("AgentClientMessage", directory!).exec_client_message.read_result.invalid_file)
      .toEqual({ path: root, reason: "Path is a directory, not a file" })
  })

  it.each([
    { host: "OpenCode 1.x", executor: "task", tools: ["task", "bash"] },
    { host: "OpenCode 2", executor: "subagent", tools: ["subagent", "shell"] },
  ])("keeps the Task title and hands the $host subagent the paths without a host read", async ({ executor, tools }) => {
    const root = workspace()
    fs.writeFileSync(path.join(root, "shot.png"), "secret bytes")
    const args = { description: "Describe the shot", prompt: "Describe the attached image.", attachments: ["shot.png"] }
    const { session, parts, writes } = pumpSession([
      display("started", "t", args),
      exec({ id: 1, read_args: { path: "shot.png", tool_call_id: "t" } }),
      exec({ id: 2, subagent_args: { tool_call_id: "t", prompt: args.prompt, subagent_type: "generalPurpose" } }),
    ], root, tools.map((name) => ({ name, description: name })))
    await run(session, parts)

    const calls = toolCalls(parts)
    expect(calls).toHaveLength(1)
    expect(calls[0].toolName).toBe(executor)
    const input = JSON.parse(calls[0].input)
    expect(input.description).toBe("Describe the shot")
    expect(input.prompt).toBe(
      `Describe the attached image.\n\nAttached files (open them with your file tools):\n- ${JSON.stringify(path.join(root, "shot.png"))}`,
    )
    expect([...session.pending.keys()]).toEqual([2])
    expect(readResult(writes, 1)?.success.data.length).toBeGreaterThan(0)
  })

  it("does not run a Task Cursor refuses after its attachment reads", async () => {
    const root = workspace()
    const args = {
      description: "Describe the shot",
      prompt: "Describe the attached image.",
      subagent_type: { explore: {} },
      attachments: ["gone.png"],
    }
    const { session, parts, writes } = pumpSession([
      display("started", "t", args),
      exec({ id: 1, read_args: { path: "gone.png", tool_call_id: "t" } }),
      display("completed", "t", args),
      turnEnded(),
    ], root, [{ name: "read", description: "read" }, { name: "task", description: "task" }])
    await run(session, parts)

    // The kept display call must not turn into a host Task on completion.
    expect(toolCalls(parts)).toEqual([])
    expect(readResult(writes, 1)).toEqual({ file_not_found: { path: path.join(root, "gone.png") } })
  })

  it("still runs an ordinary read that is not correlated with a Task", async () => {
    const root = workspace()
    fs.writeFileSync(path.join(root, "notes.txt"), "hello\n")
    const { session, parts, writes } = pumpSession([
      exec({ id: 1, read_args: { path: "notes.txt", tool_call_id: "r" } }),
    ], root, [{ name: "read", description: "read" }])
    await run(session, parts)

    expect(toolCalls(parts).map((call) => call.toolName)).toEqual(["read"])
    expect(readResult(writes, 1)).toBeUndefined()
  })

  it.each([" shot.png ", "line\nbreak.png", 'quote"name.png'])("preserves the exact attachment filename %j", async (filename) => {
    const root = workspace()
    fs.writeFileSync(path.join(root, filename), "secret bytes")
    const { session, parts } = pumpSession([
      display("started", "t", { description: "Inspect", attachments: [filename] }),
      exec({ id: 1, read_args: { path: filename, tool_call_id: "t" } }),
      exec({ id: 2, subagent_args: { tool_call_id: "t", prompt: "Inspect.", subagent_type: "generalPurpose" } }),
    ], root, [{ name: "task", description: "task" }])
    await run(session, parts)
    expect(JSON.parse(toolCalls(parts)[0].input).prompt).toEndWith(`- ${JSON.stringify(path.join(root, filename))}`)
  })

  it("keeps a read outside the Task attachment list on the host path", async () => {
    const root = workspace()
    fs.writeFileSync(path.join(root, "notes.txt"), "hello")
    const { session, parts, writes } = pumpSession([
      display("started", "t", { description: "Inspect", attachments: ["shot.png"] }),
      exec({ id: 1, read_args: { path: "notes.txt", tool_call_id: "t" } }),
    ], root, [{ name: "read", description: "read" }])
    await run(session, parts)
    expect(toolCalls(parts).map((call) => call.toolName)).toEqual(["read"])
    expect(readResult(writes, 1)).toBeUndefined()
  })

  it.each(["task", "subagent"])("handles runtime attachments before metadata interception for %s", async (executor) => {
    const root = workspace()
    const metadata = path.join(root, "runtime")
    const layout = runtimeLayout(metadata, true)
    const file = path.join(layout.terminals, "1234.txt")
    fs.writeFileSync(file, "private terminal bytes")
    const { session, parts, writes } = pumpSession([
      display("started", "t", { description: "Inspect terminal", attachments: [file] }),
      exec({ id: 1, read_args: { path: file, tool_call_id: "t" } }),
      exec({ id: 2, subagent_args: { tool_call_id: "t", prompt: "Inspect.", subagent_type: "generalPurpose" } }),
    ], root, [{ name: executor, description: executor }])
    Object.assign(session.requestContext.env!, { project_folder: metadata })
    await run(session, parts)
    expect(readResult(writes, 1)?.success.content).toBeUndefined()
    expect(readResult(writes, 1)?.success.data.length).toBeGreaterThan(0)
    const input = JSON.parse(toolCalls(parts)[0].input)
    expect(input.description).toBe("Inspect terminal")
    expect(input.prompt).toContain(file)
  })

  it("does not turn a failed attachment stat into a successful placeholder", () => {
    const stat = spyOn(fs, "statSync").mockImplementation(() => {
      throw Object.assign(new Error("access denied"), { code: "EACCES" })
    })
    try {
      const [reply] = buildTaskAttachmentReadMessages(7, "unreadable.png")
      const result = decodeMessage<any>("AgentClientMessage", reply!).exec_client_message.read_result
      expect(result.success).toBeUndefined()
      expect(result.error.error).toContain("access denied")
    } finally {
      stat.mockRestore()
    }
  })

  it("leaves unlisted reads alone when a Task has no attachments", async () => {
    const root = workspace()
    fs.writeFileSync(path.join(root, "notes.txt"), "hello")
    const { session, parts, writes } = pumpSession([
      display("started", "t", { description: "Inspect" }),
      exec({ id: 1, read_args: { path: "notes.txt", tool_call_id: "t" } }),
    ], root, [{ name: "read", description: "read" }])
    await run(session, parts)
    expect(toolCalls(parts).map((call) => call.toolName)).toEqual(["read"])
    expect(readResult(writes, 1)).toBeUndefined()
  })

  it("refuses attachment reads on text-only lifecycle calls", async () => {
    const root = workspace()
    fs.writeFileSync(path.join(root, "shot.png"), "secret bytes")
    const { session, parts, writes } = pumpSession([
      display("started", "t", { attachments: ["shot.png"] }),
      exec({ id: 1, read_args: { path: "shot.png", tool_call_id: "t" } }),
      turnEnded(),
    ], root, [{ name: "task", description: "task" }])
    session.allowTools = false
    await run(session, parts)
    expect(toolCalls(parts)).toEqual([])
    expect(readResult(writes, 1)?.success).toBeUndefined()
    expect(JSON.stringify(readResult(writes, 1))).toContain("text-only")
  })

  it.each(["task", "subagent"])("keeps parallel Task attachment owners and titles for %s", async (executor) => {
    const root = workspace()
    for (const file of ["a.png", "b.png"]) fs.writeFileSync(path.join(root, file), "secret bytes")
    const { session, parts, writes } = pumpSession([
      encodeMessage("AgentServerMessage", { interaction_update: { tool_requests_listed: { call_count: 2 } } }),
      display("started", "a", { description: "Inspect A", attachments: ["a.png"] }),
      display("started", "b", { description: "Inspect B", attachments: ["b.png"] }),
      exec({ id: 1, read_args: { path: "a.png", tool_call_id: "a" } }),
      exec({ id: 2, subagent_args: { tool_call_id: "a", prompt: "Inspect.", subagent_type: "generalPurpose" } }),
      exec({ id: 3, read_args: { path: "b.png", tool_call_id: "b" } }),
      exec({ id: 4, subagent_args: { tool_call_id: "b", prompt: "Inspect.", subagent_type: "generalPurpose" } }),
    ], root, [{ name: executor, description: executor }])
    await run(session, parts)
    const calls = toolCalls(parts)
    expect(calls.map((call) => JSON.parse(call.input).description)).toEqual(["Inspect A", "Inspect B"])
    expect(calls.map((call) => call.toolName)).toEqual([executor, executor])
    expect(JSON.parse(calls[0].input).prompt).toContain(JSON.stringify(path.join(root, "a.png")))
    expect(JSON.parse(calls[1].input).prompt).toContain(JSON.stringify(path.join(root, "b.png")))
    expect([...session.pending.keys()]).toEqual([2, 4])
    expect(readResult(writes, 1)?.success.data.length).toBeGreaterThan(0)
    expect(readResult(writes, 3)?.success.data.length).toBeGreaterThan(0)
  })

  it("does not emit a host read or subagent after an attachment reply write fails", async () => {
    const root = workspace()
    fs.writeFileSync(path.join(root, "shot.png"), "secret bytes")
    const { session, parts } = pumpSession([
      display("started", "t", { attachments: ["shot.png"] }),
      exec({ id: 1, read_args: { path: "shot.png", tool_call_id: "t" } }),
      exec({ id: 2, subagent_args: { tool_call_id: "t", prompt: "Inspect.", subagent_type: "generalPurpose" } }),
    ], root, [{ name: "task", description: "task" }])
    session.stream.write = () => { throw new Error("write failed") }
    await run(session, parts)
    expect(session.closed).toBe(true)
    expect(toolCalls(parts)).toEqual([])
    expect(session.pending.size).toBe(0)
  })
})
