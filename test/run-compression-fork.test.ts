import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import http2 from "node:http2"
import net from "node:net"
import { CursorProviderError, CursorTransportError } from "../src/errors.js"
import { connectFrameError, sendRunRequest } from "../src/language-model.js"
import { resetClientVersionCache } from "../src/protocol/client-version.js"
import { decodeFramePayload, encodeFrame, FLAG_GZIP, streamFrames } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { describeTtftBreakdown } from "../src/protocol/ttft.js"
import type { Frame } from "../src/session.js"
import type { BidiStream } from "../src/transport/connect.js"
import {
  bidiRunStream,
  closeCachedHttp2SessionsForTests,
  frameArrival,
  lastFrameArrival,
  resetRunCompressionForTests,
  routeHttp2ConnectionsForTests,
} from "../src/transport/connect.js"

const ORIGIN = "https://agentn.compression-test.cursor.sh"

type ReceivedStream = { headers: http2.IncomingHttpHeaders; frames: Frame[] }
type Answer = "answer" | "gzip-answer" | "end-stream-unimplemented" | "end-stream-internal" | "http-415" | "grpc-12"
const GZIP_CHECKPOINT = encodeMessage("AgentServerMessage", { conversation_checkpoint_update: new Uint8Array(4 * 1024).fill(5) })

