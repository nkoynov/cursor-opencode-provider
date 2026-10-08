import { describe, expect, it } from "bun:test"
import {
  pump,
  pumpWithRecovery,
  resolveRetryPolicy,
  retryDelayMs,
  type CursorRunRecovery,
} from "../src/language-model.js"
import { encodeMessage } from "../src/protocol/messages.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import {
  CursorRetryExhaustedError,
  CursorServerError,
  CursorTransportError,
  isCapacityFailure,
} from "../src/errors.js"
import { MAX_TOOL_INPUT_MS, semanticDeadlineAt } from "../src/cursor-waits.js"
import { sessionFixture } from "./session-fixture.js"

type TimedFrame = { frame: Frame; afterMs?: number }

const IDLE_MS = 60

function fakeSession(id: string, frames: TimedFrame[], init: Partial<CursorSession> = {}): CursorSession {
  let index = 0
  return sessionFixture({
    sessionId: id,
    conversationId: `conv-${id}`,
    stream: {
      write() {},
      end() {},
      frames: () => ({ async *[Symbol.asyncIterator]() {} }),
      destroy() {},
      isClosed: () => false,
      onTerminal: () => () => {},
    },
    frames: {
      next: async () => {
        const next = frames[index++]
        if (!next) return await new Promise<IteratorResult<Frame>>(() => {})
        if (next.afterMs) await new Promise((resolve) => setTimeout(resolve, next.afterMs))
        return { done: false, value: next.frame }
      },
    },
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolDescriptors: [],
    requestContext: {},
    allowTools: true,
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    pumpActive: false,
    heartbeat: null,
    policy: { semanticIdleMs: IDLE_MS, hardCapMs: 600_000, heartbeatMs: 5 },
    ...init,
  })
}

function controller(parts: any[] = []) {
  return {
    enqueue(part: unknown) { parts.push(part) },
    close() {},
    error(error: unknown) { throw error },
  } as unknown as ReadableStreamDefaultController<any>
}

const frame = (message: Record<string, unknown>, flags = 0): Frame => ({
  flags,
  payload: encodeMessage("AgentServerMessage", message),
})
const heartbeat = () => frame({ interaction_update: { heartbeat: {} } })
const turnEnded = () => frame({ interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } })
const text = (delta: string) => frame({ interaction_update: { text_delta: { text: delta } } })
const checkpoint = (bytes: number[]) => frame({ conversation_checkpoint_update: Uint8Array.from(bytes) })
const endStreamError = (code: string): Frame => ({
  flags: 0x02,
  payload: new TextEncoder().encode(JSON.stringify({ error: { code } })),
})
const awaitStarted = (callId: string, blockUntilMs?: number) => frame({
  interaction_update: {
    tool_call_started: {
      call_id: callId,
      tool_call: { await_tool_call: { args: blockUntilMs === undefined ? {} : { block_until_ms: blockUntilMs } } },
    },
  },
})
const awaitCompleted = (callId: string) => frame({
  interaction_update: { tool_call_completed: { call_id: callId, tool_call: { await_tool_call: { args: {} } } } },
})

const ids = { textId: "t", reasoningId: "r" }
const noDelay = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 }

describe("Cursor-side waits and the stall watchdog", () => {
  it("lets a Run stay silent through an AwaitShell sleep", async () => {
    const session = fakeSession("await-sleep", [
      { frame: awaitStarted("w1", 150) },
      { frame: heartbeat(), afterMs: 100 },
      { frame: awaitCompleted("w1"), afterMs: 80 },
      { frame: turnEnded() },
    ])
    const parts: any[] = []
    await pump(session, controller(parts), ids)
    expect(parts.filter((part) => part.type === "finish")).toHaveLength(1)
  })

  it("still times out the same silence without a Cursor-side wait", async () => {
    const session = fakeSession("plain-silence", [
      { frame: heartbeat(), afterMs: 100 },
      { frame: turnEnded() },
    ])
    await expect(pump(session, controller(), ids)).rejects.toMatchObject({ code: "CURSOR_SEMANTIC_IDLE_TIMEOUT" })
  })

  it("times out a wait that outlives block_until_ms plus the idle window", async () => {
    const session = fakeSession("wait-overrun", [
      { frame: awaitStarted("w1", 40) },
      { frame: turnEnded(), afterMs: 40 + IDLE_MS + 80 },
    ])
    await expect(pump(session, controller(), ids)).rejects.toMatchObject({ code: "CURSOR_SEMANTIC_IDLE_TIMEOUT" })
  })

  it("returns to the idle window once the wait completes", async () => {
    const session = fakeSession("wait-done", [
      { frame: awaitStarted("w1", 10_000) },
      { frame: awaitCompleted("w1") },
      { frame: turnEnded(), afterMs: IDLE_MS + 80 },
    ])
    await expect(pump(session, controller(), ids)).rejects.toMatchObject({ code: "CURSOR_SEMANTIC_IDLE_TIMEOUT" })
  })

  it("keeps the idle window for an await without block_until_ms", async () => {
    const session = fakeSession("no-block", [
      { frame: awaitStarted("w1") },
      { frame: turnEnded(), afterMs: IDLE_MS + 80 },
    ])
    await expect(pump(session, controller(), ids)).rejects.toMatchObject({ code: "CURSOR_SEMANTIC_IDLE_TIMEOUT" })
    expect(session.cursorWaits?.size ?? 0).toBe(0)
    expect(semanticDeadlineAt(session)).toBe(session.semanticDeadlineAt)
  })
})

