import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import http2 from "node:http2"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import * as zlib from "node:zlib"
import { gunzipSync } from "node:zlib"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { CursorLocalCancellationError } from "../src/errors.js"
import { resetTurnStateForTests, settleRunSavesForTests } from "../src/language-model.js"
import { mapAvailableModelsResponse, writeCache } from "../src/models.js"
import { resetClientVersionCache } from "../src/protocol/client-version.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { decodeFramePayload, encodeFrame, FLAG_GZIP, streamFrames, type Frame } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { sessionManager } from "../src/session.js"
import { MODEL_CACHE_SCHEMA_VERSION } from "../src/shared.js"
import { writeStreamMessage } from "../src/stream-write.js"
import {
  bidiRunStream,
  closeCachedHttp2SessionsForTests,
  compressRunRequestAhead,
  isCompressionRejection,
  resetRunCompressionForTests,
  RUN_COMPRESS_MIN_BYTES,
} from "../src/transport/connect.js"

const ORIGIN = "https://agentn.compression-test.cursor.sh"
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const
const UNSUPPORTED = { code: "unimplemented", message: "unknown compression \"gzip\": supported encodings are identity" }
const realConnect = http2.connect
const savedProxy: Record<string, string | undefined> = {}
const savedClientVersion = process.env.CURSOR_CLIENT_VERSION

const endStream = (payload: unknown) =>
  encodeFrame(0x02, new TextEncoder().encode(typeof payload === "string" ? payload : JSON.stringify(payload)))
const serverFrame = (message: Record<string, unknown>) => encodeFrame(0x00, encodeMessage("AgentServerMessage", message))

async function listen(server: http2.Http2Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return (server.address() as net.AddressInfo).port
}

// The provider's own connect call, over plain TCP to `port`.
function routeConnectionsTo(port: number): void {
  ;(http2 as { connect: unknown }).connect = (origin: string, options?: http2.ClientSessionOptions) =>
    realConnect(origin, { ...options, createConnection: () => net.connect(port, "127.0.0.1") })
}

// Each gzip waits in `held` until the test runs it.
function holdCompression(held: Array<() => void>) {
  const realGzip = zlib.gzip
  return spyOn(zlib, "gzip").mockImplementation(((input: zlib.InputType, callback: zlib.CompressCallback) => {
    held.push(() => realGzip(input, callback))
  }) as unknown as typeof zlib.gzip)
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
}

beforeAll(() => {
  for (const key of PROXY_KEYS) {
    savedProxy[key] = process.env[key]
    delete process.env[key]
  }
  process.env.CURSOR_CLIENT_VERSION = "cli-compression-test-1"
  resetClientVersionCache()
})

afterAll(() => {
  ;(http2 as { connect: unknown }).connect = realConnect
  for (const key of PROXY_KEYS) {
    if (savedProxy[key] === undefined) delete process.env[key]
    else process.env[key] = savedProxy[key]
  }
  if (savedClientVersion === undefined) delete process.env.CURSOR_CLIENT_VERSION
  else process.env.CURSOR_CLIENT_VERSION = savedClientVersion
  resetClientVersionCache()
})

describe("isCompressionRejection", () => {
  it("recognizes how a server without gzip refuses it", () => {
    expect(isCompressionRejection({ httpStatus: 415 })).toBe(true)
    expect(isCompressionRejection(UNSUPPORTED)).toBe(true)
    expect(isCompressionRejection({ code: "unimplemented" })).toBe(true)
    expect(isCompressionRejection({ code: "12", message: "grpc: Decompressor is not installed for grpc-encoding \"gzip\"" })).toBe(true)
    expect(isCompressionRejection({ code: "invalid_argument", message: "decompress: gzip: invalid header" })).toBe(true)
    expect(isCompressionRejection({ code: "13", message: "sent compressed message without compression support" })).toBe(true)
  })

  it("does not blame compression for other failures", () => {
    for (const status of [
      { httpStatus: 200 },
      { httpStatus: 400 },
      { code: "0" },
      { code: "internal" },
      { code: "internal", message: "upstream model error" },
      { code: "invalid_argument", message: "conversation_state is too large" },
      { code: "unavailable", message: "gzip" },
      { code: "resource_exhausted" },
      {},
    ]) {
      expect(isCompressionRejection(status)).toBe(false)
    }
  })
})

