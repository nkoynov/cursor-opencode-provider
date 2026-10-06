import { afterEach, describe, expect, it } from "bun:test"
import { CursorLocalCancellationError } from "../src/errors.js"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { notifyHostInterrupt } from "../src/host-interrupt.js"
import { createCursor } from "../src/index.js"
import {
  cancelIfHostStoppedSince,
  cancelRunForHostInterrupt,
  pumpWithRecovery,
  resetTurnStateForTests,
} from "../src/language-model.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { toolsToDescriptors } from "../src/protocol/tools.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { resetCursorShellCalls } from "../src/shell-timeout.js"

const frame = (message: Record<string, unknown>, flags = 0): Frame => ({
  flags,
  payload: encodeMessage("AgentServerMessage", message),
})
const text = (value: string) => frame({ interaction_update: { text_delta: { text: value } } })
const turnEnded = () => frame({ interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } })
const checkpoint = () => frame({ conversation_checkpoint_update: Uint8Array.from([9, 9, 9]) })
const execAbort = (id: number) => frame({ exec_server_control_message: { abort: { id } } })
const listed = (count: number) => frame({ interaction_update: { tool_requests_listed: { call_count: count } } })
const shell = (id: number, callId: string) => [
  frame({ interaction_update: { tool_call_started: { call_id: callId, tool_call: { shell_tool_call: { args: { command: "sleep 60", tool_call_id: callId } } } } } }),
  frame({ exec_server_message: { id, shell_stream_args: { command: "sleep 60", tool_call_id: callId } } }),
]
const toolCallCompleted = (callId: string) =>
  frame({ interaction_update: { tool_call_completed: { call_id: callId, tool_call: { shell_tool_call: { args: { command: "sleep 60" } } } } } })

/** Frames in order; a read past the end waits for `push` (Cursor is quiet) or `end`. */
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

type Held = CursorSession & { writes: Uint8Array[] }
let seq = 0

function heldSession(frames: AsyncIterator<Frame>, openCodeSessionId = `ses_stop_${++seq}`, register = true): Held {
  const writes: Uint8Array[] = []
  const definitions = [{ name: "bash", description: "Shell" }]
  const tools = toolsToDescriptors(definitions, "opencode", [])
  const session = {
    sessionId: `stop_${seq}`,
    conversationId: `conv_stop_${seq}`,
    runId: `run_${seq}`,
    openCodeSessionId,
    stream: {
      write(data: Uint8Array) { writes.push(data); return true },
      end() {},
      destroy() {},
      isClosed: () => false,
      frames: () => ({ [Symbol.asyncIterator]: () => frames }),
    },
    frames,
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolCatalog: definitions,
    knownMcpServers: [],
    toolDescriptors: tools,
    requestContext: { tools, env: { workspace_paths: ["/w"] } },
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: false,
    heartbeat: null,
    writes,
  } as unknown as Held
  if (register) sessionManager.registerSession(session)
  return session
}

const clientMessages = (writes: Uint8Array[]): any[] => writes.map((data) => decodeMessage<any>("AgentClientMessage", data))
const cancelActions = (writes: Uint8Array[]) =>
  clientMessages(writes).map((message) => message.conversation_action?.cancel_action).filter((action) => action)
const execResults = (writes: Uint8Array[]) =>
  clientMessages(writes).map((message) => message.exec_client_message).filter((message) => message)

function collector() {
  const parts: any[] = []
  const controller = {
    enqueue(part: unknown) { parts.push(part) },
    close() {},
    error() {},
  } as unknown as ReadableStreamDefaultController<any>
  return { parts, controller }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5)
}

afterEach(() => {
  sessionManager.dispose()
  resetCursorShellCalls()
  resetTurnStateForTests()
})

