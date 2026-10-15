import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { CursorLocalCancellationError } from "../src/errors.js"
import { notifyHostInterrupt } from "../src/host-interrupt.js"
import { announceHostSteer } from "../src/host-steer.js"
import { createCursor } from "../src/index.js"
import {
  cancelIfHostStoppedSince,
  cancelRunForHostInterrupt,
  deliverContinuationResults,
  preparePriorSessionForFreshTurn,
  pumpWithRecovery,
  resetTurnStateForTests,
} from "../src/language-model.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { toolsToDescriptors } from "../src/protocol/tools.js"
import { getPersistedConversation, resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { resetConversationBindingsForTests, restoreConversationBinding } from "../src/protocol/conversation-bind.js"
import { resetCheckpointsForTests, setCheckpoint } from "../src/protocol/checkpoint.js"
import { finishEmittedStep, parseTurnProvenance, recordEmittedPart, trackTurnProvenance } from "../src/protocol/turn-provenance.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { resetCursorShellCalls } from "../src/shell-timeout.js"
import { sessionFixture } from "./session-fixture.js"

const frame = (message: Record<string, unknown>, flags = 0): Frame => ({
  flags,
  payload: encodeMessage("AgentServerMessage", message),
})
const text = (value: string) => frame({ interaction_update: { text_delta: { text: value } } })
const turnEnded = () => frame({ interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } })
const checkpoint = (bytes = [9, 9, 9]) => frame({ conversation_checkpoint_update: Uint8Array.from(bytes) })
const execAbort = (id: number) => frame({ exec_server_control_message: { abort: { id } } })
const listed = (count: number) => frame({ interaction_update: { tool_requests_listed: { call_count: count } } })
const shell = (id: number, callId: string, command = "sleep 60") => [
  frame({ interaction_update: { tool_call_started: { call_id: callId, tool_call: { shell_tool_call: { args: { command, tool_call_id: callId } } } } } }),
  frame({ exec_server_message: { id, shell_stream_args: { command, tool_call_id: callId } } }),
]
// Read-only, so the step's two shells run together instead of the second waiting for the first's result.
const listing = (id: number, callId: string) => shell(id, callId, "ls -la")
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

const cacheDir = mkdtempSync(path.join(os.tmpdir(), "cursor-host-interrupt-"))
type Held = CursorSession & { writes: Uint8Array[] }
let seq = 0

