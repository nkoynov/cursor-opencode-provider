import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import http2 from "node:http2"
import net from "node:net"
import { gunzipSync } from "node:zlib"
import { CursorProviderError, CursorServerError, isCompressionRejection } from "../src/errors.js"
import { connectFrameError, pumpWithRecovery } from "../src/language-model.js"
import { resetClientVersionCache } from "../src/protocol/client-version.js"
import { encodeFrame, FLAG_GZIP, streamFrames } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { describeTtftBreakdown } from "../src/protocol/ttft.js"
import type { CursorSession, Frame } from "../src/session.js"
import {
  bidiRunStream,
  closeCachedHttp2SessionsForTests,
  encodeRunFrame,
  resetRunCompressionForTests,
  routeHttp2ConnectionsForTests,
  RUN_COMPRESS_MIN_BYTES,
} from "../src/transport/connect.js"
import { sessionFixture } from "./session-fixture.js"

const ORIGIN = "https://agentn.compression-test.cursor.sh"

describe("encodeRunFrame", () => {
  it("compresses a message only when it is over 1 KiB", () => {
    const small = new Uint8Array(RUN_COMPRESS_MIN_BYTES).fill(7)
    const large = new Uint8Array(RUN_COMPRESS_MIN_BYTES + 1).fill(7)

    const atThreshold = encodeRunFrame(small, true)
    expect(atThreshold[0]).toBe(0x00)
    expect(atThreshold.subarray(5)).toEqual(small)

    const over = encodeRunFrame(large, true)
    expect(over[0]).toBe(FLAG_GZIP)
    const [frame] = [...streamFrames(over)]
    expect(new Uint8Array(gunzipSync(frame!.payload))).toEqual(large)
    expect(over.length).toBeLessThan(large.length)
  })

  it("sends every message uncompressed when compression is off", () => {
    const large = new Uint8Array(64 * 1024).fill(1)
    const off = encodeRunFrame(large, false)
    expect(off[0]).toBe(0x00)
    expect(off.subarray(5)).toEqual(large)
  })
})

type ReceivedStream = { headers: http2.IncomingHttpHeaders; frames: Frame[] }

async function startFakeCursor() {
  const streams: ReceivedStream[] = []
  const server = http2.createServer()
  server.on("stream", (stream, headers) => {
    const record: ReceivedStream = { headers, frames: [] }
    streams.push(record)
    const chunks: Buffer[] = []
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
      record.frames = [...streamFrames(new Uint8Array(Buffer.concat(chunks)))]
    })
    stream.on("error", () => {})
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    stream.write(encodeFrame(0x00, new Uint8Array([1])))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as net.AddressInfo).port
  routeHttp2ConnectionsForTests(() => net.connect(port, "127.0.0.1"))
  return {
    streams,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await sleep(5)
}

describe("Run stream compression", () => {
  let fake: Awaited<ReturnType<typeof startFakeCursor>>
  const savedClientVersion = process.env.CURSOR_CLIENT_VERSION

  beforeEach(async () => {
    process.env.CURSOR_CLIENT_VERSION = "cli-compression-test-1"
    resetClientVersionCache()
    resetRunCompressionForTests()
    fake = await startFakeCursor()
  })

  afterEach(async () => {
    closeCachedHttp2SessionsForTests()
    routeHttp2ConnectionsForTests()
    resetRunCompressionForTests()
    await fake.close()
    if (savedClientVersion === undefined) delete process.env.CURSOR_CLIENT_VERSION
    else process.env.CURSOR_CLIENT_VERSION = savedClientVersion
    resetClientVersionCache()
  })

  it("announces gzip and compresses only the frames over 1 KiB", async () => {
    const large = new Uint8Array(200 * 1024).map((_, i) => i % 13)
    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    run.write(new Uint8Array([9, 9, 9]))
    run.write(large)
    await until(() => fake.streams[0]?.frames.length === 2)

    const [stream] = fake.streams
    expect(stream!.headers["connect-content-encoding"]).toBe("gzip")
    expect(stream!.frames.map((frame) => frame.flags)).toEqual([0x00, FLAG_GZIP])
    expect(stream!.frames[0]!.payload).toEqual(new Uint8Array([9, 9, 9]))
    expect(new Uint8Array(gunzipSync(stream!.frames[1]!.payload))).toEqual(large)
    expect(run.usesCompression?.()).toBe(true)
    run.end()
  })

  it("sends the origin's later Runs uncompressed once compression is disabled", async () => {
    const large = new Uint8Array(8 * 1024).fill(3)
    const first = await bidiRunStream("token", { baseURL: ORIGIN })
    first.write(large)
    await until(() => fake.streams[0]?.frames.length === 1)
    first.disableCompression?.("test rejection")
    first.end()

    const second = await bidiRunStream("token", { baseURL: ORIGIN })
    second.write(large)
    await until(() => fake.streams[1]?.frames.length === 1)

    expect(fake.streams[1]!.headers["connect-content-encoding"]).toBeUndefined()
    expect(fake.streams[1]!.frames[0]!.flags).toBe(0x00)
    expect(fake.streams[1]!.frames[0]!.payload).toEqual(large)
    expect(second.usesCompression?.()).toBe(false)
    second.end()
  })
})

