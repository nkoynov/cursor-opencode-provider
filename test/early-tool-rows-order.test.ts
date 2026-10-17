import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { OPENCODE_2_TOOL_DIALECT, toolsToDescriptors } from "../src/protocol/tools.js"
import {
  deliverContinuationResults,
  foldStreamParts,
  pump,
  pumpWithRecovery,
  resetTurnStateForTests,
} from "../src/language-model.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"

const frame = (message: Record<string, unknown>, flags = 0): Frame => ({
  flags,
  payload: encodeMessage("AgentServerMessage", message),
})
const update = (value: Record<string, unknown>) => frame({ interaction_update: value })
const partial = (callId: string, toolCall: Record<string, unknown>) =>
  update({ partial_tool_call: { call_id: callId, tool_call: toolCall } })
const started = (callId: string, toolCall: Record<string, unknown>) =>
  update({ tool_call_started: { call_id: callId, tool_call: toolCall } })
const completed = (callId: string, toolCall: Record<string, unknown>) =>
  update({ tool_call_completed: { call_id: callId, tool_call: toolCall } })
const thinking = (text: string) => update({ thinking_delta: { text } })
const heartbeat = () => update({ heartbeat: {} })
const turnEnded = () => update({ turn_ended: {} })
const checkpoint = () => frame({ conversation_checkpoint_update: Uint8Array.from([9, 9, 9]) })

const editAnnounced = (callId: string, target?: string) => [
  partial(callId, { edit_tool_call: {} }),
  ...(target ? [partial(callId, { edit_tool_call: { args: { path: target } } })] : []),
]
const editCall = (callId: string, target: string, content: string) =>
  ({ edit_tool_call: { args: { path: target, stream_content: content } } })
const editDone = (readId: number, writeId: number, callId: string, target: string, content: string) => [
  started(callId, editCall(callId, target, content)),
  frame({ exec_server_message: { id: readId, read_args: { path: target, tool_call_id: callId } } }),
  frame({ exec_server_message: { id: writeId, write_args: { path: target, file_text: content, tool_call_id: callId } } }),
]
const shellStarted = (callId: string, command: string) =>
  started(callId, { shell_tool_call: { args: { command, tool_call_id: callId } } })
const shellExec = (id: number, callId: string, command: string) =>
  frame({ exec_server_message: { id, shell_stream_args: { command, tool_call_id: callId } } })

function scriptedFrames(initial: Frame[] = []) {
  const queue = [...initial]
  let waiting: ((result: IteratorResult<Frame>) => void) | undefined
  let ended = false
  const frames: AsyncIterator<Frame> = {
    next: () => {
      const next = queue.shift()
      if (next) return Promise.resolve({ done: false, value: next })
      if (ended) return Promise.resolve({ done: true, value: undefined })
      return new Promise((resolve) => { waiting = resolve })
    },
  }
  return {
    frames,
    push(...next: Frame[]) {
      for (const item of next) {
        if (waiting) {
          const resolve = waiting
          waiting = undefined
          resolve({ done: false, value: item })
        } else queue.push(item)
      }
    },
    end() {
      ended = true
      if (waiting) {
        const resolve = waiting
        waiting = undefined
        resolve({ done: true, value: undefined })
      }
    },
  }
}

const roots: string[] = []
let seq = 0
function fakeSession(frames: AsyncIterator<Frame>, tools = ["read", "write", "edit", "shell", "subagent"]): CursorSession {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "early-rows-order-"))
  roots.push(root)
  const definitions = tools.map((name) => ({ name, description: name }))
  const descriptors = toolsToDescriptors(definitions, "opencode", [])
  return {
    sessionId: `order${++seq}`,
    conversationId: "early-order-conversation",
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
    toolDescriptors: descriptors,
    hostToolDialect: OPENCODE_2_TOOL_DIALECT,
    subagentCatalog: { executor: "subagent", agents: [{ name: "general" }, { name: "explore" }], complete: true },
    requestContext: { tools: descriptors, env: { workspace_paths: [root] } },
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    billing: { key: "run:test", prefixTokens: 0 },
    allowTools: true,
    pumpActive: true,
    heartbeat: null,
    expiresAt: Date.now() + 10_000,
  } as unknown as CursorSession
}
const rootOf = (session: CursorSession) => (session.requestContext.env as { workspace_paths: string[] }).workspace_paths[0]!

function collector() {
  const parts: any[] = []
  const controller = {
    enqueue(part: unknown) { parts.push(part) },
    error(error: Error) { throw error },
  } as unknown as ReadableStreamDefaultController<any>
  return { parts, controller }
}