const partialToolCall = () => frame({
  interaction_update: {
    partial_tool_call: { call_id: "toolu_w", tool_call: { edit_tool_call: { args: { path: "/tmp/catalog.md" } } } },
  },
})
const toolStarted = () => frame({
  interaction_update: {
    tool_call_started: { call_id: "toolu_w", tool_call: { edit_tool_call: { args: { path: "/tmp/catalog.md" } } } },
  },
})
const thinking = (delta: string) => frame({ interaction_update: { thinking_delta: { text: delta } } })

describe("a tool input Cursor holds until the model has written it", () => {
  it("keeps the Run through heartbeats past the idle window", async () => {
    const session = fakeSession("input-written", [
      { frame: partialToolCall() },
      { frame: heartbeat(), afterMs: 40 },
      { frame: heartbeat(), afterMs: 40 },
      { frame: heartbeat(), afterMs: 40 },
      { frame: toolStarted(), afterMs: 40 },
      { frame: turnEnded() },
    ])
    const parts: any[] = []
    await pump(session, controller(parts), ids)
    expect(parts.filter((part) => part.type === "finish")).toHaveLength(1)
    expect(session.toolInputSince).toBeUndefined()
  })

  it("still times out a silent stream while the input is written", async () => {
    const session = fakeSession("input-silent", [
      { frame: partialToolCall() },
      { frame: heartbeat(), afterMs: 40 },
      { frame: toolStarted(), afterMs: IDLE_MS + 80 },
    ])
    await expect(pump(session, controller(), ids)).rejects.toMatchObject({ code: "CURSOR_SEMANTIC_IDLE_TIMEOUT" })
  })

  it("returns to the idle window once the call has started", async () => {
    const session = fakeSession("input-arrived", [
      { frame: partialToolCall() },
      { frame: toolStarted() },
      { frame: heartbeat(), afterMs: 40 },
      { frame: heartbeat(), afterMs: 40 },
      { frame: turnEnded(), afterMs: 40 },
    ])
    await expect(pump(session, controller(), ids)).rejects.toMatchObject({ code: "CURSOR_SEMANTIC_IDLE_TIMEOUT" })
  })

  it("returns to the idle window when the model thinks again", async () => {
    const session = fakeSession("input-then-thinking", [
      { frame: partialToolCall() },
      { frame: thinking("more") },
      { frame: heartbeat(), afterMs: 40 },
      { frame: heartbeat(), afterMs: 40 },
      { frame: turnEnded(), afterMs: 40 },
    ])
    await expect(pump(session, controller(), ids)).rejects.toMatchObject({ code: "CURSOR_SEMANTIC_IDLE_TIMEOUT" })
  })

  it("gives the input at most MAX_TOOL_INPUT_MS from the announcement", () => {
    const now = Date.now()
    const session = fakeSession("input-cap", [], {
      semanticDeadlineAt: now - 1,
      toolInputSince: now - MAX_TOOL_INPUT_MS + 10,
      lastFrameAt: now,
    })
    expect(semanticDeadlineAt(session)).toBe(now + 10)
    session.toolInputSince = now - 1_000
    expect(semanticDeadlineAt(session)).toBe(now + IDLE_MS)
  })
})