type Answer = "ok" | "unimplemented" | "decompress" | "unrelated" | "garbage" | "http-415" | "http-401" | "grpc-headers" | "grpc-trailers"

describe("Run stream compression", () => {
  const streams: Array<{ headers: http2.IncomingHttpHeaders; frames: Frame[]; rstCode?: number }> = []
  const answers: Answer[] = []
  let server: http2.Http2Server

  beforeAll(async () => {
    server = http2.createServer()
    server.on("stream", (stream, headers) => {
      const record: (typeof streams)[number] = { headers, frames: [] }
      streams.push(record)
      const chunks: Buffer[] = []
      stream.on("data", (chunk: Buffer) => {
        chunks.push(chunk)
        record.frames = [...streamFrames(new Uint8Array(Buffer.concat(chunks)))]
      })
      stream.on("close", () => { record.rstCode = stream.rstCode })
      stream.on("error", () => {})
      const ok = { ":status": 200, "content-type": "application/connect+proto" }
      const answer = answers.shift() ?? "ok"
      switch (answer) {
        case "ok":
          stream.respond(ok)
          stream.write(encodeFrame(0x00, new Uint8Array([1])))
          break
        case "unimplemented":
          stream.respond(ok)
          stream.end(endStream({ error: UNSUPPORTED }))
          break
        case "decompress":
          stream.respond(ok)
          stream.end(endStream({ error: { code: "internal", message: "failed to decompress gzip message" } }))
          break
        case "unrelated":
          stream.respond(ok)
          stream.end(endStream({ error: { code: "internal", message: "upstream model error" } }))
          break
        case "garbage":
          stream.respond(ok)
          stream.end(endStream("not json"))
          break
        case "http-415":
        case "http-401":
          stream.respond({ ":status": Number(answer.slice(5)) }, { endStream: true })
          break
        case "grpc-headers":
          stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "12" }, { endStream: true })
          break
        case "grpc-trailers":
          stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true })
          stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "12", "grpc-message": "unknown encoding gzip" }))
          stream.end()
          break
      }
    })
    routeConnectionsTo(await listen(server))
  })

  beforeEach(() => {
    resetRunCompressionForTests()
  })

  afterEach(() => {
    closeCachedHttp2SessionsForTests()
    resetRunCompressionForTests()
    streams.length = 0
    answers.length = 0
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  async function drain(run: { frames(): AsyncIterable<unknown> }): Promise<void> {
    try {
      for await (const _ of run.frames()) { /* until the Run ends */ }
    } catch { /* a refused Run ends with its error */ }
  }

  it("announces gzip and compresses only messages of 1 KiB or more", async () => {
    const tiny = new Uint8Array([9, 9, 9])
    const under = new Uint8Array(RUN_COMPRESS_MIN_BYTES - 1).fill(7)
    const at = new Uint8Array(RUN_COMPRESS_MIN_BYTES).fill(7)
    const large = new Uint8Array(200 * 1024).map((_, i) => i % 13)
    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    for (const message of [tiny, under, at, large]) run.write(message)
    await until(() => streams[0]?.frames.length === 4)

    const [stream] = streams
    expect(stream!.headers["connect-content-encoding"]).toBe("gzip")
    expect(stream!.frames.map((frame) => frame.flags)).toEqual([0x00, 0x00, FLAG_GZIP, FLAG_GZIP])
    expect(stream!.frames[0]!.payload).toEqual(tiny)
    expect(stream!.frames[1]!.payload).toEqual(under)
    expect(new Uint8Array(gunzipSync(stream!.frames[2]!.payload))).toEqual(at)
    expect(new Uint8Array(gunzipSync(stream!.frames[3]!.payload))).toEqual(large)
    expect(stream!.frames[3]!.payload.length).toBeLessThan(large.length / 4)
    expect(run.compressionRejected?.()).toBe(false)
    run.end()
  })

  const filled = (size: number, value: number) => new Uint8Array(size).fill(value)
  const payloads = (frames: Frame[]) => frames.map((frame) => new Uint8Array(decodeFramePayload(frame)))

  it("writes large and small messages in the order given while the large ones compress", async () => {
    const messages = [filled(300_000, 1), filled(10, 2), filled(2048, 3), filled(20, 4), filled(500_000, 5), filled(30, 6)]
    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    const writes = messages.map((message) => run.write(message))
    // The first small message waits for the large one before it.
    expect(writes[1]).toBeInstanceOf(Promise)
    await Promise.all(writes)
    await until(() => streams[0]?.frames.length === messages.length)

    expect(streams[0]!.frames.map((frame) => frame.flags)).toEqual([FLAG_GZIP, 0x00, FLAG_GZIP, 0x00, FLAG_GZIP, 0x00])
    expect(payloads(streams[0]!.frames)).toEqual(messages)
    // With nothing compressing, a small message goes out at once.
    expect(run.write(filled(10, 7))).toBe(true)
    run.end()
  })

  it("writes an opening request compressed ahead at once, before Cursor can answer", async () => {
    const request = filled(300_000, 8)
    await compressRunRequestAhead(request)
    await compressRunRequestAhead(filled(10, 9))
    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    expect(run.write(request)).toBe(true)
    await until(() => streams[0]?.frames.length === 1)

    expect(streams[0]!.frames[0]!.flags).toBe(FLAG_GZIP)
    expect(payloads(streams[0]!.frames)).toEqual([request])
    run.end()
  })

  it("keeps concurrent protocol writes in order through compression and backpressure", async () => {
    const messages = [new Uint8Array(randomBytes(1_000_000)), filled(5, 2), new Uint8Array(randomBytes(400_000)), filled(5, 4)]
    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    await Promise.all(messages.map((message, index) => writeStreamMessage(run, message, `write ${index}`)))
    await until(() => streams[0]?.frames.length === messages.length)

    expect(payloads(streams[0]!.frames)).toEqual(messages)
    run.end()
  })

  it.each(["destroy", "end", "abort"] as const)("drops messages still waiting for compression when the Run is closed (%s)", async (close) => {
    const held: Array<() => void> = []
    using _gzip = holdCompression(held)
    const abort = new AbortController()
    const run = await bidiRunStream("token", { baseURL: ORIGIN, signal: abort.signal })
    expect(run.write(filled(10, 1))).toBe(true)
    const compressing = run.write(filled(4096, 2))
    const behind = run.write(filled(10, 3))
    await until(() => streams[0]?.frames.length === 1 && held.length === 1)
    if (close === "abort") abort.abort()
    else run[close]()
    for (const compress of held) compress()

    await expect(compressing).rejects.toBeInstanceOf(CursorLocalCancellationError)
    await expect(behind).rejects.toBeInstanceOf(CursorLocalCancellationError)
    expect(() => run.write(filled(10, 4))).toThrow(CursorLocalCancellationError)
    // Reset, not a clean end that Cursor could take as a complete request.
    await until(() => streams[0]!.rstCode !== undefined)
    expect(streams[0]!.rstCode).toBe(http2.constants.NGHTTP2_CANCEL)
    expect(payloads(streams[0]!.frames)).toEqual([filled(10, 1)])
  })

  it("sends a message uncompressed, in its place, when zlib cannot compress it", async () => {
    using _gzip = spyOn(zlib, "gzip").mockImplementation(((_input: zlib.InputType, callback: zlib.CompressCallback) => {
      callback(new Error("zlib failed"), Buffer.alloc(0))
    }) as unknown as typeof zlib.gzip)
    const messages = [filled(4096, 1), filled(10, 2)]
    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    await Promise.all(messages.map((message) => run.write(message)))
    await until(() => streams[0]?.frames.length === messages.length)

    expect(streams[0]!.frames.map((frame) => frame.flags)).toEqual([0x00, 0x00])
    expect(payloads(streams[0]!.frames)).toEqual(messages)
    run.end()
  })

  it.each([10, 4096])("fails the Run, not replay-safe, when HTTP/2 refuses a %d-byte write", async (size) => {
    const connect = http2.connect
    ;(http2 as { connect: unknown }).connect = (origin: string, options?: http2.ClientSessionOptions) => {
      const session = connect(origin, options)
      const request = session.request.bind(session)
      session.request = ((...args: Parameters<typeof request>) => {
        const stream = request(...args)
        stream.write = () => { throw new Error("stream write refused") }
        return stream
      }) as typeof session.request
      return session
    }
    try {
      const run = await bidiRunStream("token", { baseURL: ORIGIN })
      const failure = await Promise.resolve().then(() => run.write(filled(size, 1))).catch((error: unknown) => error)
      expect(failure).toMatchObject({ message: "Cursor Run stream write failed", replaySafe: false })
      expect(() => run.write(filled(10, 2))).toThrow("Cursor Run stream write failed")
      run.destroy()
      // Else the server meets this stream late and gives it the next test's answer.
      await until(() => streams[0]?.rstCode !== undefined)
    } finally {
      ;(http2 as { connect: unknown }).connect = connect
    }
  })

  it.each(["http-415", "http-401"] as const)(
    "leaves a Run that Cursor ends while a message compresses to report its own replay-safe error (%s)",
    async (answer) => {
      answers.push(answer)
      const held: Array<() => void> = []
      using _gzip = holdCompression(held)
      const run = await bidiRunStream("token", { baseURL: ORIGIN })
      let ended = false
      run.onTerminal(() => { ended = true })
      const request = writeStreamMessage(run, filled(8192, 1), "initial Run request")
      await until(() => ended && held.length === 1)
      for (const compress of held) compress()

      expect(await request).toBe(true)
      const failure = await (async () => {
        for await (const _ of run.frames()) { /* until the Run ends */ }
      })().then(() => undefined, (error: unknown) => error)
      expect(failure).toMatchObject({ replaySafe: true, message: expect.stringContaining(answer.slice(5)) })
      expect(run.compressionRejected?.()).toBe(answer === "http-415")
      expect(streams[0]!.frames).toEqual([])
    },
  )

  it.each(["unimplemented", "decompress", "http-415", "grpc-headers", "grpc-trailers"] as const)(
    "sends the origin's later Runs uncompressed after Cursor refuses a gzip Run (%s)",
    async (refusal) => {
      answers.push(refusal)
      const large = new Uint8Array(8 * 1024).fill(3)
      const first = await bidiRunStream("token", { baseURL: ORIGIN })
      first.write(large)
      await drain(first)
      expect(first.compressionRejected?.()).toBe(true)

      const second = await bidiRunStream("token", { baseURL: ORIGIN })
      second.write(large)
      await until(() => streams[1]?.frames.length === 1)

      expect(streams[0]!.headers["connect-content-encoding"]).toBe("gzip")
      expect(streams[1]!.headers["connect-content-encoding"]).toBeUndefined()
      expect(streams[1]!.frames[0]!.flags).toBe(0x00)
      expect(streams[1]!.frames[0]!.payload).toEqual(large)
      expect(second.compressionRejected?.()).toBe(false)
      second.end()
    },
  )

  it.each(["unrelated", "garbage"] as const)("keeps compressing after a failure unrelated to compression (%s)", async (failure) => {
    answers.push(failure)
    const first = await bidiRunStream("token", { baseURL: ORIGIN })
    first.write(new Uint8Array(8 * 1024).fill(3))
    await drain(first)
    expect(first.compressionRejected?.()).toBe(false)

    const second = await bidiRunStream("token", { baseURL: ORIGIN })
    second.write(new Uint8Array(8 * 1024).fill(3))
    await until(() => streams[1]?.frames.length === 1)
    expect(streams[1]!.headers["connect-content-encoding"]).toBe("gzip")
    expect(streams[1]!.frames[0]!.flags).toBe(FLAG_GZIP)
    second.end()
  })
})