describe("host interrupt (OpenCode 2 Stop)", () => {
  it("cancels a held Run as Cursor CLI's Stop does and keeps the checkpoint Cursor ends it with", async () => {
    const script = scriptedFrames()
    const session = heldSession(script.frames)
    sessionManager.registerPending(4, session, "shell_stream", "shell")
    session.heartbeatCancel = () => { session.heartbeat = null }

    const cancelled = cancelRunForHostInterrupt(session, "user")
    await until(() => cancelActions(session.writes).length > 0)
    script.push(execAbort(4), toolCallCompleted("a"), checkpoint(), frame({}, 0x02))
    await cancelled

    expect(cancelActions(session.writes)).toEqual([{ reason: "user_cancelled" }])
    expect(execResults(session.writes)).toEqual([])
    expect([...session.resumeCheckpoint ?? []]).toEqual([9, 9, 9])
    expect(session.closed).toBe(true)
    expect(sessionManager.classify(session.sessionId, 4)).toEqual({ kind: "terminal", reason: "host-interrupted" })
  })

  it("closes a cancelled Run that Cursor ends with turn_ended", async () => {
    const script = scriptedFrames()
    const session = heldSession(script.frames)
    sessionManager.registerPending(4, session, "shell_stream", "shell")

    const cancelled = cancelRunForHostInterrupt(session, "user")
    await until(() => cancelActions(session.writes).length > 0)
    script.push(checkpoint(), turnEnded())
    await cancelled

    expect(session.closed).toBe(true)
    expect(execResults(session.writes)).toEqual([])
  })

  it("closes a cancelled Run that does not end within the grace period", async () => {
    const session = heldSession(scriptedFrames().frames)
    sessionManager.registerPending(1, session, "shell_stream", "shell")

    const started = Date.now()
    await cancelRunForHostInterrupt(session, "user", { graceMs: 40 })

    expect(session.closed).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("reaches the copy of the model that holds the Run, and spares a Run opened after the stop", async () => {
    const pluginCopy = await import(`../src/host-interrupt.js?copy=${Date.now()}`) as typeof import("../src/host-interrupt.js")
    const stopAt = Date.now()
    const stopped = heldSession(scriptedFrames([turnEnded()]).frames, "ses_copy")
    stopped.requestedAt = stopAt - 1
    sessionManager.registerPending(1, stopped, "shell_stream", "shell")
    const other = heldSession(scriptedFrames().frames, "ses_other")
    sessionManager.registerPending(1, other, "shell_stream", "shell")

    pluginCopy.notifyHostInterrupt("ses_copy", "user", stopAt)
    await until(() => stopped.closed)
    expect(stopped.closed).toBe(true)
    expect(other.closed).toBe(false)

    const next = heldSession(scriptedFrames().frames, "ses_copy")
    next.requestedAt = stopAt
    pluginCopy.notifyHostInterrupt("ses_copy", "user", stopAt)
    await Bun.sleep(20)
    expect(next.closed).toBe(false)
    expect(cancelActions(next.writes)).toEqual([])
  })

  it("stops a pumping Run at its next frame, without its in-flight tool call, and drains it", async () => {
    const script = scriptedFrames([text("Here is a long answer")])
    const session = heldSession(script.frames)
    const { controller, parts } = collector()
    let recovered = 0
    const pumping = pumpWithRecovery({
      initialSession: session,
      controller,
      maxRecoveries: 2,
      recover: async () => { recovered++; throw new Error("must not reopen a stopped turn") },
    })
    pumping.catch(() => {})
    await until(() => session.pumpOwner != null)

    const cancelled = cancelRunForHostInterrupt(session, "user")
    await until(() => cancelActions(session.writes).length > 0)
    script.push(listed(1), ...shell(1, "late"), checkpoint(), frame({}, 0x02))

    await expect(pumping).rejects.toBeInstanceOf(CursorLocalCancellationError)
    await cancelled
    expect(recovered).toBe(0)
    expect(parts.filter((part) => part.type === "tool-call")).toEqual([])
    expect(execResults(session.writes)).toEqual([])
    expect([...session.resumeCheckpoint ?? []]).toEqual([9, 9, 9])
    expect(session.closed).toBe(true)
    expect(cancelActions(session.writes)).toEqual([{ reason: "user_cancelled" }])
  })

  it("closes a cancelled Run whose pump Cursor leaves waiting", async () => {
    const session = heldSession(scriptedFrames([text("thinking")]).frames)
    const { controller } = collector()
    const pumping = pumpWithRecovery({ initialSession: session, controller, recover: async () => { throw new Error("no") } })
    pumping.catch(() => {})
    await until(() => session.pumpOwner != null)

    await cancelRunForHostInterrupt(session, "user", { graceMs: 40 })

    expect(session.closed).toBe(true)
    await expect(pumping).rejects.toBeInstanceOf(CursorLocalCancellationError)
  })

  it("does not recover when the cancelled Run's stream ends before turn_ended", async () => {
    const script = scriptedFrames()
    const session = heldSession(script.frames)
    const { controller } = collector()
    let recovered = 0
    const pumping = pumpWithRecovery({
      initialSession: session,
      controller,
      maxRecoveries: 2,
      recover: async () => { recovered++; throw new Error("must not reopen a stopped turn") },
    })
    pumping.catch(() => {})
    await until(() => session.pumpOwner != null)

    const cancelled = cancelRunForHostInterrupt(session, "user")
    await until(() => cancelActions(session.writes).length > 0)
    script.end()

    await expect(pumping).rejects.toBeInstanceOf(CursorLocalCancellationError)
    await cancelled
    expect(recovered).toBe(0)
    expect(session.closed).toBe(true)
  })

  it("leaves a stopped continuation to its cancel instead of closing it when its stream fails", async () => {
    const script = scriptedFrames()
    const session = heldSession(script.frames, "ses_pull")
    session.requestedAt = Date.now() - 10
    sessionManager.registerPending(1, session, "shell_stream", "shell")
    const callId = `cursor_${session.sessionId}_1`
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error("no network in this test") }) as unknown as typeof fetch
    try {
      const model = createCursor({ name: "cursor", accessToken: "token" }).languageModel("cursor-test")
      const result = await model.doStream({
        prompt: [
          { role: "user", content: [{ type: "text", text: "run it" }] },
          { role: "assistant", content: [{ type: "tool-call", toolCallId: callId, toolName: "bash", input: "{}" }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: callId, toolName: "bash", output: { type: "text", value: "done" } }] },
        ],
        headers: { "x-opencode-session-id": "ses_pull" },
        tools: [{ type: "function", name: "bash", description: "Shell", inputSchema: { type: "object", properties: {} } }],
      } as LanguageModelV3CallOptions)
      const consumed = (async () => { for await (const _ of result.stream) { /* drain */ } })()
      consumed.catch(() => {})
      await until(() => execResults(session.writes).length > 0 && session.pumpOwner != null)

      notifyHostInterrupt("ses_pull", "user", Date.now())
      await until(() => cancelActions(session.writes).length > 0)
      script.push(execAbort(1), checkpoint(), frame({}, 0x02))

      await expect(consumed).rejects.toBeInstanceOf(CursorLocalCancellationError)
      await until(() => session.closed)
      expect([...session.resumeCheckpoint ?? []]).toEqual([9, 9, 9])
      expect(session.closed).toBe(true)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("reaches a helper isolated from the stopped session, but not a title Run", async () => {
    const helper = heldSession(scriptedFrames([turnEnded()]).frames)
    helper.openCodeSessionId = undefined
    helper.stoppedWithSessionId = "ses_parent"
    helper.requestedAt = Date.now() - 5
    sessionManager.registerPending(1, helper, "shell_stream", "shell")
    const title = heldSession(scriptedFrames().frames)
    title.openCodeSessionId = undefined
    title.requestedAt = Date.now() - 5

    notifyHostInterrupt("ses_parent", "user", Date.now())
    await until(() => helper.closed)
    expect(cancelActions(helper.writes)).toEqual([{ reason: "user_cancelled" }])
    expect(cancelActions(title.writes)).toEqual([])
    expect(title.closed).toBe(false)
  })

  it("cancels a Run its model call opened after the stop, and not the next turn's", async () => {
    const stopAt = Date.now()
    notifyHostInterrupt("ses_late", "user", stopAt)

    const late = heldSession(scriptedFrames([turnEnded()]).frames, "ses_late")
    late.requestedAt = stopAt - 5
    cancelIfHostStoppedSince(late)
    await until(() => late.closed)
    expect(cancelActions(late.writes)).toEqual([{ reason: "user_cancelled" }])

    const next = heldSession(scriptedFrames().frames, "ses_late")
    next.requestedAt = stopAt + 5
    cancelIfHostStoppedSince(next)
    await Bun.sleep(20)
    expect(cancelActions(next.writes)).toEqual([])
    expect(next.closed).toBe(false)
  })

  it("leaves a Run alone when the turn just ends", async () => {
    const script = scriptedFrames([text("ok"), turnEnded()])
    const session = heldSession(script.frames)
    const { controller, parts } = collector()

    await pumpWithRecovery({ initialSession: session, controller, recover: async () => { throw new Error("no") } })

    expect(parts.some((part) => part.type === "finish" && part.finishReason.unified === "stop")).toBe(true)
    expect(cancelActions(session.writes)).toEqual([])
    expect(session.hostInterrupted).toBeUndefined()
  })
})
