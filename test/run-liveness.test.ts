import { afterEach, describe, expect, it } from "bun:test"
import { attachSessionHeartbeat, drainSessionUntilTurnEnded, pump, pumpWithRecovery } from "../src/language-model.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { ASK_QUESTION_RESULT_FIELD } from "../src/protocol/ask-question.js"
import { resolveContinuationPolicy, sessionManager, type CursorSession, type Frame } from "../src/session.js"
import type { CursorProviderError } from "../src/errors.js"
import { writeStreamMessage } from "../src/stream-write.js"
import { sessionFixture } from "./session-fixture.js"

type TimedFrame = { afterMs: number; frame: Frame }

function serverFrame(message: Record<string, unknown>): Frame {
  return { flags: 0, payload: encodeMessage("AgentServerMessage", message) }
}

const heartbeat = () => serverFrame({ interaction_update: { heartbeat: {} } })

/** InteractionUpdate #8 `token_delta{tokens: 5}`; this client keeps it undeclared. */
const tokenDelta = (): Frame => ({ flags: 0, payload: Uint8Array.from([0x0a, 0x04, 0x42, 0x02, 0x08, 0x05]) })

const turnEnded = () => serverFrame({
  interaction_update: { turn_ended: { input_tokens: 4, output_tokens: 2 } },
})

function livenessSession(frames: TimedFrame[], semanticIdleMs: number, written: Uint8Array[] = []): CursorSession {
  let index = 0
  return sessionFixture({
    sessionId: `liveness-${Math.random().toString(16).slice(2)}`,
    conversationId: `conv-liveness-${Math.random().toString(16).slice(2)}`,
    stream: {
      write(frame: Uint8Array) { written.push(frame); return true },
      end() {},
      frames: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }) }) }),
      destroy() {},
      isClosed: () => false,
    } as never,
    frames: {
      next: async () => {
        const next = frames[index++]
        if (!next) return new Promise<never>(() => {})
        await Bun.sleep(next.afterMs)
        return { done: false as const, value: next.frame }
      },
    } as never,
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
    billing: { key: "run:liveness", prefixTokens: 0 },
    policy: { heartbeatMs: 5, semanticIdleMs, hardCapMs: 10_000 },
    createdAt: Date.now(),
    lastInboundAt: Date.now(),
    lastHeartbeatWriteAt: Date.now(),
    semanticDeadlineAt: Date.now() + semanticIdleMs,
    closed: false,
  })
}

function collect(parts: Array<{ type: string; delta?: string }>) {
  return {
    enqueue(part: { type: string; delta?: string }) { parts.push(part) },
    close() {},
    error(error: unknown) { throw error },
  } as unknown as ReadableStreamDefaultController<any>
}

const live: CursorSession[] = []

afterEach(() => {
  for (const session of live.splice(0)) {
    session.heartbeatCancel?.()
    if (!session.closed) sessionManager.close(session, "ordinary-cleanup")
  }
})