async function startFakeCursor() {
  const streams: ReceivedStream[] = []
  const answers: Answer[] = []
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
    const endStream = (error: Record<string, string>) =>
      stream.end(encodeFrame(0x02, new TextEncoder().encode(JSON.stringify({ error }))))
    switch (answers.shift() ?? "answer") {
      case "answer":
        stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
        stream.write(encodeFrame(0x00, new Uint8Array([1])))
        break
      case "gzip-answer":
        stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
        stream.write(encodeFrame(0x00, new Uint8Array([1])))
        stream.end(encodeFrame(FLAG_GZIP, GZIP_CHECKPOINT))
        break
      case "end-stream-unimplemented":
        stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
        endStream({ code: "unimplemented", message: "unknown compression \"gzip\": supported encodings are identity" })
        break
      case "end-stream-internal":
        stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
        endStream({ code: "internal", message: "upstream model error" })
        break
      case "http-415":
        stream.respond({ ":status": 415 }, { endStream: true })
        break
      case "grpc-12":
        stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "12" }, { endStream: true })
        break
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as net.AddressInfo).port
  routeHttp2ConnectionsForTests(() => net.connect(port, "127.0.0.1"))
  return {
    streams,
    answers,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function drain(run: { frames(): AsyncIterable<unknown> }): Promise<void> {
  try {
    for await (const _ of run.frames()) { /* until the Run ends */ }
  } catch { /* a refused Run ends with its error */ }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await sleep(5)
}

describe("Run stream compression (fork)", () => {
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

  it.each(["end-stream-unimplemented", "http-415", "grpc-12"] as const)(
    "sends the origin's later Runs uncompressed after Cursor refuses a gzip Run (%s)",
    async (refusal) => {
      fake.answers.push(refusal)
      const large = new Uint8Array(8 * 1024).fill(3)
      const first = await bidiRunStream("token", { baseURL: ORIGIN })
      const written = first.write(large)
      await drain(first)
      await written
      expect(first.compressionRejected?.()).toBe(true)

      const second = await bidiRunStream("token", { baseURL: ORIGIN })
      second.write(large)
      await until(() => fake.streams[1]?.frames.length === 1)

      expect(fake.streams[0]!.headers["connect-content-encoding"]).toBe("gzip")
      expect(fake.streams[1]!.headers["connect-content-encoding"]).toBeUndefined()
      expect(fake.streams[1]!.frames[0]!.flags).toBe(0x00)
      expect(fake.streams[1]!.frames[0]!.payload).toEqual(large)
      expect(second.compressionRejected?.()).toBe(false)
      second.end()
    },
  )

  it("numbers each frame Cursor sends on arrival, gzip frames included, for the reader that gunzips it", async () => {
    fake.answers.push("gzip-answer")
    const before = lastFrameArrival()
    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    run.write(new Uint8Array([9]))
    const frames = run.frames()[Symbol.asyncIterator]()
    const received = [(await frames.next()).value as Frame, (await frames.next()).value as Frame]
    run.destroy()

    expect(received.map((frame) => frame.flags)).toEqual([0x00, FLAG_GZIP])
    const arrivals = received.map((frame) => frameArrival(frame)!)
    expect(arrivals[0]!).toBeGreaterThan(before)
    expect(arrivals[1]!).toBeGreaterThan(arrivals[0]!)
    expect(decodeFramePayload(received[1]!)).toEqual(GZIP_CHECKPOINT)
  })

  it("keeps compressing after a failure unrelated to compression", async () => {
    fake.answers.push("end-stream-internal")
    const first = await bidiRunStream("token", { baseURL: ORIGIN })
    const written = first.write(new Uint8Array(8 * 1024).fill(3))
    await drain(first)
    await written
    expect(first.compressionRejected?.()).toBe(false)

    const second = await bidiRunStream("token", { baseURL: ORIGIN })
    second.write(new Uint8Array(8 * 1024).fill(3))
    await until(() => fake.streams[1]?.frames.length === 1)
    expect(fake.streams[1]!.headers["connect-content-encoding"]).toBe("gzip")
    expect(fake.streams[1]!.frames[0]!.flags).toBe(FLAG_GZIP)
    second.end()
  })
})

describe("Connect frame errors", () => {
  it("keeps Cursor's error message", () => {
    const error = connectFrameError(JSON.stringify({ error: { code: "internal", message: "boom" } }))
    expect(error.serverMessage).toBe("boom")
  })
})

function writeStream(name: string, log: string[], outcome: "ok" | "fail", refused = false): BidiStream {
  return {
    write(message: Uint8Array) {
      log.push(`${name} write ${message.length}`)
      if (outcome === "fail") throw new CursorTransportError(`${name} closed before drain`, { transient: false, replaySafe: false })
      return true
    },
    compressionRejected: () => refused,
    end() {},
    frames: () => ({ async *[Symbol.asyncIterator]() {} }),
    destroy() { log.push(`${name} destroy`) },
    isClosed: () => false,
    onTerminal: () => () => {},
  }
}

describe("sendRunRequest", () => {
  const request = new Uint8Array(4096)

  it("keeps the stream the request went out on", async () => {
    const log: string[] = []
    const first = writeStream("first", log, "ok")
    expect(await sendRunRequest(first, request, "initial Run request", async () => writeStream("next", log, "ok"))).toBe(first)
    expect(log).toEqual(["first write 4096"])
  })

  it("sends a request Cursor refused while it uploaded once more on a new stream", async () => {
    const log: string[] = []
    const next = writeStream("next", log, "ok")
    const sent = await sendRunRequest(writeStream("first", log, "fail", true), request, "initial Run request", async () => next)
    expect(sent).toBe(next)
    expect(log).toEqual(["first write 4096", "first destroy", "next write 4096"])
  })

  it("does not resend after a failure Cursor did not tie to compression", async () => {
    const log: string[] = []
    const failure = await sendRunRequest(writeStream("first", log, "fail"), request, "initial Run request",
      async () => writeStream("next", log, "ok")).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CursorProviderError)
    expect(log).toEqual(["first write 4096"])
  })

  it("resends only once", async () => {
    const log: string[] = []
    const failure = await sendRunRequest(writeStream("first", log, "fail", true), request, "initial Run request",
      async () => writeStream("next", log, "fail", true)).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CursorProviderError)
    expect(log).toEqual(["first write 4096", "first destroy", "next write 4096", "next destroy"])
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
