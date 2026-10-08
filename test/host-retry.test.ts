import { afterEach, describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import http2 from "node:http2"
import os from "node:os"
import path from "node:path"
import { APICallError, type LanguageModelV3CallOptions, type LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { encodeFrame } from "../src/protocol/framing.js"
import { decodeMessage } from "../src/protocol/messages.js"
import { closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"
import {
  CursorRetryExhaustedError,
  CursorServerError,
  CursorTransportError,
  retrySuppressedError,
} from "../src/errors.js"
import {
  FINAL_FAILURE_TTL_MS,
  isFinalForHost,
  recordFinalFailure,
  resetFinalFailuresForTests,
  takeFinalFailure,
} from "../src/host-retry.js"
import { createCursor } from "../src/index.js"
import { pumpWithRecovery, resetTurnStateForTests } from "../src/language-model.js"
import { toolsToDescriptors } from "../src/protocol/tools.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { resetCursorShellCalls } from "../src/shell-timeout.js"

const capacity = () => new CursorServerError("Cursor API error (code=resource_exhausted)", {
  transient: true, replaySafe: true, code: "resource_exhausted",
})
const refusalEnvelope = JSON.stringify({
  error: {
    code: "resource_exhausted",
    message: "Error",
    details: [{
      type: "aiserver.v1.ErrorDetails",
      debug: {
        error: "ERROR_CUSTOM_MESSAGE",
        details: { title: "Too many computers.", detail: "Too many computers used within the last 24 hours." },
        isExpected: true,
      },
    }],
  },
})
const endStream = (body: string): Frame => ({ flags: 0x02, payload: new TextEncoder().encode(body) })

afterEach(() => {
  resetFinalFailuresForTests()
  sessionManager.dispose()
  resetCursorShellCalls()
  resetTurnStateForTests()
})

describe("final failures OpenCode must not retry", () => {
  it("counts only account refusals and capacity after the provider's own attempts", () => {
    expect(isFinalForHost(new CursorRetryExhaustedError(6, capacity()))).toBe(true)
    const internal = new CursorServerError("Cursor API error (code=internal)", { transient: true, replaySafe: true, code: "internal" })
    expect(isFinalForHost(new CursorRetryExhaustedError(3, internal))).toBe(false)
    expect(isFinalForHost(new CursorRetryExhaustedError(3, new CursorTransportError("Cursor transport failure (ECONNRESET)")))).toBe(false)
    expect(isFinalForHost(retrySuppressedError(capacity(), "after visible output", 1, 6))).toBe(false)
    expect(isFinalForHost(new Error("Cursor refused the request: x"))).toBe(false)
    const overflow = new APICallError({
      message: "prompt is too long: rebasing this session onto Cursor needs ~900000 tokens",
      url: "cursor://agent.v1.AgentService/Run",
      requestBodyValues: {},
      statusCode: 413,
      isRetryable: false,
    })
    expect(isFinalForHost(overflow)).toBe(false)
  })

  it("vetoes once, for the recorded session and message only", () => {
    const failure = new CursorRetryExhaustedError(6, capacity())
    recordFinalFailure("ses_a", failure)
    expect(takeFinalFailure("ses_b", failure.message)).toBe(false)
    expect(takeFinalFailure("ses_a", "Cursor stream stalled")).toBe(false)
    expect(takeFinalFailure("ses_a", undefined)).toBe(false)
    expect(takeFinalFailure("ses_a", failure.message)).toBe(true)
    expect(takeFinalFailure("ses_a", failure.message)).toBe(false)
  })

  it("ignores failures the host may retry, and stale records", () => {
    recordFinalFailure("ses_t", new CursorTransportError("Cursor transport failure (ECONNRESET)"))
    expect(takeFinalFailure("ses_t", "Cursor transport failure (ECONNRESET)")).toBe(false)

    const failure = new CursorRetryExhaustedError(6, capacity())
    recordFinalFailure("ses_old", failure, 1_000)
    expect(takeFinalFailure("ses_old", failure.message, 1_000 + FINAL_FAILURE_TTL_MS + 1)).toBe(false)
    recordFinalFailure(undefined, failure)
  })

  it("is visible to another copy of the module (the plugin's)", async () => {
    const pluginCopy = await import(`../src/host-retry.js?copy=${Date.now()}`) as typeof import("../src/host-retry.js")
    const failure = new CursorRetryExhaustedError(6, capacity())
    recordFinalFailure("ses_copy", failure)
    expect(pluginCopy.takeFinalFailure("ses_copy", failure.message)).toBe(true)
  })

  it("marks the error that ends a Run refused for capacity six times", async () => {
    const refused = (id: string): CursorSession => ({
      sessionId: id,
      conversationId: `conv-${id}`,
      stream: { write() {}, end() {}, destroy() {}, isClosed: () => false, frames: () => ({ async *[Symbol.asyncIterator]() {} }) },
      frames: { next: async () => ({ done: false, value: endStream(JSON.stringify({ error: { code: "resource_exhausted" } })) }) },
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
      policy: { semanticIdleMs: 60, hardCapMs: 600_000, heartbeatMs: 5 },
    }) as unknown as CursorSession
    let n = 0
    const failure = await pumpWithRecovery({
      initialSession: refused("full"),
      controller: { enqueue() {}, close() {}, error() {} } as unknown as ReadableStreamDefaultController<any>,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, capacityMaxAttempts: 6 },
      recover: async () => refused(`full-${++n}`),
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CursorRetryExhaustedError)
    expect(isFinalForHost(failure)).toBe(true)
  })

  it("records Cursor's account refusal when it ends the step's stream", async () => {
    const queue: Frame[] = []
    let wake: ((result: IteratorResult<Frame>) => void) | undefined
    const frames: AsyncIterator<Frame> = {
      next: () => {
        const next = queue.shift()
        if (next) return Promise.resolve({ done: false, value: next })
        return new Promise((resolve) => { wake = resolve })
      },
    }
    const push = (item: Frame) => {
      if (wake) { const resolve = wake; wake = undefined; resolve({ done: false, value: item }) } else queue.push(item)
    }
    const writes: Uint8Array[] = []
    const definitions = [{ name: "bash", description: "Shell" }]
    const tools = toolsToDescriptors(definitions, "opencode", [])
    const session = {
      sessionId: "refused",
      conversationId: "conv_refused",
      runId: "run_refused",
      openCodeSessionId: "ses_refused",
      requestedAt: Date.now() - 10,
      stream: {
        write(data: Uint8Array) { writes.push(data); return true },
        end() {}, destroy() {}, isClosed: () => false,
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
    } as unknown as CursorSession
    sessionManager.registerSession(session)
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
        headers: { "x-opencode-session-id": "ses_refused" },
        tools: [{ type: "function", name: "bash", description: "Shell", inputSchema: { type: "object", properties: {} } }],
      } as LanguageModelV3CallOptions)
      const consumed = (async () => { for await (const _ of result.stream as unknown as AsyncIterable<LanguageModelV3StreamPart>) { /* drain */ } })()
      consumed.catch(() => {})
      for (let i = 0; i < 200 && (writes.length === 0 || session.pumpOwner == null); i++) await Bun.sleep(5)
      push(endStream(refusalEnvelope))

      const error = await consumed.then(() => undefined, (failure: unknown) => failure as Error)
      expect(error?.message).toStartWith("Cursor refused the request: Too many computers.")
      expect(takeFinalFailure("ses_refused", `${error?.message}`)).toBe(true)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("records it for a tool-less step, whose Run is not bound to the session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-host-retry-"))
    setHostCacheDirOverride(path.join(root, "cache"))
    const connect = http2.connect
    let runs = 0
    ;(http2 as any).connect = () => {
      const session: any = Object.assign(new EventEmitter(), {
        closed: false,
        destroyed: false,
        request() {
          const stream: any = Object.assign(new EventEmitter(), {
            closed: false,
            destroyed: false,
            rstCode: 0,
            write(data: Uint8Array) {
              if (decodeMessage<any>("AgentClientMessage", data.subarray(5)).run_request) {
                runs++
                setImmediate(() => {
                  stream.emit("response", { ":status": 200 })
                  stream.emit("data", encodeFrame(0x02, new TextEncoder().encode(refusalEnvelope)))
                })
              }
              return true
            },
            end() {},
            close() { stream.closed = true },
            destroy() { stream.destroyed = true; stream.closed = true; stream.emit("close") },
          })
          return stream
        },
        ping(callback: (error: Error | null) => void) { callback(null); return true },
        close() { session.closed = true },
        destroy() { session.destroyed = true },
      })
      setImmediate(() => session.emit("connect"))
      return session
    }
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error("no network in this test") }) as unknown as typeof fetch
    try {
      const model = createCursor({
        name: "cursor", accessToken: "token", agentBaseURL: "https://agentn.us.api5.cursor.sh", workspaceRoot: root,
      }).languageModel("claude-opus-5-5")
      const result = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Summarize what you did." }] }],
        headers: { "x-opencode-session-id": "ses_max_steps" },
        toolChoice: { type: "none" },
      } as LanguageModelV3CallOptions)
      const error = await (async () => { for await (const _ of result.stream as unknown as AsyncIterable<LanguageModelV3StreamPart>) { /* drain */ } })()
        .then(() => undefined, (failure: unknown) => failure as Error)
      expect(runs).toBe(1)
      expect(error?.message).toStartWith("Cursor refused the request: Too many computers.")
      expect(takeFinalFailure("ses_max_steps", `${error?.message}`)).toBe(true)
    } finally {
      globalThis.fetch = realFetch
      ;(http2 as any).connect = connect
      closeCachedHttp2SessionsForTests()
      setHostCacheDirOverride(undefined)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