type SeenRun = { encoding?: string; flags: number[]; request?: Uint8Array; state?: Uint8Array }
type Refusal = "after-request" | "before-reading" | "after-output" | undefined

describe("Cursor refusing a gzip Run through the provider", () => {
  const seen: SeenRun[] = []
  let refusal: Refusal
  let refuseOnlyWarm = false
  let slowResend = false
  let holdForTool = false
  let server: http2.Http2Server
  let directory: string

  const checkpoint = encodeMessage("ConversationStateStructure", { root_prompt_messages_json: ["turn-1"] })
  const answer = (stream: http2.ServerHttp2Stream) => {
    if (holdForTool) {
      stream.write(serverFrame({ exec_server_message: { id: 1, read_args: { path: path.join(directory, "readme.md"), tool_call_id: "call-read" } } }))
      return
    }
    stream.write(serverFrame({ interaction_update: { text_delta: { text: "Done." } } }))
    stream.write(serverFrame({ conversation_checkpoint_update: checkpoint }))
    stream.write(serverFrame({ interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 2 } } }))
  }

  beforeAll(async () => {
    server = http2.createServer()
    server.on("stream", (stream, headers) => {
      const run: SeenRun = { flags: [] }
      if (typeof headers["connect-content-encoding"] === "string") run.encoding = headers["connect-content-encoding"]
      seen.push(run)
      stream.on("error", () => {})
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
      const refusing = run.encoding === "gzip" && refusal !== undefined
      if (refusing && refusal === "before-reading") {
        // A Connect server without gzip refuses from the headers and never reads the body.
        stream.end(endStream({ error: UNSUPPORTED }), () => {
          try { stream.close(http2.constants.NGHTTP2_NO_ERROR) } catch { /* already closed */ }
        })
        return
      }
      if (slowResend && run.encoding === undefined) {
        stream.pause()
        setTimeout(() => stream.resume(), 400)
      }
      let pending = Buffer.alloc(0)
      stream.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk])
        while (pending.length >= 5) {
          const length = pending.readUInt32BE(1)
          if (pending.length < 5 + length) break
          const flags = pending[0]!
          const payload = decodeFramePayload({ flags, payload: pending.subarray(5, 5 + length) })
          pending = pending.subarray(5 + length)
          run.flags.push(flags)
          const message = decodeMessage<{ run_request?: { conversation_state?: Uint8Array } }>("AgentClientMessage", payload)
          if (!message.run_request || run.request) continue
          run.request = payload
          run.state = message.run_request.conversation_state
          if (refusing && (!refuseOnlyWarm || run.state?.length)) {
            if (refusal === "after-output") stream.write(serverFrame({ interaction_update: { text_delta: { text: "partial" } } }))
            stream.end(endStream({ error: UNSUPPORTED }))
            return
          }
          answer(stream)
        }
      })
    })
    routeConnectionsTo(await listen(server))
  })

  beforeEach(async () => {
    resetRunCompressionForTests()
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-run-compression-"))
    const models = mapAvailableModelsResponse({ models: [{ name: "gzip-fixture" }] })
    await writeCache(directory, { models, fetchedAt: Date.now(), schemaVersion: MODEL_CACHE_SCHEMA_VERSION })
  })

  afterEach(async () => {
    await settleRunSavesForTests()
    sessionManager.dispose()
    resetTurnStateForTests()
    resetConversationPersistenceForTests()
    resetConversationBindingsForTests()
    resetCheckpointsForTests()
    setHostCacheDirOverride(undefined)
    closeCachedHttp2SessionsForTests()
    resetRunCompressionForTests()
    await fs.rm(directory, { recursive: true, force: true })
    seen.length = 0
    refusal = undefined
    refuseOnlyWarm = false
    slowResend = false
    holdForTool = false
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  async function turn(
    texts: string[],
    sessionKey: string,
    continuation?: { heartbeatMs: number; semanticIdleMs: number },
  ): Promise<LanguageModelV3StreamPart[]> {
    const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: directory, continuation })
      .languageModel("gzip-fixture")
    const prompt = texts.flatMap((text, index) => [
      ...(index > 0 ? [{ role: "assistant" as const, content: [{ type: "text" as const, text: "Done." }] }] : []),
      { role: "user" as const, content: [{ type: "text" as const, text }] },
    ])
    // One advertised tool makes this a main Run rather than a lifecycle helper.
    const { stream } = await model.doStream({
      prompt,
      tools: [{ type: "function", name: "read", inputSchema: { type: "object", properties: {} } }],
      headers: { "x-opencode-session-id": sessionKey },
    })
    const parts: LanguageModelV3StreamPart[] = []
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return parts
        parts.push(value)
      }
    } catch (error) {
      parts.push({ type: "error", error })
      return parts
    }
  }

  const textOf = (parts: LanguageModelV3StreamPart[]) =>
    parts.filter((part) => part.type === "text-delta").map((part) => (part as { delta: string }).delta).join("")
  const errors = (parts: LanguageModelV3StreamPart[]) => parts.filter((part) => part.type === "error")

  it("sends the Run's request once more uncompressed when Cursor refuses it after it went out", async () => {
    refusal = "after-request"
    const parts = await turn(["Say done."], "ses_gzip_after_request")

    expect(errors(parts)).toEqual([])
    expect(textOf(parts)).toBe("Done.")
    expect(seen.map((run) => run.encoding)).toStrictEqual(["gzip", undefined])
    expect(seen[0]!.flags).toContain(FLAG_GZIP)
    expect(seen[1]!.flags.every((flags) => flags === 0)).toBe(true)
    expect(seen[1]!.request).toEqual(seen[0]!.request!)

    // Later turns go uncompressed from the start.
    await turn(["Say done.", "Again."], "ses_gzip_after_request")
    expect(seen.map((run) => run.encoding)).toStrictEqual(["gzip", undefined, undefined])
  })

  it("keeps the Run through heartbeats and its idle window while the uncompressed resend uploads", async () => {
    refusal = "after-request"
    slowResend = true
    const large = `Summarize this: ${randomBytes(3_000_000).toString("base64")}`
    // The resend's upload stalls for 400 ms, past both.
    const parts = await turn([large], "ses_gzip_slow_resend", { heartbeatMs: 20, semanticIdleMs: 300 })

    expect(errors(parts)).toEqual([])
    expect(textOf(parts)).toBe("Done.")
    expect(seen.map((run) => run.encoding)).toStrictEqual(["gzip", undefined])
    expect(seen[1]!.request).toEqual(seen[0]!.request!)
  }, 30_000)

  it("sends the Run's request once more uncompressed when Cursor refuses it while it uploads", async () => {
    refusal = "before-reading"
    const large = `Summarize this: ${randomBytes(4_500_000).toString("base64")}`
    const parts = await turn([large], "ses_gzip_before_reading")

    expect(errors(parts)).toEqual([])
    expect(textOf(parts)).toBe("Done.")
    expect(seen.map((run) => run.encoding)).toStrictEqual(["gzip", undefined])
    expect(seen[0]!.request).toBeUndefined()
    expect(seen[1]!.flags.every((flags) => flags === 0)).toBe(true)
    expect(new TextDecoder().decode(seen[1]!.request)).toContain(large)
  }, 30_000)

  it("keeps a refused warm turn on its conversation and checkpoint", async () => {
    refusal = "after-request"
    refuseOnlyWarm = true
    expect(textOf(await turn(["First."], "ses_gzip_warm"))).toBe("Done.")
    const parts = await turn(["First.", "Second."], "ses_gzip_warm")

    expect(errors(parts)).toEqual([])
    expect(textOf(parts)).toBe("Done.")
    expect(seen.map((run) => run.encoding)).toStrictEqual(["gzip", "gzip", undefined])
    expect(seen[1]!.state).toEqual(checkpoint)
    expect(seen[2]!.request).toEqual(seen[1]!.request!)
  })

  it.each([undefined, "after-request"] as const)(
    "releases the Run's request once its first pass ends, while the Run is held for tools (refusal: %s)",
    async (refused) => {
      refusal = refused
      holdForTool = true
      await fs.writeFile(path.join(directory, "readme.md"), "Read me.")
      const parts = await turn(["Read the readme."], "ses_gzip_held")

      expect(errors(parts)).toEqual([])
      expect(parts.some((part) => part.type === "tool-call")).toBe(true)
      expect(seen).toHaveLength(refused ? 2 : 1)
      const held = sessionManager.findOpenByOpenCodeSessionId("ses_gzip_held")
      expect(held?.pending.size).toBe(1)
      // A refusal can only end the pass that opened the Run; later passes cannot resend.
      expect(held?.resendRunRequest).toBeUndefined()
    },
  )

  it("does not resend a refused Run after it showed output", async () => {
    refusal = "after-output"
    const parts = await turn(["Say done."], "ses_gzip_after_output")

    expect(errors(parts)).not.toEqual([])
    expect(seen).toHaveLength(1)
  })

  it("opens no Run when the turn is stopped while its request compresses", async () => {
    const held: Array<() => void> = []
    using _gzip = holdCompression(held)
    const abort = new AbortController()
    const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: directory })
      .languageModel("gzip-fixture")
    const opened = model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: `Summarize this: ${"x".repeat(50_000)}` }] }],
      tools: [{ type: "function", name: "read", inputSchema: { type: "object", properties: {} } }],
      headers: { "x-opencode-session-id": "ses_gzip_stopped_compressing" },
      abortSignal: abort.signal,
    }).then(async ({ stream }) => {
      const reader = stream.getReader()
      while (!(await reader.read()).done) { /* until the turn ends */ }
    }, () => undefined)
    await until(() => held.length > 0)
    abort.abort()
    for (const compress of held) compress()
    await Promise.resolve(opened).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(seen).toEqual([])
  })
})
