import { describe, expect, it } from "bun:test"
import { APICallError } from "@ai-sdk/provider"
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
  CursorLateFailureError,
  CursorRetryExhaustedError,
  CursorServerError,
  CursorTransportError,
  hostFacingError,
  isCapacityFailure,
} from "../src/errors.js"
import { newRetryBudget } from "../src/retry-budget.js"
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
  it("keeps a Run through an AwaitShell sleep on Cursor's heartbeats", async () => {
    const session = fakeSession("await-sleep", [
      { frame: awaitStarted("w1", 150) },
      { frame: heartbeat(), afterMs: 40 },
      { frame: heartbeat(), afterMs: 40 },
      { frame: heartbeat(), afterMs: 40 },
      { frame: awaitCompleted("w1"), afterMs: 40 },
      { frame: turnEnded() },
    ])
    const parts: any[] = []
    await pump(session, controller(parts), ids)
    expect(parts.filter((part) => part.type === "finish")).toHaveLength(1)
  })

  it("still times out silence without a Cursor-side wait", async () => {
    const session = fakeSession("plain-silence", [
      { frame: heartbeat(), afterMs: 100 },
      { frame: turnEnded() },
    ])
    await expect(pump(session, controller(), ids)).rejects.toMatchObject({ code: "CURSOR_SEMANTIC_IDLE_TIMEOUT" })
  })

  it("times out a fully silent stream during an AwaitShell sleep after the idle window", async () => {
    const session = fakeSession("wait-silent", [
      { frame: awaitStarted("w1", 10_000) },
      { frame: turnEnded(), afterMs: IDLE_MS + 80 },
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
  })
})

