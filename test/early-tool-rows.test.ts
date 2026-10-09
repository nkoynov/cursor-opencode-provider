import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { encodeMessage } from "../src/protocol/messages.js"
import { OPENCODE_1_TOOL_DIALECT, OPENCODE_2_TOOL_DIALECT, toolsToDescriptors } from "../src/protocol/tools.js"
import {
  deliverContinuationResults,
  extractTrailingToolResults,
  foldStreamParts,
  pump,
  pumpWithRecovery,
  resetTurnStateForTests,
} from "../src/language-model.js"
import { SessionManager, sessionManager, type CursorSession, type Frame } from "../src/session.js"

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
const taskDone = (id: number, callId: string, subagentType = "generalPurpose") => [
  started(callId, { task_tool_call: { args: { description: "Count lines", prompt: "Count the lines of data/app.log." } } }),
  frame({
    exec_server_message: {
      id,
      subagent_args: { tool_call_id: callId, prompt: "Count the lines of data/app.log.", subagent_type: subagentType },
    },
  }),
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "early-rows-"))
  roots.push(root)
  const definitions = tools.map((name) => ({ name, description: name }))
  const descriptors = toolsToDescriptors(definitions, "opencode", [])
  return {
    sessionId: `early${++seq}`,
    conversationId: "early-conversation",
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
const kinds = (parts: any[]) => parts
  .filter((p) => ["tool-input-start", "tool-input-end", "tool-call", "tool-result", "finish"].includes(p.type))
  .map((p) => p.type === "tool-call" && p.providerExecuted ? "tool-call(provider)" : p.type)

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

describe("early tool rows", () => {
  afterEach(() => {
    sessionManager.dispose()
    resetTurnStateForTests()
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it("shows a write row while Cursor still composes a new file, and runs the write under its id", async () => {
    const script = scriptedFrames()
    const session = fakeSession(script.frames)
    const target = path.join(rootOf(session), "NEW.md")
    const { parts, controller } = collector()
    const pumping = pump(session, controller, { textId: "text", reasoningId: "reasoning" })
    script.push(thinking("Writing the notes."), ...editAnnounced("w", target), heartbeat())

    await until(() => rowStarts(parts).length === 1)
    const [row] = rowStarts(parts)
    expect(row).toEqual({ type: "tool-input-start", id: `cursor_${session.sessionId}_900000`, toolName: "write", providerExecuted: true })
    expect(parts.findIndex((p) => p.type === "reasoning-end")).toBeLessThan(parts.indexOf(row))

    script.push(...editDone(1, 2, "w", target, "# notes\n"))
    await pumping
    expect(kinds(parts)).toEqual(["tool-input-start", "tool-input-end", "tool-call", "finish"])
    const [call] = hostCalls(parts)
    expect(call).toMatchObject({ toolCallId: row.id, toolName: "write" })
    expect(session.pending.get(2)?.toolCallId).toBe(row.id)
  })

  it("routes the host's result for a row id back to Cursor's exec", async () => {
    const script = scriptedFrames()
    const session = fakeSession(script.frames)
    const target = path.join(rootOf(session), "NEW.md")
    script.push(...editAnnounced("w", target), ...editDone(1, 2, "w", target, "x\n"))
    const parts = await pumpOnce(session)
    const id = hostCalls(parts)[0].toolCallId
    expect(id).toBe(rowStarts(parts)[0].id)

    const results = extractTrailingToolResults([
      { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "write", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "write", output: { type: "error-text", value: "denied" } }] },
    ] as any)
    expect(results).toMatchObject([{ toolCallId: id, sessionId: session.sessionId, execId: 2, error: "denied" }])
    expect(await deliverContinuationResults(session, results)).toBe(session)
    expect(session.pending.size).toBe(0)
  })

  it("names the row edit for a file that already has content, and write for an empty one", async () => {
    for (const [content, expected] of [["old\n", "edit"], ["", "write"]] as const) {
      const script = scriptedFrames()
      const session = fakeSession(script.frames)
      const target = path.join(rootOf(session), "EXISTING.md")
      fs.writeFileSync(target, content)
      script.push(...editAnnounced("e", target), ...editDone(1, 2, "e", target, "new\n"))
      const parts = await pumpOnce(session)
      expect(rowStarts(parts).map((p) => p.toolName)).toEqual([expected])
      expect(hostCalls(parts)).toMatchObject([{ toolCallId: rowStarts(parts)[0].id, toolName: expected }])
      sessionManager.dispose()
    }
  })

  it("opens no row for an edit outside the workspace, whose read goes through the host", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "early-outside-"))
    roots.push(outside)
    const script = scriptedFrames()
    const session = fakeSession(script.frames)
    const external = path.join(outside, "memory.md")
    const inside = path.join(rootOf(session), "memory.md")
    for (const target of [external, inside]) fs.writeFileSync(target, "old\n")

    script.push(...editAnnounced("e", external), ...editDone(1, 2, "e", external, "new\n"))
    const first = await pumpOnce(session)
    expect(rowStarts(first)).toEqual([])
    expect(hostCalls(first).map((p) => p.toolName)).toEqual(["read"])
    sessionManager.dispose()

    const again = scriptedFrames()
    const local = fakeSession(again.frames)
    const localTarget = path.join(rootOf(local), "memory.md")
    fs.writeFileSync(localTarget, "old\n")
    again.push(...editAnnounced("e", localTarget), ...editDone(1, 2, "e", localTarget, "new\n"))
    expect(rowStarts(await pumpOnce(local)).map((p) => p.toolName)).toEqual(["edit"])
  })

  it("shows a subagent row from Cursor's first announcement", async () => {
    const script = scriptedFrames()
    const session = fakeSession(script.frames)
    const { parts, controller } = collector()
    const pumping = pump(session, controller, { textId: "text", reasoningId: "reasoning" })
    script.push(partial("t", { task_tool_call: {} }), heartbeat())
    await until(() => rowStarts(parts).length === 1)
    expect(rowStarts(parts)[0].toolName).toBe("subagent")

    script.push(...taskDone(1, "t"))
    await pumping
    expect(hostCalls(parts)).toMatchObject([{ toolCallId: rowStarts(parts)[0].id, toolName: "subagent" }])
    expect(JSON.parse(hostCalls(parts)[0].input)).toMatchObject({ agent: "general" })
  })

  it("closes the row with Cursor's refusal when the call cannot run", async () => {
    const script = scriptedFrames()
    const session = fakeSession(script.frames)
    session.subagentCatalog = { executor: "subagent", agents: [{ name: "explore" }], complete: true }
    script.push(partial("t", { task_tool_call: {} }), ...taskDone(1, "t", "generalPurpose"), turnEnded())
    const parts = await pumpOnce(session)
    expect(kinds(parts)).toEqual(["tool-input-start", "tool-input-end", "tool-call(provider)", "tool-result", "finish"])
    const [closed] = closedRows(parts)
    expect(closed.toolCallId).toBe(rowStarts(parts)[0].id)
    expect(closed.result).toContain("no compatible host agent")
    expect(hostCalls(parts)).toEqual([])
  })

  it("closes the row and runs the call under its own id when it becomes another tool", async () => {
    const script = scriptedFrames()
    const session = fakeSession(script.frames)
    const target = path.join(rootOf(session), "RACE.md")
    const { parts, controller } = collector()
    const pumping = pump(session, controller, { textId: "text", reasoningId: "reasoning" })
    script.push(...editAnnounced("e", target), heartbeat())
    await until(() => rowStarts(parts).length === 1)
    expect(rowStarts(parts)[0].toolName).toBe("write")

    fs.writeFileSync(target, "created meanwhile\n")
    script.push(...editDone(1, 2, "e", target, "new\n"))
    await pumping
    const [call] = hostCalls(parts)
    expect(call.toolName).toBe("edit")
    expect(call.toolCallId).toBe(`cursor_${session.sessionId}_2`)
    expect(closedRows(parts).map((p) => p.toolCallId)).toEqual([rowStarts(parts)[0].id])
    expect(parts.indexOf(closedRows(parts)[0])).toBeLessThan(parts.findIndex((p) => p.type === "finish"))
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
    expect(hostCalls(parts).map((p) => p.toolName)).toEqual(["shell"])

    await deliverAll(session)
    script.push(heartbeat(), ...editDone(2, 3, "e", target, "x\n"))
    const next = await pumpOnce(session)
    expect(hostCalls(next)).toMatchObject([{ toolCallId: rowStarts(next)[0]?.id, toolName: "write" }])
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

    await deliverAll(session)
    script.push(completed("s", { shell_tool_call: { args: { command: "touch a" } } }), heartbeat())
    script.push(...editDone(2, 3, "e", target, "x\n"))
    const next = await pumpOnce(session)
    expect(rowStarts(next).map((p) => p.toolName)).toEqual(["write"])
  })

  it("shows the second of two parallel edits in the next step, not in the step the first edit ends", async () => {
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
    const { parts, controller } = collector()
    const pumping = pump(session, controller, { textId: "text", reasoningId: "reasoning" })
    script.push(heartbeat())
    await until(() => rowStarts(parts).length === 1)
    expect(hostCalls(parts)).toEqual([])

    script.push(...editDone(3, 4, "e2", second, "b\n"))
    await pumping
    expect(hostCalls(parts)).toMatchObject([{ toolCallId: rowStarts(parts)[0].id, toolName: "write" }])
    expect(closedRows(parts)).toEqual([])
  })

  it("closes an open row when the turn ends without the call", async () => {
    const script = scriptedFrames()
    const session = fakeSession(script.frames)
    script.push(partial("t", { task_tool_call: {} }), turnEnded())
    const parts = await pumpOnce(session)
    expect(kinds(parts)).toEqual(["tool-input-start", "tool-input-end", "tool-call(provider)", "tool-result", "finish"])
    expect(closedRows(parts)[0].result).toContain("ended the turn")
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

  it("closes the row of a call Cursor completes without an exec", async () => {
    const script = scriptedFrames()
    const session = fakeSession(script.frames)
    script.push(
      partial("t", { task_tool_call: {} }),
      started("t", { task_tool_call: { args: { description: "", prompt: "" } } }),
      completed("t", { task_tool_call: { args: { description: "", prompt: "" } } }),
      turnEnded(),
    )
    const parts = await pumpOnce(session)
    expect(closedRows(parts).map((p) => p.result)).toEqual(["Cursor finished this call without asking OpenCode to run it."])
  })

  it("closes the rows of a Run that is replaced, and opens new ones for the new Run's calls", async () => {
    const first = scriptedFrames([checkpoint(), partial("t1", { task_tool_call: {} })])
    const session = fakeSession(first.frames)
    session.openCodeSessionId = "ses_early_recover"
    const second = scriptedFrames([partial("t2", { task_tool_call: {} }), ...taskDone(1, "t2")])
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
        return replacement
      },
    })
    await until(() => rowStarts(parts).length === 1)
    first.end()
    await pumping
    const [old, fresh] = rowStarts(parts)
    expect(closedRows(parts).map((p) => p.toolCallId)).toEqual([old.id])
    expect(closedRows(parts)[0].result).toContain("new stream")
    expect(hostCalls(parts)).toMatchObject([{ toolCallId: fresh.id, toolName: "subagent" }])
    expect(fresh.id).not.toBe(old.id)
    sessionManager.close(replacement!)
  })

  it("leaves a row to OpenCode when the host stops the turn", async () => {
    const script = scriptedFrames()
    const session = fakeSession(script.frames)
    const { parts, controller } = collector()
    const pumping = pump(session, controller, { textId: "text", reasoningId: "reasoning" })
    script.push(partial("t", { task_tool_call: {} }), heartbeat())
    await until(() => rowStarts(parts).length === 1)
    session.hostInterrupted = "user"
    script.push(heartbeat())
    await expect(pumping).rejects.toThrow("host stopped the turn")
    expect(kinds(parts)).toEqual(["tool-input-start"])
  })

  it("opens no rows for an OpenCode 1 host, a tool-less request, or a tool this turn does not permit", async () => {
    const cases: Array<[(session: CursorSession) => void, number]> = [
      [() => {}, 1],
      [(session) => { session.hostToolDialect = OPENCODE_1_TOOL_DIALECT }, 0],
      [(session) => { session.allowTools = false }, 0],
      [(session) => { session.permittedToolNames = new Set(["read", "edit"]) }, 0],
    ]
    for (const [configure, rows] of cases) {
      const script = scriptedFrames()
      const session = fakeSession(script.frames)
      configure(session)
      const target = path.join(rootOf(session), "NEW.md")
      script.push(...editAnnounced("w", target), turnEnded())
      const parts = await pumpOnce(session)
      expect(rowStarts(parts).length).toBe(rows)
      sessionManager.dispose()
    }
  })

  it("leaves a closed row out of a non-streaming answer", async () => {
    const script = scriptedFrames()
    const session = fakeSession(script.frames)
    script.push(partial("t", { task_tool_call: {} }), turnEnded())
    const parts = await pumpOnce(session)
    expect(closedRows(parts)).toHaveLength(1)
    expect(foldStreamParts(parts).content.filter((part) => part.type === "tool-call")).toEqual([])
  })

  it("asks the running-tool lease about the call under its row id", async () => {
    const script = scriptedFrames()
    const session = fakeSession(script.frames)
    const target = path.join(rootOf(session), "NEW.md")
    script.push(...editAnnounced("w", target), ...editDone(1, 2, "w", target, "x\n"))
    const parts = await pumpOnce(session)
    const id = hostCalls(parts)[0].toolCallId
    expect(id).toBe(`cursor_${session.sessionId}_900000`)

    const asked: string[] = []
    const manager = new SessionManager({
      activitySource: { lastActivityAt: () => undefined, isToolRunning: (toolCallId: string) => { asked.push(toolCallId); return false } },
    })
    manager.registerPending(2, session, "write_result", "write")
    session.pending.get(2)!.toolCallId = id
    asked.length = 0
    manager.classify(session.sessionId, 2)
    expect(asked).toEqual([id])
    manager.dispose()
  })
})