describe("resuming again from the checkpoint a Run resumed from", () => {
  const carried = Uint8Array.from([0x0a, 0x01, 0x07])

  it("resumes it after visible output instead of giving up", async () => {
    const recoveries: CursorRunRecovery[] = []
    const parts: any[] = []
    const final = await pumpWithRecovery({
      initialSession: fakeSession("resumed", [
        { frame: text("partial") },
        { frame: endStreamError("internal") },
      ], { carriedCheckpoint: carried }),
      controller: controller(parts),
      retryPolicy: noDelay,
      recover: async (recovery) => {
        recoveries.push(recovery)
        return fakeSession("resumed-again", [{ frame: text(" rest") }, { frame: turnEnded() }])
      },
    })
    expect(final.sessionId).toBe("resumed-again")
    expect(recoveries).toHaveLength(1)
    expect(recoveries[0]).toMatchObject({ kind: "resume", conversationId: "conv-resumed" })
    expect(Buffer.from((recoveries[0] as { checkpoint: Uint8Array }).checkpoint)).toEqual(Buffer.from(carried))
  })

  it("prefers a checkpoint the resumed Run received", async () => {
    const recoveries: CursorRunRecovery[] = []
    const session = fakeSession("resumed-newer", [
      { frame: text("partial") },
      { frame: checkpoint([0x0a, 0x01, 0x09]) },
      { frame: endStreamError("internal") },
    ], { carriedCheckpoint: carried })
    await pumpWithRecovery({
      initialSession: session,
      controller: controller(),
      retryPolicy: noDelay,
      recover: async (recovery) => {
        recoveries.push(recovery)
        return fakeSession("after-newer", [{ frame: turnEnded() }])
      },
    })
    expect(session.carriedCheckpoint).toBeUndefined()
    expect(Array.from((recoveries[0] as { checkpoint: Uint8Array }).checkpoint)).toEqual([0x0a, 0x01, 0x09])
  })

  it("rebases a replay-safe failure as before", async () => {
    const recoveries: CursorRunRecovery[] = []
    await pumpWithRecovery({
      initialSession: fakeSession("resumed-safe", [{ frame: endStreamError("internal") }], { carriedCheckpoint: carried }),
      controller: controller(),
      retryPolicy: noDelay,
      recover: async (recovery) => {
        recoveries.push(recovery)
        return fakeSession("rebased", [{ frame: turnEnded() }])
      },
    })
    expect(recoveries).toEqual([{ kind: "rebase" }])
  })

  it("drops it once the Run asks the host for anything", () => {
    const session = fakeSession("asked-host", [], { carriedCheckpoint: carried })
    sessionManager.registerPending(1, session, "shell_result", "bash")
    expect(session.carriedCheckpoint).toBeUndefined()
    sessionManager.close(session)
  })

  it("drops it once the Run answers an interaction query", async () => {
    const session = fakeSession("queried", [
      { frame: frame({ interaction_query: { id: 4, web_search_request_query: new Uint8Array() } }) },
      { frame: text("partial") },
      { frame: endStreamError("internal") },
    ], { carriedCheckpoint: carried })
    await expect(pumpWithRecovery({
      initialSession: session,
      controller: controller(),
      retryPolicy: noDelay,
      recover: async () => fakeSession("unused", [{ frame: turnEnded() }]),
    })).rejects.toThrow("automatic retry unsafe")
    expect(session.carriedCheckpoint).toBeUndefined()
  })

  it("drops it when the turn ends", async () => {
    const session = fakeSession("turn-done", [{ frame: turnEnded() }], { carriedCheckpoint: carried })
    await pump(session, controller(), ids)
    expect(session.carriedCheckpoint).toBeUndefined()
  })

  it("gives up after visible output when nothing was carried", async () => {
    await expect(pumpWithRecovery({
      initialSession: fakeSession("fresh", [{ frame: text("partial") }, { frame: endStreamError("internal") }]),
      controller: controller(),
      retryPolicy: noDelay,
      recover: async () => fakeSession("unused", [{ frame: turnEnded() }]),
    })).rejects.toThrow("automatic retry unsafe")
  })
})