describe("Run liveness", () => {
  it("uses Cursor CLI's 30 second silence default while retaining explicit overrides", () => {
    expect(resolveContinuationPolicy(undefined).semanticIdleMs).toBe(30_000)
    expect(resolveContinuationPolicy({ semanticIdleMs: 180_000 }).semanticIdleMs).toBe(180_000)
    expect(resolveContinuationPolicy({ softHealthMs: 180_000 }).semanticIdleMs).toBe(180_000)
  })

  it("leaves a real silence deadline after reasoning and an unfinished row to the host", async () => {
    const parts: Array<{ type: string; providerExecuted?: boolean }> = []
    const session = livenessSession([
      { afterMs: 0, frame: serverFrame({ interaction_update: { thinking_delta: { text: "Preparing the edit" } } }) },
      { afterMs: 0, frame: serverFrame({ interaction_update: { partial_tool_call: { call_id: "unfinished",
        tool_call: { edit_tool_call: { args: { path: "unfinished.txt" } } } } } }) },
    ], 40)
    session.permittedToolNames = new Set(["write"])
    session.requestContext.env = { workspace_paths: [process.cwd()] }
    live.push(session)
    let sawRow = false
    const output = collect(parts)
    const enqueue = output.enqueue.bind(output)
    output.enqueue = part => {
      enqueue(part)
      if (part.type !== "tool-input-start") return
      sawRow = true
      const deadline = session.semanticDeadlineAt
      // Client traffic is not an inbound server frame and must not delay the cutoff.
      sessionManager.recordHeartbeatWrite(session)
      expect(session.semanticDeadlineAt).toBe(deadline)
    }
    const failure = await pumpWithRecovery({
      initialSession: session, controller: output,
      recover: async () => { throw new Error("The host owns this output-only retry") },
    }).catch((error: unknown) => error)
    expect(sawRow).toBe(true)
    expect(failure).toMatchObject({ hostRetryable: true, code: "CURSOR_SEMANTIC_IDLE_TIMEOUT" })
    expect(parts.filter(part => part.type === "tool-call").every(part => part.providerExecuted)).toBe(true)
    expect(session.pending.size).toBe(0)
  })

  it("keeps a Run alive on heartbeats alone for longer than the idle limit", async () => {
    const parts: Array<{ type: string; delta?: string }> = []
    const session = livenessSession([
      ...Array.from({ length: 6 }, () => ({ afterMs: 25, frame: heartbeat() })),
      { afterMs: 0, frame: serverFrame({ interaction_update: { text_delta: { text: "answer" } } }) },
      { afterMs: 0, frame: turnEnded() },
    ], 60)
    live.push(session)

    await pump(session, collect(parts), { textId: "t", reasoningId: "r" })

    expect(parts.some((part) => part.type === "text-delta" && part.delta === "answer")).toBe(true)
    expect(parts.at(-1)?.type).toBe("finish")
  })

  it("keeps a Run alive while the model composes a tool input", async () => {
    const composing: TimedFrame[] = [
      { afterMs: 25, frame: serverFrame({ interaction_update: { partial_tool_call: { call_id: "c1", args_text_delta: "{\"path\":" } } }) },
      { afterMs: 25, frame: tokenDelta() },
      { afterMs: 25, frame: serverFrame({ interaction_update: { tool_call_delta: { call_id: "c1", tool_call_delta: Uint8Array.of(1) } } }) },
      { afterMs: 25, frame: tokenDelta() },
      { afterMs: 25, frame: heartbeat() },
    ]
    const parts: Array<{ type: string; delta?: string }> = []
    const session = livenessSession([
      ...composing,
      { afterMs: 0, frame: serverFrame({ interaction_update: { text_delta: { text: "written" } } }) },
      { afterMs: 0, frame: turnEnded() },
    ], 60)
    live.push(session)

    await pump(session, collect(parts), { textId: "t", reasoningId: "r" })

    expect(parts.some((part) => part.type === "text-delta" && part.delta === "written")).toBe(true)
  })

  it("fails a Run that sends no frame within the idle limit, replay-safe before any output", async () => {
    const session = livenessSession([{ afterMs: 10, frame: heartbeat() }], 40)
    live.push(session)

    const error = await pump(session, collect([]), { textId: "t", reasoningId: "r" })
      .then(() => undefined, (cause: unknown) => cause as CursorProviderError)

    expect(error?.code).toBe("CURSOR_SEMANTIC_IDLE_TIMEOUT")
    expect(error?.message).toContain("Cursor Run sent no frames for 40ms")
    expect(error?.replaySafe).toBe(true)
  })

  const blobRequest = () => serverFrame({ kv_server_message: { id: 4, get_blob_args: { blob_id: Uint8Array.of(0xb1, 0x0b) } } })

  /** Cursor asks for a blob whose reply takes `drainAfterMs` to upload. */
  function slowBlobReplySession(frames: TimedFrame[], semanticIdleMs: number, drainAfterMs: number): CursorSession {
    const session = livenessSession([{ afterMs: 0, frame: blobRequest() }, ...frames], semanticIdleMs)
    session.blobs.set("b10b", new Uint8Array(64).fill(7))
    const stream = session.stream as unknown as Record<string, unknown>
    stream.write = () => false
    stream.waitForDrain = () => Bun.sleep(drainAfterMs)
    return session
  }

  it("starts the idle limit over when a reply to Cursor finishes uploading", async () => {
    const parts: Array<{ type: string; delta?: string }> = []
    const session = slowBlobReplySession([
      { afterMs: 30, frame: serverFrame({ interaction_update: { text_delta: { text: "answer" } } }) },
      { afterMs: 0, frame: turnEnded() },
    ], 60, 120)
    live.push(session)

    await pump(session, collect(parts), { textId: "t", reasoningId: "r" })

    expect(parts.some((part) => part.type === "text-delta" && part.delta === "answer")).toBe(true)
  })

  it("does not hold the idle limit for a heartbeat that cannot drain", async () => {
    const session = livenessSession([], 40)
    live.push(session)
    const stream = session.stream as unknown as Record<string, unknown>
    stream.write = () => false
    stream.waitForDrain = () => Bun.sleep(400)
    const heartbeatWrite = writeStreamMessage(session.stream, new Uint8Array(4), "heartbeat")
    const startedAt = Date.now()

    const error = await pump(session, collect([]), { textId: "t", reasoningId: "r" })
      .then(() => undefined, (cause: unknown) => cause as CursorProviderError)

    expect(error?.code).toBe("CURSOR_SEMANTIC_IDLE_TIMEOUT")
    expect(Date.now() - startedAt).toBeLessThan(300)
    await heartbeatWrite.catch(() => undefined)
  })

  it("fails a Run that stays silent for the idle limit after its reply finished uploading", async () => {
    const session = slowBlobReplySession([], 40, 80)
    live.push(session)
    const startedAt = Date.now()

    const error = await pump(session, collect([]), { textId: "t", reasoningId: "r" })
      .then(() => undefined, (cause: unknown) => cause as CursorProviderError)

    expect(error?.code).toBe("CURSOR_SEMANTIC_IDLE_TIMEOUT")
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(115)
  })

  it("renews the idle deadline from frames the fresh-turn drain reads", async () => {
    const session = livenessSession([
      { afterMs: 0, frame: heartbeat() },
      { afterMs: 0, frame: turnEnded() },
    ], 60_000)
    session.semanticDeadlineAt = Date.now() - 1
    live.push(session)

    const before = Date.now()
    expect(await drainSessionUntilTurnEnded(session, { timeoutMs: 1_000 })).toBe("turn-ended")
    expect(session.semanticDeadlineAt).toBeGreaterThanOrEqual(before + 60_000)
  })
})