const partialToolCall = (callId = "toolu_w") => frame({
  interaction_update: {
    partial_tool_call: { call_id: callId, tool_call: { edit_tool_call: { args: { path: "/tmp/catalog.md" } } } },
  },
})
const toolStarted = (callId = "toolu_w") => frame({
  interaction_update: {
    tool_call_started: { call_id: callId, tool_call: { edit_tool_call: { args: { path: "/tmp/catalog.md" } } } },
  },
})
const thinking = (delta: string) => frame({ interaction_update: { thinking_delta: { text: delta } } })
// `InteractionUpdate.token_delta` #8 { count #1 = 5 }, a member the provider does not decode.
const tokenDelta = (): Frame => ({ flags: 0, payload: Uint8Array.from([0x0a, 0x04, 0x42, 0x02, 0x08, 0x05]) })

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
  })

  it("keeps holding for a parallel call announced before the previous call's exec", async () => {
    const session = fakeSession("input-parallel", [
      { frame: partialToolCall() },
      { frame: toolStarted() },
      { frame: partialToolCall("toolu_w2") },
      { frame: heartbeat(), afterMs: 40 },
      { frame: heartbeat(), afterMs: 40 },
      { frame: heartbeat(), afterMs: 40 },
      { frame: toolStarted("toolu_w2"), afterMs: 40 },
      { frame: turnEnded() },
    ])
    await pump(session, controller(), ids)
  })

  it("keeps holding across thinking Cursor delivers before the call starts", async () => {
    const session = fakeSession("input-thinking", [
      { frame: partialToolCall() },
      { frame: thinking("more") },
      { frame: heartbeat(), afterMs: 40 },
      { frame: heartbeat(), afterMs: 40 },
      { frame: toolStarted(), afterMs: 40 },
      { frame: turnEnded() },
    ])
    await pump(session, controller(), ids)
  })

  it("still times out a silent stream while the input is written", async () => {
    const session = fakeSession("input-silent", [
      { frame: partialToolCall() },
      { frame: heartbeat(), afterMs: 40 },
      { frame: toolStarted(), afterMs: IDLE_MS + 80 },
    ])
    await expect(pump(session, controller(), ids)).rejects.toMatchObject({ code: "CURSOR_SEMANTIC_IDLE_TIMEOUT" })
  })

  it("keeps a Run that sends only heartbeats after its text until the call arrives", async () => {
    const session = fakeSession("input-unannounced", [
      { frame: text("I'll write the file.") },
      { frame: heartbeat(), afterMs: 40 },
      { frame: heartbeat(), afterMs: 40 },
      { frame: heartbeat(), afterMs: 40 },
      { frame: partialToolCall(), afterMs: 40 },
      { frame: toolStarted() },
      { frame: turnEnded() },
    ])
    const parts: any[] = []
    await pump(session, controller(parts), ids)
    expect(parts.filter((part) => part.type === "finish")).toHaveLength(1)
  })

  it("keeps a Run that streams only token counts while the input is written", async () => {
    const session = fakeSession("input-token-counts", [
      { frame: thinking("patch it") },
      { frame: tokenDelta(), afterMs: 40 },
      { frame: tokenDelta(), afterMs: 40 },
      { frame: tokenDelta(), afterMs: 40 },
      { frame: partialToolCall(), afterMs: 40 },
      { frame: toolStarted() },
      { frame: turnEnded() },
    ])
    const parts: any[] = []
    await pump(session, controller(parts), ids)
    expect(parts.filter((part) => part.type === "finish")).toHaveLength(1)
  })

  it("keeps the Run through heartbeats after a step ends, while the next call is written", async () => {
    const session = fakeSession("input-next-step", [
      { frame: frame({ interaction_update: { step_completed: { step_id: 1, step_duration_ms: 10 } } }) },
      { frame: heartbeat(), afterMs: 40 },
      { frame: heartbeat(), afterMs: 40 },
      { frame: heartbeat(), afterMs: 40 },
      { frame: toolStarted(), afterMs: 40 },
      { frame: turnEnded() },
    ])
    await pump(session, controller(), ids)
  })

  it("still times out a silent stream after the model's text", async () => {
    const session = fakeSession("text-then-silent", [
      { frame: text("I'll write the file.") },
      { frame: heartbeat(), afterMs: 40 },
      { frame: toolStarted(), afterMs: IDLE_MS + 80 },
    ])
    await expect(pump(session, controller(), ids)).rejects.toMatchObject({
      code: "CURSOR_SEMANTIC_IDLE_TIMEOUT",
      replaySafe: false,
    })
  })

  it("holds a Run with no output on heartbeats and keeps its silent stall retry-safe", async () => {
    const session = fakeSession("heartbeats-then-silent", [
      { frame: heartbeat(), afterMs: 40 },
      { frame: heartbeat(), afterMs: 40 },
      { frame: heartbeat(), afterMs: 40 },
      { frame: toolStarted(), afterMs: IDLE_MS + 80 },
    ])
    const started = Date.now()
    await expect(pump(session, controller(), ids)).rejects.toMatchObject({
      code: "CURSOR_SEMANTIC_IDLE_TIMEOUT",
      replaySafe: true,
    })
    expect(Date.now() - started).toBeGreaterThanOrEqual(120 + IDLE_MS - 5)
  })

  it("starts the idle window afresh when the step ends a long hold without the call", async () => {
    const session = fakeSession("input-long-then-step-done", [
      { frame: partialToolCall() },
      { frame: heartbeat(), afterMs: 40 },
      { frame: heartbeat(), afterMs: 40 },
      { frame: frame({ interaction_update: { step_completed: { step_id: 1, step_duration_ms: 10 } } }), afterMs: 10 },
      { frame: turnEnded(), afterMs: 20 },
    ])
    const parts: any[] = []
    await pump(session, controller(parts), ids)
    expect(parts.filter((part) => part.type === "finish")).toHaveLength(1)
  })
})