describe("compression rejection", () => {
  it("recognizes Cursor refusing a compressed message", () => {
    expect(isCompressionRejection(connectFrameError(JSON.stringify({
      error: { code: "unimplemented", message: "unknown compression \"gzip\": supported encodings are identity" },
    })))).toBe(true)
    expect(isCompressionRejection(connectFrameError(JSON.stringify({ error: { code: "unimplemented" } })))).toBe(true)
    expect(isCompressionRejection(connectFrameError(JSON.stringify({
      error: { code: "invalid_argument", message: "decompress: gzip: invalid header" },
    })))).toBe(true)
    expect(isCompressionRejection(connectFrameError(JSON.stringify({
      error: { code: "internal", message: "protocol error: sent compressed message without compression support" },
    })))).toBe(true)
    expect(isCompressionRejection(new CursorServerError("Cursor Run failed by remote: HTTP 415", {
      statusCode: 415, transient: false, replaySafe: true,
    }))).toBe(true)
    expect(isCompressionRejection(new CursorServerError("Cursor Run failed by remote: gRPC status 12", {
      grpcStatus: "12", transient: false, replaySafe: true,
    }))).toBe(true)
  })

  it("does not blame compression for other failures", () => {
    for (const error of [
      { code: "internal" },
      { code: "internal", message: "upstream model error" },
      { code: "invalid_argument", message: "conversation_state is too large" },
      { code: "unavailable", message: "gzip" },
      { code: "resource_exhausted" },
    ]) {
      expect(isCompressionRejection(connectFrameError(JSON.stringify({ error })))).toBe(false)
    }
    expect(isCompressionRejection(new CursorServerError("HTTP 400", {
      statusCode: 400, transient: false, replaySafe: true,
    }))).toBe(false)
  })

  it("keeps Cursor's error message", () => {
    const error = connectFrameError(JSON.stringify({ error: { code: "internal", message: "boom" } }))
    expect(error.serverMessage).toBe("boom")
  })
})

function endStreamError(error: Record<string, unknown>): Frame {
  return { flags: 0x02, payload: new TextEncoder().encode(JSON.stringify({ error })) }
}

const turnEnded = (): Frame => ({
  flags: 0,
  payload: encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } }),
})

const textDelta = (text: string): Frame => ({
  flags: 0,
  payload: encodeMessage("AgentServerMessage", { interaction_update: { text_delta: { text } } }),
})

