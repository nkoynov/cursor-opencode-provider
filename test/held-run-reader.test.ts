import { afterEach, describe, expect, it } from "bun:test"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { attachSessionHeartbeat, readHeldRun } from "../src/language-model.js"
import { putBackFrame, readSessionFrame, SessionManager, sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { sessionFixture } from "./session-fixture.js"

afterEach(() => sessionManager.dispose())

/** A Run whose inbound frames arrive only when the test sends them. */
type HeldRun = {
  session: CursorSession
  send: (message: Record<string, unknown>) => void
  sendRaw: (frame: Frame) => void
  fail: (error: Error) => void
  written: Array<Record<string, any>>
}

function heldRun(register = true, options: { failWrites?: boolean } = {}): HeldRun {
  const queued: Frame[] = []
  const waiting: Array<{ resolve: (result: IteratorResult<Frame>) => void; reject: (error: Error) => void }> = []
  const frames: AsyncIterator<Frame> = {
    next: () => {
      const frame = queued.shift()
      if (frame) return Promise.resolve({ done: false, value: frame })
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }))
    },
  }
  const written: Array<Record<string, any>> = []
  const session = sessionFixture({
    sessionId: `held-${Math.random().toString(16).slice(2)}`,
    conversationId: `conv-held-${Math.random().toString(16).slice(2)}`,
    stream: {
      write(bytes: Uint8Array) {
        if (options.failWrites) throw new Error("stream reset")
        written.push(decodeMessage<Record<string, any>>("AgentClientMessage", bytes))
        return true
      },
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
    toolDescriptors: [],
    requestContext: {},
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    allowTools: true,
    pumpActive: false,
    heartbeat: null,
    heartbeatCancel: null,
    closed: false,
  })
  if (register) sessionManager.registerSession(session)
  const sendRaw = (frame: Frame) => {
    const waiter = waiting.shift()
    if (waiter) waiter.resolve({ done: false, value: frame })
    else queued.push(frame)
  }
  const send = (message: Record<string, unknown>) => sendRaw({ flags: 0, payload: encodeMessage("AgentServerMessage", message) })
  const fail = (error: Error) => waiting.shift()?.reject(error)
  return { session, send, sendRaw, fail, written }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
const kvSet = (id: number) => ({
  kv_server_message: { id, set_blob_args: { blob_id: new Uint8Array(32).fill(id), blob_data: Uint8Array.from([1, 2, 3]) } },
})
const heartbeat = { interaction_update: { heartbeat: {} } }

describe("held Run reader", () => {
  it("answers KV and applies an abort while the host runs the tool, queuing other frames in order", async () => {
    const { session, send, written } = heldRun()
    sessionManager.registerPending(0, session, "shell_result", "bash", false)
    readHeldRun(session)

    // What Cursor sent live right after a step: the call count and a checkpoint, then KV writes.
    send({ interaction_update: { tool_requests_listed: { call_count: 1 } } })
    send({ conversation_checkpoint_update: Uint8Array.from([0x0a, 0x00]) })
    send(heartbeat)
    send(kvSet(7))
    await settle()
    expect(written.map((message) => message.kv_client_message?.id)).toEqual([7])
    expect(written[0]!.kv_client_message.set_blob_result).toBeDefined()

    // Exec 0 is the first exec of a Run; its id is absent on the wire.
    send({ exec_server_control_message: { abort: { id: 0 } } })
    send({ interaction_update: { text_delta: { text: "after the abort" } } })
    send(kvSet(8))
    await settle()
    expect(session.pending.get(0)?.aborted).toBe(true)
    expect(written.map((message) => message.kv_client_message?.id)).toEqual([7, 8])

    // The pump then reads exactly the frames the reader did not handle, in arrival order.
    const order: string[] = []
    for (let index = 0; index < 3; index++) {
      const next = await readSessionFrame(session)
      const asm = decodeMessage<Record<string, any>>("AgentServerMessage", (next.value as Frame).payload)
      order.push(asm.interaction_update?.tool_requests_listed ? "listed"
        : asm.conversation_checkpoint_update?.length ? "checkpoint"
        : asm.interaction_update?.text_delta?.text ?? "?")
    }
    expect(order).toEqual(["listed", "checkpoint", "after the abort"])
    expect(session.heldFrames).toEqual([])
  })

  it("keeps an abort behind the exec request it refers to", async () => {
    const { session, send } = heldRun()
    sessionManager.registerPending(0, session, "shell_result", "bash", false)
    readHeldRun(session)
    send({ exec_server_message: { id: 1, read_args: { path: "/tmp/x", tool_call_id: "call-read" } } })
    send({ exec_server_control_message: { abort: { id: 1 } } })
    await settle()
    expect(session.pending.has(1)).toBe(false)
    const first = decodeMessage<Record<string, any>>("AgentServerMessage", ((await readSessionFrame(session)).value as Frame).payload)
    const second = decodeMessage<Record<string, any>>("AgentServerMessage", ((await readSessionFrame(session)).value as Frame).payload)
    expect(first.exec_server_message?.id).toBe(1)
    expect(second.exec_server_control_message?.abort?.id).toBe(1)
  })

  it("leaves a frame to a pump that started while the reader waited", async () => {
    const { session, send, written } = heldRun()
    sessionManager.registerPending(1, session, "read_result", "read", false)
    readHeldRun(session)
    await settle()

    const owner = Symbol("continuation pump")
    sessionManager.beginPump(session, owner)
    send(kvSet(9))
    const frame = await readSessionFrame(session)
    await settle()
    expect(written).toHaveLength(0)
    expect(decodeMessage<Record<string, any>>("AgentServerMessage", (frame.value as Frame).payload).kv_server_message.id).toBe(9)
    sessionManager.endPump(session, owner)
  })

  it("applies a queued abort once the pump registers its exec, even if the step ended first", async () => {
    // Exec 0 runs; Cursor lists a call, requests exec 1 and aborts it at once.
    const { session, send } = heldRun()
    sessionManager.registerPending(0, session, "shell_result", "bash", false)
    readHeldRun(session)
    send({ interaction_update: { tool_requests_listed: { call_count: 1 } } })
    send({ exec_server_message: { id: 1, shell_args: { command: "sleep 8", tool_call_id: "call-shell-1" } } })
    send({ exec_server_control_message: { abort: { id: 1 } } })
    send({ interaction_update: { text_delta: { text: "after" } } })
    await settle()
    // Exec 1 is not registered yet, so its abort waits behind its request.
    expect(session.heldFrames).toHaveLength(4)

    // The continuation pump takes the list and exec 1, registers it, and ends the step.
    const owner = Symbol("continuation pump")
    sessionManager.beginPump(session, owner)
    await readSessionFrame(session)
    await readSessionFrame(session)
    sessionManager.registerPending(1, session, "shell_result", "bash", false)
    sessionManager.endPump(session, owner)
    // The reader from before the pump is still waiting on the stream; holding the Run again applies the abort.
    readHeldRun(session)

    expect(session.pending.get(1)?.aborted).toBe(true)
    expect(session.pending.get(0)?.aborted).toBeUndefined()
    // The applied abort leaves the queue; the text behind it stays in order for the pump.
    expect(session.heldFrames).toHaveLength(1)
    const next = decodeMessage<Record<string, any>>("AgentServerMessage", ((await readSessionFrame(session)).value as Frame).payload)
    expect(next.interaction_update?.text_delta?.text).toBe("after")
  })

  it("applies a queued abort when the reader next wakes", async () => {
    const { session, send } = heldRun()
    sessionManager.registerPending(0, session, "shell_result", "bash", false)
    session.heldFrames = [{ flags: 0, payload: encodeMessage("AgentServerMessage", { exec_server_control_message: { abort: { id: 2 } } }) }]
    readHeldRun(session)
    // Exec 2 is registered while the reader waits, without a pump calling readHeldRun again.
    sessionManager.registerPending(2, session, "read_result", "read", false)
    send(heartbeat)
    await settle()
    expect(session.pending.get(2)?.aborted).toBe(true)
    expect(session.heldFrames).toEqual([])
  })

  it("does not read a Run that owes nothing, and keeps a pushed-back frame first", async () => {
    const idle = heldRun()
    readHeldRun(idle.session)
    idle.send(kvSet(1))
    await settle()
    expect(idle.written).toHaveLength(0)

    const pushed = heldRun()
    sessionManager.registerPending(2, pushed.session, "read_result", "read", false)
    putBackFrame(pushed.session, {
      done: false,
      value: {
        flags: 0,
        payload: encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } }),
      },
    })
    readHeldRun(pushed.session)
    pushed.send({ interaction_update: { text_delta: { text: "later" } } })
    await settle()
    const first = decodeMessage<Record<string, any>>("AgentServerMessage", ((await readSessionFrame(pushed.session)).value as Frame).payload)
    const second = decodeMessage<Record<string, any>>("AgentServerMessage", ((await readSessionFrame(pushed.session)).value as Frame).payload)
    expect(first.interaction_update?.turn_ended).toBeDefined()
    expect(second.interaction_update?.text_delta?.text).toBe("later")
  })

  it("closes the Run when a KV reply cannot be written", async () => {
    const { session, send } = heldRun(true, { failWrites: true })
    sessionManager.registerPending(0, session, "read_result", "read", false)
    readHeldRun(session)
    send(kvSet(3))
    await settle()
    expect(session.closed).toBe(true)
    expect(session.closeError?.message).toBe("Cursor held KV set_blob reply id=3 write failed")
  })

  it("queues frames it cannot decode and stops at the end of the stream", async () => {
    const { session, send, sendRaw, written } = heldRun()
    sessionManager.registerPending(0, session, "read_result", "read", false)
    readHeldRun(session)
    const corruptGzip = { flags: 0x01, payload: Uint8Array.from([1, 2, 3]) }
    // One top-level KV field whose body is not a KvServerMessage.
    const undecodableKv = { flags: 0, payload: Uint8Array.from([0x22, 0x02, 0x08, 0xff]) }
    const end = { flags: 0x02, payload: new TextEncoder().encode(JSON.stringify({ error: { code: "canceled" } })) }
    sendRaw(corruptGzip)
    sendRaw(undecodableKv)
    sendRaw(end)
    send(kvSet(4))
    await settle()
    expect(session.heldFrames).toEqual([corruptGzip, undecodableKv, end])
    // Nothing past the end of the stream is read.
    expect(written).toHaveLength(0)
  })

  it("stops reading once 1,000 frames wait for the pump", async () => {
    const { session, send, written } = heldRun()
    sessionManager.registerPending(0, session, "read_result", "read", false)
    readHeldRun(session)
    for (let index = 0; index < 1_000; index++) send({ interaction_update: { text_delta: { text: `${index}` } } })
    send(kvSet(6))
    await settle()
    expect(session.heldFrames).toHaveLength(1_000)
    // Beyond the bound, unread frames wait under HTTP/2 flow control as before.
    expect(written).toHaveLength(0)
  })

  it("leaves a failed read to the next pump", async () => {
    const { session, fail } = heldRun()
    sessionManager.registerPending(0, session, "read_result", "read", false)
    readHeldRun(session)
    await settle()
    fail(new Error("stream broke"))
    await settle()
    await expect(readSessionFrame(session)).rejects.toThrow("stream broke")
  })

  it("keeps the Run when an exec heartbeat cannot be written", async () => {
    const { session } = heldRun(true, { failWrites: true })
    session.policy = { ...session.policy, heartbeatMs: 60_000, semanticIdleMs: 120_000 }
    sessionManager.registerPending(0, session, "shell_result", "bash", false)
    attachSessionHeartbeat(session)
    try {
      await new Promise((resolve) => setTimeout(resolve, 3_300))
      // The session heartbeat owns closing a broken stream, as in Cursor CLI.
      expect(session.closed).toBe(false)
    } finally {
      session.heartbeatCancel?.()
    }
  }, 10_000)

  it("does not let an exec Cursor aborted keep its Run from the open-session cap", () => {
    const manager = new SessionManager({ maxOpenSessions: 1 })
    const waiting = heldRun(false).session
    manager.registerSession(waiting)
    manager.registerPending(3, waiting, "read_result", "read", false)
    const aborted = heldRun(false).session
    manager.registerSession(aborted)
    manager.registerPending(4, aborted, "read_result", "read", false)
    expect(manager.markExecAborted(aborted, 4)).toBe(true)

    manager.registerSession(heldRun(false).session)
    // The Run still waiting on the host stays; the one Cursor released is the idle one.
    expect(waiting.closed).toBe(false)
    expect(aborted.closed).toBe(true)
    manager.dispose()
  })
})