function heldSession(frames: AsyncIterator<Frame>, openCodeSessionId = `ses_stop_${++seq}`, register = true): Held {
  const writes: Uint8Array[] = []
  const definitions = [{ name: "bash", description: "Shell" }]
  const tools = toolsToDescriptors(definitions, "opencode", [])
  const session: Held = Object.assign(sessionFixture({
    sessionId: `stop_${++seq}`,
    conversationId: `conv_stop_${seq}`,
    runId: `run_${seq}`,
    openCodeSessionId,
    cacheDir,
    stream: {
      write(data: Uint8Array) { writes.push(data); return true },
      end() {},
      destroy() {},
      isClosed: () => false,
      onTerminal: () => () => {},
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
  }), { writes })
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

/** A Run the host holds after a step that ended in one of this provider's tool calls. */
function stoppedToolStep(frames: AsyncIterator<Frame>): Held {
  const session = heldSession(frames)
  const sessionKey = session.openCodeSessionId!
  restoreConversationBinding(sessionKey, session.conversationId)
  setCheckpoint(session.conversationId, Uint8Array.from([1, 1]))
  trackTurnProvenance(sessionKey, session.conversationId)
  recordEmittedPart(sessionKey, session.conversationId, { type: "tool-call", toolCallId: `cursor_${session.sessionId}_4` })
  sessionManager.registerPending(4, session, "shell_stream", "shell")
  return session
}

async function savedState(session: CursorSession) {
  const saved = await getPersistedConversation(cacheDir, session.openCodeSessionId!)
  return {
    conversationId: saved?.conversationId,
    checkpoint: [...saved?.checkpoint ?? []],
    toolCallIds: parseTurnProvenance(saved?.turnProvenance ?? "{}")?.toolCallIds,
  }
}

afterEach(() => {
  sessionManager.dispose()
  resetCursorShellCalls()
  resetTurnStateForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
})

afterAll(() => rmSync(cacheDir, { recursive: true, force: true }))

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

  it("saves the stopped step with Cursor's last checkpoint when the stream ends without turn_ended", async () => {
    const script = scriptedFrames()
    const session = stoppedToolStep(script.frames)

    const cancelled = cancelRunForHostInterrupt(session, "user")
    await until(() => cancelActions(session.writes).length > 0)
    script.push(checkpoint([7, 7]))
    script.end()
    await cancelled

    expect(session.closed).toBe(true)
    expect(await savedState(session)).toEqual({
      conversationId: session.conversationId,
      checkpoint: [7, 7],
      toolCallIds: [`cursor_${session.sessionId}_4`],
    })
  })

  it("saves the stopped step when Cursor acknowledges the cancel with its checkpoint", async () => {
    const script = scriptedFrames()
    const session = stoppedToolStep(script.frames)

    const cancelled = cancelRunForHostInterrupt(session, "user")
    await until(() => cancelActions(session.writes).length > 0)
    script.push(checkpoint([7, 7]), {
      flags: 0x02,
      payload: new TextEncoder().encode(JSON.stringify({ error: { code: "canceled" } })),
    })
    await cancelled

    expect(session.closed).toBe(true)
    expect(await savedState(session)).toEqual({
      conversationId: session.conversationId,
      checkpoint: [7, 7],
      toolCallIds: [`cursor_${session.sessionId}_4`],
    })
  })

  it("lets a turn sent right after the stop resume the Run its cancel is still draining", async () => {
    const script = scriptedFrames()
    const session = stoppedToolStep(script.frames)

    const cancelled = cancelRunForHostInterrupt(session, "user")
    await until(() => cancelActions(session.writes).length > 0)
    await until(() => sessionManager.isActivelyPumping(session))
    const prepared = preparePriorSessionForFreshTurn(session.openCodeSessionId, { timeoutMs: 1_000 })
    script.push(checkpoint([7, 7]))
    script.end()

    expect(await prepared).toBe("none")
    await cancelled
    expect(session.closed).toBe(true)
    expect(await savedState(session)).toEqual({
      conversationId: session.conversationId,
      checkpoint: [7, 7],
      toolCallIds: [`cursor_${session.sessionId}_4`],
    })
  })

  it("leaves the previous finished step finished when it cancels a Run that never pumped", async () => {
    const session = heldSession(scriptedFrames().frames)
    const sessionKey = session.openCodeSessionId!
    restoreConversationBinding(sessionKey, session.conversationId)
    trackTurnProvenance(sessionKey, session.conversationId)
    recordEmittedPart(sessionKey, session.conversationId, { type: "text-delta", delta: "The build passed successfully." })
    finishEmittedStep(sessionKey, session.conversationId)

    await cancelRunForHostInterrupt(session, "user", { graceMs: 40 })

    const saved = await getPersistedConversation(cacheDir, sessionKey)
    expect(parseTurnProvenance(saved?.turnProvenance ?? "{}")?.unfinished).toBeUndefined()
  })

  it("closes a cancelled Run that does not end within the grace period, saving the stopped step", async () => {
    const session = stoppedToolStep(scriptedFrames().frames)

    const started = Date.now()
    await cancelRunForHostInterrupt(session, "user", { graceMs: 40 })

    expect(session.closed).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(await savedState(session)).toEqual({
      conversationId: session.conversationId,
      checkpoint: [1, 1],
      toolCallIds: [`cursor_${session.sessionId}_4`],
    })
  })

  it("closes within the grace period when the cancel write cannot drain, saving the stopped step", async () => {
    const session = stoppedToolStep(scriptedFrames().frames)
    const stream = session.stream as unknown as { write: () => boolean; waitForDrain: () => Promise<void> }
    stream.write = () => false
    stream.waitForDrain = () => new Promise(() => {})

    const started = Date.now()
    await cancelRunForHostInterrupt(session, "user", { graceMs: 40 })

    expect(session.closed).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect((await savedState(session)).toolCallIds).toEqual([`cursor_${session.sessionId}_4`])
  })

  it("saves a Run whose cancel is still draining when the host shuts down", async () => {
    const session = stoppedToolStep(scriptedFrames().frames)
    session.requestedAt = Date.now() - 5

    await notifyHostInterrupt(session.openCodeSessionId, "user", Date.now())
    await until(() => cancelActions(session.writes).length > 0)
    await Promise.race([notifyHostInterrupt(undefined, "shutdown"), Bun.sleep(300)])

    expect(session.closed).toBe(false)
    expect(await savedState(session)).toEqual({
      conversationId: session.conversationId,
      checkpoint: [1, 1],
      toolCallIds: [`cursor_${session.sessionId}_4`],
    })
  })

  it("saves open Runs on shutdown without cancelling them", async () => {
    const session = stoppedToolStep(scriptedFrames().frames)

    await notifyHostInterrupt(undefined, "shutdown")

    expect(cancelActions(session.writes)).toEqual([])
    expect(session.closed).toBe(false)
    expect(await savedState(session)).toEqual({
      conversationId: session.conversationId,
      checkpoint: [1, 1],
      toolCallIds: [`cursor_${session.sessionId}_4`],
    })
  })

  it("reaches the copy of the model that holds the Run, and spares a Run opened after the stop", async () => {
    const pluginCopy = await import(`../src/host-interrupt.js?copy=${Date.now()}`) as typeof import("../src/host-interrupt.js")
    const stopAt = Date.now()
    const stopped = heldSession(scriptedFrames([turnEnded()]).frames, "ses_copy")
    stopped.requestedAt = stopAt - 1
    sessionManager.registerPending(1, stopped, "shell_stream", "shell")
    const other = heldSession(scriptedFrames().frames, "ses_other")
    sessionManager.registerPending(1, other, "shell_stream", "shell")

    await pluginCopy.notifyHostInterrupt("ses_copy", "user", stopAt)
    await until(() => stopped.closed)
    expect(stopped.closed).toBe(true)
    expect(other.closed).toBe(false)

    const next = heldSession(scriptedFrames().frames, "ses_copy")
    next.requestedAt = stopAt
    await pluginCopy.notifyHostInterrupt("ses_copy", "user", stopAt)
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

  it("keeps Cursor's last checkpoint when the stream ends while the pump still owns the Run", async () => {
    const script = scriptedFrames([text("Here is a long answer")])
    const session = stoppedToolStep(script.frames)
    sessionManager.abandonPending(session)
    let terminal: ((event: { kind: "remote-clean-close" }) => void) | undefined
    ;(session.stream as unknown as { onTerminal: unknown }).onTerminal = (listener: typeof terminal) => {
      terminal = listener
      return () => {}
    }
    sessionManager.replaceStream(session, session.stream)
    const { controller, parts } = collector()
    const pumping = pumpWithRecovery({ initialSession: session, controller, recover: async () => { throw new Error("no") } })
    pumping.catch(() => {})
    await until(() => parts.some((part) => part.type === "text-delta"))

    const cancelled = cancelRunForHostInterrupt(session, "user")
    await until(() => cancelActions(session.writes).length > 0)
    terminal?.({ kind: "remote-clean-close" })
    script.push(checkpoint([7, 7]))
    script.end()
    await cancelled

    expect(session.closed).toBe(true)
    expect((await savedState(session)).checkpoint).toEqual([7, 7])
  })

  it("does not inject a steer into a Run the host stopped while its pump waits", async () => {
    const script = scriptedFrames([text("waiting on the shell")])
    const session = heldSession(script.frames)
    const { controller } = collector()
    const pumping = pumpWithRecovery({ initialSession: session, controller, recover: async () => { throw new Error("no") } })
    pumping.catch(() => {})
    await until(() => session.pumpOwner != null)

    const cancelled = cancelRunForHostInterrupt(session, "user")
    const taken = announceHostSteer({ sessionID: session.openCodeSessionId!, inboxID: `msg_${session.sessionId}`, text: "change of plan" })
    script.push(checkpoint(), frame({}, 0x02))
    await expect(pumping).rejects.toBeInstanceOf(CursorLocalCancellationError)
    await cancelled

    expect(taken).toBe(false)
    expect(clientMessages(session.writes).filter((message) => message.conversation_action?.inject_context_action)).toEqual([])
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
      const model = createCursor({ name: "cursor", accessToken: "token", cacheDir }).languageModel("cursor-test")
      const result = await model.doStream({
        prompt: [
          { role: "user", content: [{ type: "text", text: "run it" }] },
          { role: "assistant", content: [{ type: "tool-call", toolCallId: callId, toolName: "bash", input: "{}" }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: callId, toolName: "bash", output: { type: "text", value: "done" } }] },
        ],
        headers: { "x-opencode-session-id": "ses_pull" },
        tools: [{ type: "function", name: "bash", description: "Shell", inputSchema: { type: "object", properties: {} } }],
      } as LanguageModelV3CallOptions)
      const reader = result.stream.getReader()
      const consumed = (async () => { while (!(await reader.read()).done) { /* drain */ } })()
      consumed.catch(() => {})
      await until(() => execResults(session.writes).length > 0 && session.pumpOwner != null)

      void notifyHostInterrupt("ses_pull", "user", Date.now())
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

    await notifyHostInterrupt("ses_parent", "user", Date.now())
    await until(() => helper.closed)
    expect(cancelActions(helper.writes)).toEqual([{ reason: "user_cancelled" }])
    expect(cancelActions(title.writes)).toEqual([])
    expect(title.closed).toBe(false)
  })

  it("cancels a Run its model call opened after the stop, and not the next turn's", async () => {
    const stopAt = Date.now()
    await notifyHostInterrupt("ses_late", "user", stopAt)

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

describe("Cursor's exec abort", () => {
  it("drops the late result of an exec Cursor withdrew mid-step and writes nothing for it", async () => {
    const script = scriptedFrames([listed(2), ...listing(2, "a"), execAbort(2), ...listing(3, "b")])
    const session = heldSession(script.frames)
    const { controller, parts } = collector()
    await pumpWithRecovery({ initialSession: session, controller, recover: async () => { throw new Error("no") } })
    expect(parts.filter((part) => part.type === "tool-call")).toHaveLength(2)
    expect(session.pending.get(2)?.aborted).toBe(true)

    const results = [2, 3].map((execId) => ({
      toolCallId: `cursor_${session.sessionId}_${execId}`,
      sessionId: session.sessionId,
      execId,
      toolName: "bash",
      output: `out ${execId}`,
    }))
    await deliverContinuationResults(session, results)

    expect([...new Set(execResults(session.writes).map((message) => message.id))]).toEqual([3])
    expect(session.pending.size).toBe(0)
  })

  it("leaves a withdrawn exec out of a fresh turn's cancelled results", async () => {
    const script = scriptedFrames([listed(2), ...listing(5, "c"), execAbort(5), ...listing(6, "d")])
    const session = heldSession(script.frames, "ses_fresh_abort")
    const { controller } = collector()
    await pumpWithRecovery({ initialSession: session, controller, recover: async () => { throw new Error("no") } })
    script.push(turnEnded())

    await preparePriorSessionForFreshTurn("ses_fresh_abort", { timeoutMs: 200 })

    expect([...new Set(execResults(session.writes).map((message) => message.id))]).toEqual([6])
  })
})