describe("resuming again from the turn's checkpoint", () => {
  const first = [0x0a, 0x01, 0x07]
  const checkpointed = (id: string) => fakeSession(id, [
    { frame: text("partial") },
    { frame: checkpoint(first) },
    { frame: endStreamError("internal") },
  ])
  const resumed = (recovery: CursorRunRecovery | undefined) =>
    Array.from((recovery as { checkpoint: Uint8Array }).checkpoint)

  it("resumes it after visible output when the resumed Run fails before a newer one", async () => {
    const recoveries: CursorRunRecovery[] = []
    const final = await pumpWithRecovery({
      initialSession: checkpointed("first"),
      controller: controller(),
      retryPolicy: noDelay,
      recover: async (recovery) => {
        recoveries.push(recovery)
        return recoveries.length === 1
          ? fakeSession("resumed", [{ frame: text(" more") }, { frame: endStreamError("internal") }])
          : fakeSession("resumed-again", [{ frame: text(" rest") }, { frame: turnEnded() }])
      },
    })
    expect(final.sessionId).toBe("resumed-again")
    expect(recoveries.map((recovery) => recovery.kind)).toEqual(["resume", "resume"])
    expect(resumed(recoveries[1])).toEqual(first)
  })

  it("prefers a checkpoint the resumed Run received", async () => {
    const recoveries: CursorRunRecovery[] = []
    await pumpWithRecovery({
      initialSession: checkpointed("first-newer"),
      controller: controller(),
      retryPolicy: noDelay,
      recover: async (recovery) => {
        recoveries.push(recovery)
        return recoveries.length === 1
          ? fakeSession("resumed-newer", [
            { frame: text(" more") },
            { frame: checkpoint([0x0a, 0x01, 0x09]) },
            { frame: endStreamError("internal") },
          ])
          : fakeSession("after-newer", [{ frame: turnEnded() }])
      },
    })
    expect(resumed(recoveries[1])).toEqual([0x0a, 0x01, 0x09])
  })

  it("marks an earlier checkpoint stale once the Run asks the host for anything", () => {
    const session = fakeSession("asked-host", [])
    sessionManager.registerPending(1, session, "shell_result", "bash")
    expect(session.earlierCheckpointStale).toBe(true)
    sessionManager.close(session)
  })

  it("does not resume the Run's own checkpoint from before an interaction query", async () => {
    const recoveries: CursorRunRecovery[] = []
    await expect(pumpWithRecovery({
      initialSession: fakeSession("own-then-queried", [
        { frame: text("partial") },
        { frame: checkpoint(first) },
        { frame: frame({ interaction_query: { id: 4, web_search_request_query: new Uint8Array() } }) },
        { frame: endStreamError("internal") },
      ]),
      controller: controller(),
      retryPolicy: noDelay,
      recover: async (recovery) => {
        recoveries.push(recovery)
        return fakeSession("unused", [{ frame: turnEnded() }])
      },
    })).rejects.toMatchObject({ hostRetryable: true })
    expect(recoveries).toHaveLength(0)
  })

  it("does not resume the Run's own checkpoint from before a state-changing host exec", async () => {
    const recoveries: CursorRunRecovery[] = []
    await pumpWithRecovery({
      initialSession: fakeSession("own-then-exec", [{ frame: endStreamError("internal") }], {
        resumeCheckpoint: Uint8Array.from(first),
        sideEffectAfterCheckpoint: true,
      }),
      controller: controller(),
      retryPolicy: noDelay,
      recover: async (recovery) => {
        recoveries.push(recovery)
        return fakeSession("after-exec", [{ frame: turnEnded() }])
      },
    }).catch(() => undefined)
    expect(recoveries.every((recovery) => recovery.kind !== "resume")).toBe(true)
  })

  it("resumes a checkpoint the Run received after its interaction query", async () => {
    const recoveries: CursorRunRecovery[] = []
    await pumpWithRecovery({
      initialSession: fakeSession("queried-then-own", [
        { frame: frame({ interaction_query: { id: 4, web_search_request_query: new Uint8Array() } }) },
        { frame: text("partial") },
        { frame: checkpoint(first) },
        { frame: endStreamError("internal") },
      ]),
      controller: controller(),
      retryPolicy: noDelay,
      recover: async (recovery) => {
        recoveries.push(recovery)
        return fakeSession("after-query", [{ frame: turnEnded() }])
      },
    })
    expect(resumed(recoveries[0])).toEqual(first)
  })

  it("does not resume it once the resumed Run answers an interaction query", async () => {
    const recoveries: CursorRunRecovery[] = []
    await expect(pumpWithRecovery({
      initialSession: checkpointed("first-queried"),
      controller: controller(),
      retryPolicy: noDelay,
      recover: async (recovery) => {
        recoveries.push(recovery)
        return fakeSession("queried", [
          { frame: frame({ interaction_query: { id: 4, web_search_request_query: new Uint8Array() } }) },
          { frame: text("partial") },
          { frame: endStreamError("internal") },
        ])
      },
    })).rejects.toMatchObject({ hostRetryable: true })
    expect(recoveries).toHaveLength(1)
  })

  it("leaves a drop after visible output to the host when the turn has no checkpoint", async () => {
    await expect(pumpWithRecovery({
      initialSession: fakeSession("fresh", [{ frame: text("partial") }, { frame: endStreamError("internal") }]),
      controller: controller(),
      retryPolicy: noDelay,
      recover: async () => fakeSession("unused", [{ frame: turnEnded() }]),
    })).rejects.toMatchObject({ hostRetryable: true })
  })
})