async function pumpOnce(session: CursorSession) {
  const { parts, controller } = collector()
  await pump(session, controller, { textId: "text", reasoningId: "reasoning" })
  return parts
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5)
  expect(check()).toBe(true)
}
const rowStarts = (parts: any[]) => parts.filter((p) => p.type === "tool-input-start")
const hostCalls = (parts: any[]) => parts.filter((p) => p.type === "tool-call" && !p.providerExecuted)
const closedRows = (parts: any[]) => parts.filter((p) => p.type === "tool-result" && p.isError)

async function deliverAll(session: CursorSession) {
  const results = [...session.pending.entries()].map(([execId, pending]) => ({
    toolCallId: pending.toolCallId ?? `cursor_${session.sessionId}_${execId}`,
    sessionId: session.sessionId,
    execId,
    toolName: pending.toolName ?? "write",
    output: "ok",
  }))
  expect(await deliverContinuationResults(session, results)).toBe(session)
}

describe("early edit rows with the tool-call ordering", () => {
  afterEach(() => {
    sessionManager.dispose()
    resetTurnStateForTests()
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it("leaves a row out while an earlier call of the step may still end the host step", async () => {
    const script = scriptedFrames()
    const session = fakeSession(script.frames)
    const target = path.join(rootOf(session), "AFTER.md")
    script.push(
      shellStarted("s", "touch a"),
      ...editAnnounced("e", target),
      shellExec(1, "s", "touch a"),
    )
    const parts = await pumpOnce(session)
    expect(rowStarts(parts)).toEqual([])
    expect(closedRows(parts)).toEqual([])
    expect(hostCalls(parts).map((p) => p.toolName)).toEqual(["shell"])
  })

  it("lets a call Cursor announces without a row hold back the rows after it", async () => {
    const script = scriptedFrames()
    const session = fakeSession(script.frames)
    const target = path.join(rootOf(session), "AFTER.md")
    script.push(
      partial("s", { shell_tool_call: {} }),
      ...editAnnounced("e", target),
      heartbeat(),
      shellStarted("s", "touch a"),
      shellExec(1, "s", "touch a"),
    )
    const parts = await pumpOnce(session)
    expect(rowStarts(parts)).toEqual([])
    expect(closedRows(parts)).toEqual([])
  })

  it("shows no failed row for the second of two parallel edits announced before the first one's write", async () => {
    // Live order (p-claude-md recording): the second edit is announced before the first one's write.
    const script = scriptedFrames()
    const session = fakeSession(script.frames)
    const root = rootOf(session)
    const first = path.join(root, "retry.py")
    const second = path.join(root, "test_retry.py")
    script.push(
      ...editAnnounced("e1", first),
      started("e1", editCall("e1", first, "a\n")),
      ...editAnnounced("e2"),
      frame({ exec_server_message: { id: 1, read_args: { path: first, tool_call_id: "e1" } } }),
      partial("e2", { edit_tool_call: { args: { path: second } } }),
      frame({ exec_server_message: { id: 2, write_args: { path: first, file_text: "a\n", tool_call_id: "e1" } } }),
    )
    const pass1 = await pumpOnce(session)
    expect(rowStarts(pass1).map((p) => p.toolName)).toEqual(["write"])
    expect(hostCalls(pass1)).toMatchObject([{ toolCallId: rowStarts(pass1)[0].id }])
    expect(closedRows(pass1)).toEqual([])

    await deliverAll(session)
    script.push(heartbeat(), ...editDone(3, 4, "e2", second, "b\n"))
    const pass2 = await pumpOnce(session)
    expect(hostCalls(pass2)).toMatchObject([{ toolName: "write" }])
    expect(closedRows(pass2)).toEqual([])
  })

  it("keeps the row when Cursor delivers thinking between a call's announcements", async () => {
    // Live order (vm3c2, 2026-10-08): kind, thinking, path, more thinking, then the call.
    const script = scriptedFrames()
    const session = fakeSession(script.frames)
    const target = path.join(rootOf(session), "NEW.md")
    script.push(
      partial("w", { edit_tool_call: {} }),
      thinking("I'll write the file."),
      partial("w", { edit_tool_call: { args: { path: target } } }),
      thinking(" Done planning."),
      heartbeat(),
      ...editDone(1, 2, "w", target, "x\n"),
    )
    const parts = await pumpOnce(session)
    expect(closedRows(parts)).toEqual([])
    expect(hostCalls(parts)).toMatchObject([{ toolCallId: rowStarts(parts)[0]?.id, toolName: "write" }])
  })

  it("closes the row of a Run that fails, and opens a new one for the replacement Run's call", async () => {
    const first = scriptedFrames([checkpoint()])
    const session = fakeSession(first.frames)
    session.openCodeSessionId = "ses_early_order_recover"
    const target = path.join(rootOf(session), "NEW.md")
    first.push(...editAnnounced("w1", target))
    const second = scriptedFrames([...editAnnounced("w2", target), ...editDone(1, 2, "w2", target, "x\n")])
    let replacement: CursorSession | undefined
    const { parts, controller } = collector()
    const pumping = pumpWithRecovery({
      initialSession: session,
      controller,
      maxRecoveries: 1,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      recover: async () => {
        replacement = fakeSession(second.frames)
        replacement.sessionId = session.sessionId + "r"
        replacement.requestContext = session.requestContext
        return replacement
      },
    })
    await until(() => rowStarts(parts).length === 1)
    first.end()
    await pumping
    const [old, fresh] = rowStarts(parts)
    expect(closedRows(parts).map((p) => p.toolCallId)).toEqual([old.id])
    expect(hostCalls(parts)).toMatchObject([{ toolCallId: fresh.id, toolName: "write" }])
    expect(fresh.id).not.toBe(old.id)
    expect(foldStreamParts(parts).content.filter((part) => part.type === "tool-call")).toHaveLength(1)
    sessionManager.close(replacement!)
  })
})

describe("Task attachment reads", () => {
  afterEach(() => {
    sessionManager.dispose()
    resetTurnStateForTests()
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it("answers Cursor's attachment read itself and hands the subagent the paths", async () => {
    const script = scriptedFrames()
    const session = fakeSession(script.frames)
    const written: Uint8Array[] = []
    session.stream.write = ((message: Uint8Array) => { written.push(message); return true }) as any
    fs.writeFileSync(path.join(rootOf(session), "shot.png"), "png bytes")
    const args = { description: "Describe the shot", prompt: "Describe the attached image.", attachments: ["shot.png"] }
    script.push(
      started("t", { task_tool_call: { args } }),
      frame({ exec_server_message: { id: 1, read_args: { path: "shot.png", tool_call_id: "t" } } }),
      frame({
        exec_server_message: {
          id: 2,
          subagent_args: { tool_call_id: "t", prompt: args.prompt, subagent_type: "generalPurpose" },
        },
      }),
    )
    const parts = await pumpOnce(session)

    const [call] = hostCalls(parts)
    expect(call).toMatchObject({ toolName: "subagent" })
    expect(JSON.parse(call.input)).toEqual({
      agent: "general",
      description: "Describe the shot",
      prompt: `Describe the attached image.\n\nAttached files (open them with your file tools):\n- ${path.join(rootOf(session), "shot.png")}`,
    })
    expect([...session.pending.keys()]).toEqual([2])
    const read = written
      .map((message) => decodeMessage("AgentClientMessage", message) as any)
      .find((message) => message.exec_client_message?.id === 1)
    const success = read.exec_client_message.read_result.success
    expect(success.path).toBe("shot.png")
    expect(success.data.length).toBeGreaterThan(0)
    expect(Buffer.from(success.data).toString()).not.toContain("png bytes")
  })

  it("does not run a Task Cursor refuses after its attachment reads", async () => {
    const script = scriptedFrames()
    const session = fakeSession(script.frames, ["read", "task"])
    const written: Uint8Array[] = []
    session.stream.write = ((message: Uint8Array) => { written.push(message); return true }) as any
    const args = {
      description: "Describe the shot",
      prompt: "Describe the attached image.",
      subagent_type: { explore: {} },
      attachments: ["gone.png"],
    }
    script.push(
      started("t", { task_tool_call: { args } }),
      frame({ exec_server_message: { id: 1, read_args: { path: "gone.png", tool_call_id: "t" } } }),
      completed("t", { task_tool_call: { args } }),
      turnEnded(),
    )
    const parts = await pumpOnce(session)
    expect(hostCalls(parts)).toEqual([])
    expect(session.taskAttachmentCalls?.size ?? 0).toBe(0)
    const read = written
      .map((message) => decodeMessage("AgentClientMessage", message) as any)
      .find((message) => message.exec_client_message?.id === 1)
    expect(read.exec_client_message.read_result).toEqual({ file_not_found: { path: "gone.png" } })
  })
})