function execHeartbeatIds(written: Uint8Array[]): number[] {
  return written.flatMap((frame) => {
    const control = decodeMessage("AgentClientMessage", frame).exec_client_control_message as
      | { heartbeat?: { id?: number } }
      | undefined
    return control?.heartbeat ? [control.heartbeat.id ?? 0] : []
  })
}

describe("exec heartbeats", () => {
  it("heartbeats each exec the host still runs every 3 s, and nothing else", async () => {
    const written: Uint8Array[] = []
    const session = livenessSession([], 60_000, written)
    session.policy = { heartbeatMs: 1_000, semanticIdleMs: 60_000, hardCapMs: 120_000 }
    live.push(session)
    sessionManager.registerPending(7, session, "shell_result", "bash")
    sessionManager.registerPending(8, session, "read_result", "read")
    sessionManager.registerPending(900_001, session, "", "todowrite", true)
    sessionManager.registerPending(900_002, session, ASK_QUESTION_RESULT_FIELD, "question")
    sessionManager.markExecAborted(session, 8)
    attachSessionHeartbeat(session)

    await Bun.sleep(3_300)
    expect(execHeartbeatIds(written)).toEqual([7])

    session.pending.delete(7)
    await Bun.sleep(3_100)
    expect(execHeartbeatIds(written)).toEqual([7])
  }, 15_000)

  it("stops when the heartbeat is cancelled or the session closes", async () => {
    const written: Uint8Array[] = []
    const session = livenessSession([], 60_000, written)
    session.policy = { heartbeatMs: 1_000, semanticIdleMs: 60_000, hardCapMs: 120_000 }
    live.push(session)
    sessionManager.registerPending(3, session, "shell_result", "bash")
    attachSessionHeartbeat(session)
    session.heartbeatCancel?.()

    await Bun.sleep(3_300)
    expect(execHeartbeatIds(written)).toEqual([])

    attachSessionHeartbeat(session)
    sessionManager.close(session, "ordinary-cleanup")
    await Bun.sleep(3_300)
    expect(execHeartbeatIds(written)).toEqual([])
  }, 15_000)
})