describe("the turn's stall window", () => {
  const stallPolicy = { baseDelayMs: 0, maxDelayMs: 0 }
  const windowOpenedLongAgo = () => ({ ...newRetryBudget(), transport: 1, retries: 1, stallStartedAt: Date.now() - 200_000 })

  it("retries a stall when the Run saved a checkpoint since the turn's last stall", async () => {
    const budget = windowOpenedLongAgo()
    const recoveries: CursorRunRecovery[] = []
    const final = await pumpWithRecovery({
      initialSession: fakeSession("worked-then-stalled", [
        { frame: text("partial") },
        { frame: checkpoint([0x0a, 0x01, 0x05]) },
      ]),
      controller: controller(),
      retryPolicy: stallPolicy,
      retryBudget: budget,
      recover: async (recovery) => {
        recoveries.push(recovery)
        return fakeSession("after-stall", [{ frame: turnEnded() }])
      },
    })
    expect(final.sessionId).toBe("after-stall")
    expect(recoveries.map((recovery) => recovery.kind)).toEqual(["resume"])
    expect(budget.retries).toBe(2)
  })

  it("does not count the checkpoint a resumed Run started from as progress", async () => {
    const resumedFrom = [0x0a, 0x01, 0x06]
    await expect(pumpWithRecovery({
      initialSession: fakeSession("echoed-then-stalled", [{ frame: checkpoint(resumedFrom) }], {
        resumedFromCheckpoint: Uint8Array.from(resumedFrom),
      }),
      controller: controller(),
      retryPolicy: stallPolicy,
      retryBudget: windowOpenedLongAgo(),
      recover: async () => fakeSession("unused", [{ frame: turnEnded() }]),
    })).rejects.toBeInstanceOf(CursorRetryExhaustedError)
  })

  it("lets a capacity refusal between two stalls end the stall window", async () => {
    let recoveries = 0
    const final = await pumpWithRecovery({
      initialSession: fakeSession("refused-after-stall", [{ frame: endStreamError("resource_exhausted") }]),
      controller: controller(),
      retryPolicy: { ...stallPolicy, capacityMaxAttempts: 6 },
      retryBudget: windowOpenedLongAgo(),
      recover: async () => ++recoveries === 1
        ? fakeSession("stalls", [])
        : fakeSession("after", [{ frame: turnEnded() }]),
    })
    expect(final.sessionId).toBe("after")
    expect(recoveries).toBe(2)
  })

  it("still ends the turn when stalls follow each other without a checkpoint for 180 seconds", async () => {
    await expect(pumpWithRecovery({
      initialSession: fakeSession("stalled-again", [{ frame: text("partial") }]),
      controller: controller(),
      retryPolicy: stallPolicy,
      retryBudget: windowOpenedLongAgo(),
      canRebaseFromHistory: () => true,
      recover: async () => fakeSession("unused", [{ frame: turnEnded() }]),
    })).rejects.toBeInstanceOf(CursorRetryExhaustedError)
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
    expect(resolveRetryPolicy(undefined)).toMatchObject({ maxAttempts: undefined, capacityMaxAttempts: 6 })
    expect(resolveRetryPolicy({ maxAttempts: 2 })).toMatchObject({ maxAttempts: 2, capacityMaxAttempts: 2 })
  })

  it("retries a refused Run until capacity returns", async () => {
    let refusals = 2
    const recoveries: CursorRunRecovery[] = []
    const final = await pumpWithRecovery({
      initialSession: fakeSession("refused", [{ frame: endStreamError("resource_exhausted") }]),
      controller: controller(),
      retryPolicy: { baseDelayMs: 0, maxDelayMs: 0, capacityMaxAttempts: 6 },
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
      retryPolicy: { baseDelayMs: 0, maxDelayMs: 0, capacityMaxAttempts: 6 },
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

  it("counts capacity refusals and other failures against one explicit maxAttempts", async () => {
    for (const order of [["internal", "resource_exhausted"], ["resource_exhausted", "internal"]]) {
      const codes = [...order, "internal"]
      let recoveries = 0
      const failure = await pumpWithRecovery({
        initialSession: fakeSession("mixed", [{ frame: endStreamError(codes[0]!) }]),
        controller: controller(),
        retryPolicy: resolveRetryPolicy({ maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 }),
        recover: async () => {
          recoveries++
          return fakeSession(`mixed-${recoveries}`, [{ frame: endStreamError(codes[recoveries]!) }])
        },
      }).catch((error: unknown) => error)
      expect({ order, recoveries }).toEqual({ order, recoveries: 1 })
      expect(failure).toBeInstanceOf(CursorRetryExhaustedError)
    }
  })

  it("keeps capacity retries under an explicit maxAttempts across a host retry", async () => {
    const retryBudget = newRetryBudget()
    const retryPolicy = resolveRetryPolicy({ maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 })
    await expect(pumpWithRecovery({
      initialSession: fakeSession("cap-first", [{ frame: endStreamError("resource_exhausted") }]),
      controller: controller(),
      retryPolicy,
      retryBudget,
      recover: async () => fakeSession("cap-output", [{ frame: text("partial") }, { frame: endStreamError("internal") }]),
    })).rejects.toMatchObject({ hostRetryable: true })
    let recoveries = 0
    const failure = await pumpWithRecovery({
      initialSession: fakeSession("cap-host-retry", [{ frame: endStreamError("resource_exhausted") }]),
      controller: controller(),
      retryPolicy,
      retryBudget,
      recover: async () => {
        recoveries++
        return fakeSession("cap-fourth", [{ frame: turnEnded() }])
      },
    }).catch((error: unknown) => error)
    expect(recoveries).toBe(0)
    expect(failure).toBeInstanceOf(CursorRetryExhaustedError)
  })

  it("counts the capacity limit across the turn's host retries", async () => {
    let recoveries = 0
    const failure = await pumpWithRecovery({
      initialSession: fakeSession("cap-turn", [{ frame: endStreamError("resource_exhausted") }]),
      controller: controller(),
      retryPolicy: { baseDelayMs: 0, maxDelayMs: 0, capacityMaxAttempts: 6 },
      retryBudget: { ...newRetryBudget(), capacity: 5 },
      recover: async () => {
        recoveries++
        return fakeSession("cap-seventh", [{ frame: turnEnded() }])
      },
    }).catch((error: unknown) => error)
    expect(recoveries).toBe(0)
    expect(failure).toMatchObject({ attempts: 6 })
  })

  describe("late failures", () => {
    const LATE_MS = 50
    const policy = { baseDelayMs: 0, maxDelayMs: 0, capacityMaxAttempts: 6, lateFailureMs: LATE_MS }
    const slowIdle = { policy: { semanticIdleMs: 1_000, hardCapMs: 600_000, heartbeatMs: 5 } }
    const endStreamBody = (error: Record<string, unknown>): Frame => ({
      flags: 0x02,
      payload: new TextEncoder().encode(JSON.stringify({ error })),
    })
    // Cursor's end-stream error of 2026-11-26 (debug-2346521.log), byte for byte.
    const networkError = () => endStreamBody({
      code: "resource_exhausted",
      message: "Error",
      details: [{
        type: "aiserver.v1.ErrorDetails",
        debug: {
          error: "ERROR_NETWORK_ERROR",
          details: {
            title: "Network Error",
            detail: "We're having trouble connecting to the model provider. This might be temporary - please try again in a moment.",
            isRetryable: true,
          },
          isExpected: true,
        },
        value: "CDgSgQEKDU5ldHdvcmsgRXJyb3ISbldlJ3JlIGhhdmluZyB0cm91YmxlIGNvbm5lY3RpbmcgdG8gdGhlIG1vZGVsIHByb3ZpZGVyLiBUaGlzIG1pZ2h0IGJlIHRlbXBvcmFyeSAtIHBsZWFzZSB0cnkgYWdhaW4gaW4gYSBtb21lbnQuIAEYAQ",
      }],
    })
    const providerError = () => endStreamBody({
      code: "internal",
      message: "Error",
      details: [{ type: "aiserver.v1.ErrorDetails", value: "CDk=" }],
    })
    const lateFailure = (id: string, end: Frame, opening: TimedFrame[] = [{ frame: checkpoint([0x0a, 0x01, 0x07]) }]) =>
      fakeSession(id, [
        { frame: text("thinking") },
        ...opening,
        { frame: heartbeat(), afterMs: 35 },
        { frame: end, afterMs: 35 },
      ], slowIdle)
    const triggerWords = /unavailable|exhausted|at capacity|try again|overloaded/i

    const cases: Array<[string, () => Frame, string]> = [
      ["Cursor's network error", networkError, "resource_exhausted"],
      ["an internal error", () => endStreamError("internal"), "internal"],
      ["a capacity refusal", () => endStreamError("resource_exhausted"), "resource_exhausted"],
      ["a model provider error", providerError, "internal"],
    ]
    for (const [name, end, code] of cases) {
      it(`ends the turn at the second late ${name}, and says why`, async () => {
        let recoveries = 0
        const failure = await pumpWithRecovery({
          initialSession: lateFailure("late", end()),
          controller: controller(),
          retryPolicy: policy,
          recover: async () => lateFailure(`late-${++recoveries}`, end()),
        }).catch((error: unknown) => error)
        expect(recoveries).toBe(1)
        expect(failure).toBeInstanceOf(CursorLateFailureError)
        expect(failure).toMatchObject({ code, transient: false, retryable: false })
        expect((failure as Error).message).not.toMatch(triggerWords)
        const host = hostFacingError(failure, { modelId: "gemini-4-neon" }) as APICallError
        expect(APICallError.isInstance(host)).toBe(true)
        expect(host.isRetryable).toBe(false)
        expect(host.responseHeaders?.["x-should-retry"]).toBe("false")
        expect(host.message).toContain("for the second time")
        expect(host.message).toContain("smaller steps")
        expect(host.message).not.toMatch(triggerWords)
      })
    }

    it("names Cursor's error by its title, without its advice to try again", async () => {
      const failure = await pumpWithRecovery({
        initialSession: lateFailure("titled", networkError()),
        controller: controller(),
        retryPolicy: policy,
        recover: async () => lateFailure("titled-again", networkError()),
      }).catch((error: unknown) => error)
      const host = hostFacingError(failure, { modelId: "gemini-4-neon" }) as Error
      expect(host.message).toMatch(/\(Cursor: N\u2060?etwork Error\)/)
      expect(host.message).not.toMatch(/capacity|in a moment/i)
    })

    it("gives a late failure of a new step in the same pass its own retry", async () => {
      const stepCompleted = frame({ interaction_update: { step_completed: { step_id: 1, step_duration_ms: 100 } } })
      const nextStepLate = fakeSession("next-step", [
        { frame: text("done with the first step") },
        { frame: stepCompleted },
        { frame: checkpoint([0x0a, 0x01, 0x09]) },
        { frame: heartbeat(), afterMs: 35 },
        { frame: networkError(), afterMs: 35 },
      ], slowIdle)
      const recoveries: string[] = []
      const final = await pumpWithRecovery({
        initialSession: lateFailure("first-step", networkError()),
        controller: controller(),
        retryPolicy: policy,
        recover: async () => {
          recoveries.push("resume")
          return recoveries.length === 1 ? nextStepLate : fakeSession("served", [{ frame: turnEnded() }])
        },
      })
      expect(final.sessionId).toBe("served")
      expect(recoveries).toHaveLength(2)
    })

    it("counts late failures across the host's retry of the turn", async () => {
      const retryBudget = newRetryBudget()
      const noCheckpoint = (id: string) => lateFailure(id, networkError(), [])
      await expect(pumpWithRecovery({
        initialSession: noCheckpoint("host-first"),
        controller: controller(),
        retryPolicy: policy,
        retryBudget,
        recover: async () => fakeSession("unused", [{ frame: turnEnded() }]),
      })).rejects.toMatchObject({ hostRetryable: true })
      let recoveries = 0
      const failure = await pumpWithRecovery({
        initialSession: noCheckpoint("host-retry"),
        controller: controller(),
        retryPolicy: policy,
        retryBudget,
        recover: async () => {
          recoveries++
          return fakeSession("unused", [{ frame: turnEnded() }])
        },
      }).catch((error: unknown) => error)
      expect(recoveries).toBe(0)
      expect(failure).toBeInstanceOf(CursorLateFailureError)
    })

    it("keeps counting across an early failure between two late ones", async () => {
      let recoveries = 0
      const failure = await pumpWithRecovery({
        initialSession: lateFailure("late", networkError()),
        controller: controller(),
        retryPolicy: policy,
        recover: async () => ++recoveries === 1
          ? fakeSession("early", [{ frame: endStreamError("internal") }])
          : lateFailure("late-again", networkError()),
      }).catch((error: unknown) => error)
      expect(recoveries).toBe(2)
      expect(failure).toBeInstanceOf(CursorLateFailureError)
    })

    it("does not count a Cursor-side wait or tool call before the failure", async () => {
      const afterWait = (id: string) => fakeSession(id, [
        { frame: awaitStarted("w1", 10_000) },
        { frame: heartbeat(), afterMs: 35 },
        { frame: awaitCompleted("w1"), afterMs: 35 },
        { frame: checkpoint([0x0a, 0x01, 0x08]) },
        { frame: endStreamError("internal") },
      ], slowIdle)
      let recoveries = 0
      const final = await pumpWithRecovery({
        initialSession: afterWait("wait"),
        controller: controller(),
        retryPolicy: policy,
        recover: async () => ++recoveries < 3 ? afterWait(`wait-${recoveries}`) : fakeSession("served", [{ frame: turnEnded() }]),
      })
      expect(final.sessionId).toBe("served")
      expect(recoveries).toBe(3)
    })

    it("does not count a failure during a Cursor-side wait", async () => {
      const midWait = (id: string) => fakeSession(id, [
        { frame: checkpoint([0x0a, 0x01, 0x0a]) },
        { frame: awaitStarted("w1", 10_000) },
        { frame: heartbeat(), afterMs: 35 },
        { frame: endStreamError("internal"), afterMs: 35 },
      ], slowIdle)
      let recoveries = 0
      const final = await pumpWithRecovery({
        initialSession: midWait("mid-wait"),
        controller: controller(),
        retryPolicy: policy,
        recover: async () => ++recoveries < 3 ? midWait(`mid-wait-${recoveries}`) : fakeSession("served", [{ frame: turnEnded() }]),
      })
      expect(final.sessionId).toBe("served")
      expect(recoveries).toBe(3)
    })

    it("still ends the turn at the second late failure in endless retry mode", async () => {
      const saved = process.env.CURSOR_ENDLESS_RETRIES
      process.env.CURSOR_ENDLESS_RETRIES = "1"
      try {
        let recoveries = 0
        const failure = await pumpWithRecovery({
          initialSession: lateFailure("endless-late", networkError()),
          controller: controller(),
          retryPolicy: policy,
          recover: async () => lateFailure(`endless-late-${++recoveries}`, networkError()),
        }).catch((error: unknown) => error)
        expect(recoveries).toBe(1)
        expect(failure).toBeInstanceOf(CursorLateFailureError)
      } finally {
        if (saved === undefined) delete process.env.CURSOR_ENDLESS_RETRIES
        else process.env.CURSOR_ENDLESS_RETRIES = saved
      }
    })

    it("still retries the first late failure", async () => {
      const recoveries: CursorRunRecovery[] = []
      const final = await pumpWithRecovery({
        initialSession: lateFailure("late-once", networkError()),
        controller: controller(),
        retryPolicy: policy,
        recover: async (recovery) => {
          recoveries.push(recovery)
          return fakeSession("served", [{ frame: turnEnded() }])
        },
      })
      expect(final.sessionId).toBe("served")
      expect(recoveries.map((recovery) => recovery.kind)).toEqual(["resume"])
    })

    it("keeps every retry for failures Cursor sends early in the stream", async () => {
      let recoveries = 0
      const failure = await pumpWithRecovery({
        initialSession: fakeSession("early", [{ frame: endStreamError("internal") }]),
        controller: controller(),
        retryPolicy: { ...policy, lateFailureMs: 60_000 },
        recover: async () => fakeSession(`early-${++recoveries}`, [{ frame: endStreamError("internal") }]),
      }).catch((error: unknown) => error)
      expect(recoveries).toBe(3)
      expect((failure as Error).message).toStartWith("Cursor Run failed after 4 attempts")
    })

    it("keeps every retry for a connection that drops late in the stream", async () => {
      const dropped = (id: string) => fakeSession(id, [], {
        policy: { semanticIdleMs: 1_000, hardCapMs: 600_000, heartbeatMs: 5 },
        frames: {
          next: async () => {
            await new Promise((resolve) => setTimeout(resolve, LATE_MS + 20))
            throw new CursorTransportError("stream reset", { transient: true, replaySafe: true, code: "ERR_HTTP2_STREAM_CANCEL" })
          },
        },
      })
      let recoveries = 0
      const final = await pumpWithRecovery({
        initialSession: dropped("dropped"),
        controller: controller(),
        retryPolicy: policy,
        recover: async () => ++recoveries < 3 ? dropped(`dropped-${recoveries}`) : fakeSession("served", [{ frame: turnEnded() }]),
      })
      expect(final.sessionId).toBe("served")
      expect(recoveries).toBe(3)
    })

    it("gives a late failure its retry again after a completed step", async () => {
      const retryBudget = newRetryBudget()
      let recoveries = 0
      for (const step of ["first", "second"]) {
        const final = await pumpWithRecovery({
          initialSession: lateFailure(step, networkError()),
          controller: controller(),
          retryPolicy: policy,
          retryBudget,
          recover: async () => {
            recoveries++
            return fakeSession(`${step}-served`, [{ frame: turnEnded() }])
          },
        })
        expect(final.sessionId).toBe(`${step}-served`)
      }
      expect(recoveries).toBe(2)
    })
  })

  it("keeps retrying capacity refusals in endless retry mode", async () => {
    const saved = process.env.CURSOR_ENDLESS_RETRIES
    process.env.CURSOR_ENDLESS_RETRIES = "1"
    try {
      let refusals = 7
      const final = await pumpWithRecovery({
        initialSession: fakeSession("endless", [{ frame: endStreamError("resource_exhausted") }]),
        controller: controller(),
        retryPolicy: { baseDelayMs: 0, maxDelayMs: 0, capacityMaxAttempts: 6 },
        recover: async () => refusals-- > 0
          ? fakeSession(`endless-${refusals}`, [{ frame: endStreamError("resource_exhausted") }])
          : fakeSession("endless-served", [{ frame: turnEnded() }]),
      })
      expect(final.sessionId).toBe("endless-served")
    } finally {
      if (saved === undefined) delete process.env.CURSOR_ENDLESS_RETRIES
      else process.env.CURSOR_ENDLESS_RETRIES = saved
    }
  })

})
