import { afterEach, describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import http2 from "node:http2"
import os from "node:os"
import path from "node:path"
import { APICallError, type LanguageModelV3CallOptions, type LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { decodeFramePayload, encodeFrame } from "../src/protocol/framing.js"
import { decodeMessage } from "../src/protocol/messages.js"
import { closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"
import { CursorRetryExhaustedError, hostFacingError } from "../src/errors.js"
import { createCursor } from "../src/index.js"
import { pumpWithRecovery, resetTurnStateForTests } from "../src/language-model.js"
import { toolsToDescriptors } from "../src/protocol/tools.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { resetCursorShellCalls } from "../src/shell-timeout.js"

// A Cursor account refusal as Cursor renders it in the JSON envelope: the
// details' `debug` carries the message, so it must be read without `value`.
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

function expectFinalForHost(error: unknown): void {
  expect(APICallError.isInstance(error)).toBe(true)
  const apiError = error as APICallError
  expect(apiError.isRetryable).toBe(false)
  expect(apiError.responseHeaders?.["x-should-retry"]).toBe("false")
  expect(apiError.statusCode).toBeLessThan(500)
}

afterEach(() => {
  sessionManager.dispose()
  resetCursorShellCalls()
  resetTurnStateForTests()
})

describe("final failures reach the host as not retryable", () => {
  it("ends a Run refused for capacity six times with a final error", async () => {
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
    expect((failure as CursorRetryExhaustedError).attempts).toBe(6)
    expectFinalForHost(hostFacingError(failure))
  })

  it("ends the step's stream with Cursor's account refusal, final and with its message", async () => {
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
      expect(error?.message).toContain("Too many computers.")
      expectFinalForHost(error)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("refuses a tool-less step once, final for the host", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-final-error-"))
    setHostCacheDirOverride(path.join(root, "cache"))
    const connect = http2.connect
    let runs = 0
    ;(http2 as any).connect = () => {
      const session: any = Object.assign(new EventEmitter(), {
        closed: false,
        destroyed: false,
        ref() {},
        unref() {},
        request() {
          const stream: any = Object.assign(new EventEmitter(), {
            closed: false,
            destroyed: false,
            rstCode: 0,
            write(data: Uint8Array) {
              if (decodeMessage<any>("AgentClientMessage", decodeFramePayload({ flags: data[0]!, payload: data.subarray(5) })).run_request) {
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
      expect(error?.message).toContain("Too many computers.")
      expectFinalForHost(error)
    } finally {
      globalThis.fetch = realFetch
      ;(http2 as any).connect = connect
      closeCachedHttp2SessionsForTests()
      setHostCacheDirOverride(undefined)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