describe("capacity failures", () => {
  const capacity = (code: string) => new CursorServerError("busy", { transient: true, replaySafe: true, code })

  it("recognizes Cursor's capacity codes", () => {
    expect(isCapacityFailure(capacity("resource_exhausted"))).toBe(true)
    expect(isCapacityFailure(capacity("unavailable"))).toBe(true)
    expect(isCapacityFailure(new CursorServerError("x", { transient: true, replaySafe: true, grpcStatus: 8 }))).toBe(true)
    expect(isCapacityFailure(new CursorServerError("x", { transient: true, replaySafe: true, statusCode: 429 }))).toBe(true)
    expect(isCapacityFailure(new CursorServerError("x", { transient: true, replaySafe: true, statusCode: 503 }))).toBe(true)
    expect(isCapacityFailure(capacity("internal"))).toBe(false)
    expect(isCapacityFailure(capacity("canceled"))).toBe(false)
    expect(isCapacityFailure(new CursorTransportError("reset", { transient: true, replaySafe: true, code: "ECONNRESET" }))).toBe(false)
  })

  it("spaces capacity retries over about a minute with jitter, and keeps other retries fast", () => {
    const policy = resolveRetryPolicy(undefined)
    const bounds = [[1_000, 2_000], [2_000, 4_000], [4_000, 8_000], [8_000, 16_000], [15_000, 30_000], [15_000, 30_000]]
    for (let i = 0; i < 200; i++) {
      let total = 0
      bounds.forEach(([low, high], index) => {
        const delay = retryDelayMs(capacity("resource_exhausted"), index + 1, policy)
        expect(delay).toBeGreaterThanOrEqual(low!)
        expect(delay).toBeLessThanOrEqual(high!)
        if (index < 5) total += delay
      })
      expect(total).toBeGreaterThanOrEqual(30_000)
      expect(total).toBeLessThanOrEqual(60_000)
      expect(retryDelayMs(capacity("internal"), 1, policy)).toBeLessThan(500)
      expect(retryDelayMs(capacity("internal"), 2, policy)).toBeLessThan(1_000)
    }
    const told = new CursorServerError("busy", {
      transient: true, replaySafe: true, code: "resource_exhausted", retryAfterMs: 1_234,
    })
    expect(retryDelayMs(told, 1, policy)).toBe(1_234)
  })

  it("gives capacity refusals six attempts unless maxAttempts is set", () => {
    expect(resolveRetryPolicy(undefined)).toMatchObject({ maxAttempts: 3, capacityMaxAttempts: 6 })
    expect(resolveRetryPolicy({ maxAttempts: 2 })).toMatchObject({ maxAttempts: 2, capacityMaxAttempts: 2 })
  })

  it("retries a refused Run until capacity returns", async () => {
    let refusals = 2
    const recoveries: CursorRunRecovery[] = []
    const final = await pumpWithRecovery({
      initialSession: fakeSession("refused", [{ frame: endStreamError("resource_exhausted") }]),
      controller: controller(),
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, capacityMaxAttempts: 6 },
      recover: async (recovery) => {
        recoveries.push(recovery)
        return refusals-- > 0
          ? fakeSession(`refused-${refusals}`, [{ frame: endStreamError("resource_exhausted") }])
          : fakeSession("served", [{ frame: turnEnded() }])
      },
    })
    expect(final.sessionId).toBe("served")
    expect(recoveries).toHaveLength(3)
  })

  it("says the final refusal is Cursor's capacity, without OpenCode retry trigger words", async () => {
    let recoveries = 0
    const failure = await pumpWithRecovery({
      initialSession: fakeSession("full", [{ frame: endStreamError("resource_exhausted") }]),
      controller: controller(),
      retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, capacityMaxAttempts: 6 },
      recover: async () => {
        recoveries++
        return fakeSession(`full-${recoveries}`, [{ frame: endStreamError("resource_exhausted") }])
      },
    }).catch((error: unknown) => error)
    expect(recoveries).toBe(5)
    expect(failure).toBeInstanceOf(CursorRetryExhaustedError)
    expect(failure).toMatchObject({ code: "resource_exhausted", transient: false })
    const message = (failure as Error).message
    expect(message).toContain("Cursor has no capacity for this model")
    expect(message).toContain("not on your key")
    expect(message).toContain("refused 6 times")
    expect(message).not.toMatch(/unavailable|exhausted|at capacity|try again|overloaded/i)
  })

  it("keeps the normal attempt budget for other failures", async () => {
    let recoveries = 0
    const failure = await pumpWithRecovery({
      initialSession: fakeSession("blip", [{ frame: endStreamError("internal") }]),
      controller: controller(),
      retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, capacityMaxAttempts: 6 },
      recover: async () => {
        recoveries++
        return fakeSession(`blip-${recoveries}`, [{ frame: endStreamError("internal") }])
      },
    }).catch((error: unknown) => error)
    expect(recoveries).toBe(2)
    expect((failure as Error).message).toStartWith("Cursor Run failed after 3 attempts")
  })

})