function fakeSession(id: string, frames: Frame[], compressed: boolean, disabled: string[]): CursorSession {
  let index = 0
  return sessionFixture({
    sessionId: id,
    conversationId: `conv-${id}`,
    stream: {
      write() {},
      usesCompression: () => compressed,
      disableCompression: (reason: string) => { disabled.push(reason) },
      end() {},
      frames: () => ({ async *[Symbol.asyncIterator]() { yield* frames } }),
      destroy() {},
      isClosed: () => false,
      onTerminal: () => () => {},
    },
    frames: {
      next: async () => index < frames.length
        ? { done: false, value: frames[index++]! }
        : { done: true, value: undefined },
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
  })
}

function controller(parts: unknown[] = []) {
  return {
    enqueue(part: unknown) { parts.push(part) },
    close() {},
    error(error: unknown) { throw error },
  } as unknown as ReadableStreamDefaultController<any>
}

const unsupported = { code: "unimplemented", message: "unknown compression \"gzip\"" }

describe("compression fallback", () => {
  it("reopens a rejected compressed Run once, uncompressed, outside the retry budget", async () => {
    const disabled: string[] = []
    const recoveries: unknown[] = []
    const final = await pumpWithRecovery({
      initialSession: fakeSession("gzip-rejected", [endStreamError(unsupported)], true, disabled),
      controller: controller(),
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      recover: async (recovery) => {
        recoveries.push(recovery)
        return fakeSession("uncompressed", [turnEnded()], false, disabled)
      },
    })
    expect(final.sessionId).toBe("uncompressed")
    expect(disabled).toHaveLength(1)
    expect(recoveries).toEqual([{ kind: "rebase" }])
  })

  it("falls back only once per turn", async () => {
    const disabled: string[] = []
    let recoveries = 0
    const failure = await pumpWithRecovery({
      initialSession: fakeSession("gzip-1", [endStreamError(unsupported)], true, disabled),
      controller: controller(),
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      recover: async () => {
        recoveries++
        return fakeSession("gzip-2", [endStreamError(unsupported)], true, disabled)
      },
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CursorProviderError)
    expect((failure as CursorProviderError).code).toBe("unimplemented")
    expect(recoveries).toBe(1)
    expect(disabled).toHaveLength(1)
  })

  it("does not fall back for a Run that did not announce gzip", async () => {
    const disabled: string[] = []
    let recoveries = 0
    const failure = await pumpWithRecovery({
      initialSession: fakeSession("raw", [endStreamError(unsupported)], false, disabled),
      controller: controller(),
      recover: async () => {
        recoveries++
        return fakeSession("unexpected", [turnEnded()], false, disabled)
      },
    }).catch((error: unknown) => error)
    expect((failure as CursorProviderError).code).toBe("unimplemented")
    expect(recoveries).toBe(0)
    expect(disabled).toHaveLength(0)
  })

  it("does not fall back for a failure unrelated to compression", async () => {
    const disabled: string[] = []
    let recoveries = 0
    const failure = await pumpWithRecovery({
      initialSession: fakeSession("other", [endStreamError({ code: "invalid_argument", message: "bad request" })], true, disabled),
      controller: controller(),
      recover: async () => {
        recoveries++
        return fakeSession("unexpected", [turnEnded()], false, disabled)
      },
    }).catch((error: unknown) => error)
    expect((failure as CursorProviderError).code).toBe("invalid_argument")
    expect(recoveries).toBe(0)
    expect(disabled).toHaveLength(0)
  })

  it("stops compressing but does not replay a rejection after visible output", async () => {
    const disabled: string[] = []
    let recoveries = 0
    const failure = await pumpWithRecovery({
      initialSession: fakeSession("after-output", [textDelta("partial"), endStreamError(unsupported)], true, disabled),
      controller: controller(),
      recover: async () => {
        recoveries++
        return fakeSession("unexpected", [turnEnded()], false, disabled)
      },
    }).catch((error: unknown) => error)
    expect((failure as CursorProviderError).code).toBe("unimplemented")
    expect(recoveries).toBe(0)
    expect(disabled).toHaveLength(1)
  })
})

describe("ttft_breakdown", () => {
  const breakdown = {
    server_first_token_ms: 3715.4,
    pre_stream_setup_ms: 204.2,
    wait_for_first_event_ms: 151.9,
    provider_ttft_ms: 1600.1,
    slow_pool_wait_ms: 0,
    client_prep_ms: 0,
    client_clock: false,
  }

  it("decodes Cursor's frame beside the first thinking delta", () => {
    // Captured from Cursor (cursor-stub recording c-steer, 2026-10-07): thinking_delta "The" with ttft_breakdown #8.
    const captured = Buffer.from(
      "0a1122070a035468651001c801a5d0d7c1913442240900a020b11d048940110000255e9e88544019000000e8a4f7e13f2100e0550fd81c8540",
      "hex",
    )
    const asm = decodeMessage<Record<string, any>>("AgentServerMessage", captured)
    expect(asm.interaction_update.thinking_delta.text).toBe("The")
    expect(asm.ttft_breakdown.server_first_token_ms).toBeCloseTo(800.514498, 5)
    expect(asm.ttft_breakdown.pre_stream_setup_ms).toBeCloseTo(82.134666, 5)
    expect(asm.ttft_breakdown.wait_for_first_event_ms).toBeCloseTo(0.56148, 5)
    expect(asm.ttft_breakdown.provider_ttft_ms).toBeCloseTo(675.605498, 5)
    expect(describeTtftBreakdown(asm.ttft_breakdown)).toBe(
      "cursor=125ms model=676ms server_first_token=801ms pre_stream_setup=82ms wait_for_first_event=1ms",
    )
    expect(decodeMessage<Record<string, any>>("AgentServerMessage", encodeMessage("AgentServerMessage", {
      interaction_update: { text_delta: { text: "OK" } },
    })).ttft_breakdown).toBeFalsy()
  })

  it("splits the time to first token between Cursor and the model", () => {
    expect(describeTtftBreakdown(breakdown)).toBe(
      "cursor=2115ms model=1600ms server_first_token=3715ms pre_stream_setup=204ms wait_for_first_event=152ms",
    )
    expect(describeTtftBreakdown({ ...breakdown, slow_pool_wait_ms: 812, client_prep_ms: 3, client_clock: true }))
      .toBe("cursor=2115ms model=1600ms server_first_token=3715ms pre_stream_setup=204ms " +
        "wait_for_first_event=152ms slow_pool_wait=812ms client_prep=3ms client_clock")
    expect(describeTtftBreakdown({ server_first_token_ms: 900 })).toBe(
      "cursor=? model=? server_first_token=900ms pre_stream_setup=? wait_for_first_event=?",
    )
    expect(describeTtftBreakdown({})).toBeUndefined()
    expect(describeTtftBreakdown(null)).toBeUndefined()
  })
})
