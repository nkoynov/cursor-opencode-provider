import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test"
import http2 from "node:http2"
import net from "node:net"
import { CursorProviderError } from "../src/errors.js"
import { encodeFrame } from "../src/protocol/framing.js"
import { resetClientVersionCache } from "../src/protocol/client-version.js"
import {
  awaitingRunAnswersForTests,
  bidiRunStream,
  closeCachedHttp2SessionsForTests,
  getSession,
  HTTP2_SESSION_LIVE_WINDOW_MS,
  MAX_HTTP2_SESSIONS_PER_ORIGIN,
  openRunStreamsForTests,
  receivedRecently,
  RUNS_PER_HTTP2_SESSION,
  resetRunCompressionForTests,
  routeHttp2ConnectionsForTests,
  setHttp2KeepaliveForTests,
  type BidiStream,
} from "../src/transport/connect.js"

const ORIGIN = "https://agentn.reuse-test.cursor.sh"

type Answer =
  | "answer"
  | "refuse"
  | "goaway-unprocessed"
  | "goaway-processed"
  | "answer-then-drop"
  | "cancel"
  | "answer-then-hold"
  | "answer-then-trickle"
  | "hold"
  | "hold-then-cancel"
type ServerStream = { answer: Answer; connection: number; bytes: number }

/** An h2c "Cursor" behind a TCP proxy that can cut a client connection before forwarding. */
async function startFakeCursor() {
  const answers: Answer[] = []
  const streams: ServerStream[] = []
  const serverSessions = new Map<http2.Http2Session, number>()
  const clients = new Set<net.Socket>()
  const clientsByConnection = new Map<number, net.Socket>()
  const held: Array<() => void> = []
  const muted = new Set<number>()
  let connections = 0
  let dropNextRequest: number | undefined
  const dropNextRequestOn = new Map<number, number>()
  const dropAll = () => {
    for (const client of clients) client.destroy()
  }

  const server = http2.createServer()
  server.on("session", (session) => serverSessions.set(session, serverSessions.size))
  server.on("stream", (stream) => {
    const answer = answers.shift() ?? "answer"
    const record: ServerStream = { answer, connection: serverSessions.get(stream.session!) ?? -1, bytes: 0 }
    streams.push(record)
    stream.on("data", (chunk: Buffer) => { record.bytes += chunk.length })
    stream.on("end", () => { try { stream.end() } catch { /* already closed */ } })
    stream.on("error", () => {})
    switch (answer) {
      case "answer":
      case "answer-then-drop":
        stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
        stream.write(encodeFrame(0x00, new Uint8Array([1, 2, 3])))
        if (answer === "answer-then-drop") setTimeout(dropAll, 20)
        break
      case "refuse":
        stream.close(http2.constants.NGHTTP2_REFUSED_STREAM)
        break
      case "goaway-unprocessed":
        stream.session!.goaway(http2.constants.NGHTTP2_NO_ERROR, Math.max(0, stream.id! - 2))
        break
      case "goaway-processed":
        stream.session!.goaway(http2.constants.NGHTTP2_NO_ERROR, stream.id!)
        setTimeout(dropAll, 20)
        break
      case "cancel":
        stream.close(http2.constants.NGHTTP2_CANCEL)
        break
      case "answer-then-hold":
        stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
        stream.write(encodeFrame(0x00, new Uint8Array([1, 2, 3])))
        held.push(() => stream.write(encodeFrame(0x00, new Uint8Array([4, 5, 6]))))
        break
      case "answer-then-trickle": {
        stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
        const trickle = setInterval(() => {
          try { stream.write(encodeFrame(0x00, new Uint8Array([1]))) } catch { clearInterval(trickle) }
        }, 25)
        stream.on("close", () => clearInterval(trickle))
        break
      }
      case "hold":
        held.push(() => {
          stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
          stream.write(encodeFrame(0x00, new Uint8Array([1, 2, 3])))
        })
        break
      case "hold-then-cancel":
        held.push(() => stream.close(http2.constants.NGHTTP2_CANCEL))
        break
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const serverPort = (server.address() as net.AddressInfo).port

  const proxy = net.createServer((client) => {
    clientsByConnection.set(connections, client)
    connections++
    clients.add(client)
    const upstream = net.connect(serverPort, "127.0.0.1")
    const connection = connections - 1
    let swallowing = false
    client.on("data", (chunk) => {
      if (swallowing || muted.has(connection)) return
      const dropHere = dropNextRequestOn.get(connection)
      if (dropHere !== undefined || dropNextRequest !== undefined) {
        const afterMs = dropHere ?? dropNextRequest!
        if (dropHere !== undefined) dropNextRequestOn.delete(connection)
        else dropNextRequest = undefined
        swallowing = true
        client.pause()
        setTimeout(() => { client.destroy(); upstream.destroy() }, afterMs)
        return
      }
      upstream.write(chunk)
    })
    upstream.on("data", (chunk) => client.write(chunk))
    client.on("close", () => { clients.delete(client); upstream.destroy() })
    upstream.on("close", () => client.destroy())
    client.on("error", () => {})
    upstream.on("error", () => {})
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  const proxyPort = (proxy.address() as net.AddressInfo).port
  routeHttp2ConnectionsForTests(() => net.connect(proxyPort, "127.0.0.1"))

  return {
    answers,
    streams,
    get connections() { return connections },
    /**
     * The next bytes a client sends are never forwarded and its connection is cut `afterMs` later, as a
     * stale one would be; meanwhile nothing more is read from it.
     */
    dropNextRequest(afterMs = 0, connection?: number) {
      if (connection === undefined) dropNextRequest = afterMs
      else dropNextRequestOn.set(connection, afterMs)
    },
    dropConnection(index: number) { clientsByConnection.get(index)?.destroy() },
    /** Stops forwarding what the client sends on a connection, so Cursor sees neither its pings nor its GOAWAY. */
    muteClient(index: number) { muted.add(index) },
    /** Stops reading what the client sends on a connection, so its uploads back up as on a crawling uplink. */
    stallClient(index: number) { clientsByConnection.get(index)?.pause() },
    resumeClient(index: number) { clientsByConnection.get(index)?.resume() },
    /** Sends the client a NO_ERROR GOAWAY that Node's server API cannot (it turns last stream id 0 into the last processed one). */
    injectGoaway(index: number, lastStreamId: number) {
      const frame = Buffer.alloc(9 + 8)
      frame.writeUIntBE(8, 0, 3)
      frame[3] = 0x7
      frame.writeUInt32BE(lastStreamId, 9)
      clientsByConnection.get(index)?.write(frame)
    },
    /** Answers, continues or cancels the streams held so far. */
    release() {
      for (const next of held.splice(0)) next()
    },
    /** Answers, continues or cancels only the earliest stream still held. */
    releaseFirst() {
      held.shift()?.()
    },
    async close() {
      dropAll()
      await new Promise((resolve) => proxy.close(resolve))
      for (const session of serverSessions.keys()) session.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await sleep(5)
}

function nextFrame(run: BidiStream) {
  return run.frames()[Symbol.asyncIterator]().next()
}

// Bun's `expect(promise).rejects` can stall socket events while it waits, so rejections are captured instead.
function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error)
}

/** A Run that Cursor answered and that ended, leaving its connection cached and just used. */
async function completedRun(): Promise<void> {
  const run = await bidiRunStream("token", { baseURL: ORIGIN })
  run.write(new Uint8Array([7]))
  expect((await nextFrame(run)).done).toBe(false)
  run.end()
  await sleep(50)
}

let fake: Awaited<ReturnType<typeof startFakeCursor>>
const savedClientVersion = process.env.CURSOR_CLIENT_VERSION

beforeEach(async () => {
  process.env.CURSOR_CLIENT_VERSION = "cli-reuse-test-1"
  resetClientVersionCache()
  fake = await startFakeCursor()
})

afterEach(async () => {
  setSystemTime()
  setHttp2KeepaliveForTests()
  resetRunCompressionForTests()
  closeCachedHttp2SessionsForTests()
  routeHttp2ConnectionsForTests()
  await fake.close()
  if (savedClientVersion === undefined) delete process.env.CURSOR_CLIENT_VERSION
  else process.env.CURSOR_CLIENT_VERSION = savedClientVersion
  resetClientVersionCache()
})

describe("receivedRecently", () => {
  it("trusts a connection only within the live window after it last received data", () => {
    expect(receivedRecently(undefined, 1_000)).toBe(false)
    expect(receivedRecently(1_000, 1_000 + HTTP2_SESSION_LIVE_WINDOW_MS - 1)).toBe(true)
    expect(receivedRecently(1_000, 1_000 + HTTP2_SESSION_LIVE_WINDOW_MS)).toBe(false)
    expect(receivedRecently(1_000, 999)).toBe(false)
  })
})

describe("Run connection reuse", () => {
  it("opens a Run on a connection that just received data without pinging it", async () => {
    await completedRun()
    const ping = spyOn(await getSession(ORIGIN), "ping")

    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    run.write(new Uint8Array([8]))
    expect((await nextFrame(run)).done).toBe(false)

    expect(ping).not.toHaveBeenCalled()
    expect(fake.connections).toBe(1)
    expect(fake.streams.map((stream) => stream.connection)).toEqual([0, 0])
    run.end()
  })

  it("pings a connection that has been idle longer than the live window", async () => {
    await completedRun()
    const ping = spyOn(await getSession(ORIGIN), "ping")
    setSystemTime(new Date(Date.now() + HTTP2_SESSION_LIVE_WINDOW_MS + 1_000))

    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    run.write(new Uint8Array([8]))
    expect((await nextFrame(run)).done).toBe(false)

    expect(ping).toHaveBeenCalledTimes(1)
    expect(fake.connections).toBe(1)
    run.end()
  })

  it("sends a Run again on a new connection when the reused one was dead", async () => {
    await completedRun()
    fake.dropNextRequest()

    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    const request = new Uint8Array(1_000).fill(5)
    run.write(request)
    expect((await nextFrame(run)).done).toBe(false)

    expect(fake.connections).toBe(2)
    expect(fake.streams.map((stream) => [stream.connection, stream.bytes])).toEqual([
      [0, 6],
      [1, 5 + request.length],
    ])
    run.end()
  })

  it.each(["refuse", "goaway-unprocessed"] as const)(
    "sends a Run again on a new connection after Cursor did not take it (%s)",
    async (answer) => {
      await completedRun()
      fake.answers.push(answer)

      const run = await bidiRunStream("token", { baseURL: ORIGIN })
      run.write(new Uint8Array([8]))
      expect((await nextFrame(run)).done).toBe(false)

      expect(fake.connections).toBe(2)
      expect(fake.streams.map((stream) => [stream.answer, stream.connection])).toEqual([
        ["answer", 0],
        [answer, 0],
        ["answer", 1],
      ])
      run.end()
    },
  )

  it("releases the connection a Run left for a new one, and holds the new one only while the Run is open", async () => {
    await completedRun()
    const calls = new Map<http2.ClientHttp2Session, string[]>()
    const watch = (session: http2.ClientHttp2Session) => {
      const log: string[] = []
      calls.set(session, log)
      const ref = session.ref.bind(session)
      const unref = session.unref.bind(session)
      session.ref = () => { log.push("ref"); ref() }
      session.unref = () => { log.push("unref"); unref() }
      return session
    }
    const first = watch(await getSession(ORIGIN))
    const connect = http2.connect.bind(http2)
    const connectSpy = spyOn(http2, "connect").mockImplementation(((...args: Parameters<typeof http2.connect>) =>
      watch(connect(...args))) as typeof http2.connect)
    try {
      fake.answers.push("refuse")
      const run = await bidiRunStream("token", { baseURL: ORIGIN })
      run.write(new Uint8Array([8]))
      expect((await nextFrame(run)).done).toBe(false)

      const second = [...calls.keys()].find((session) => session !== first)!
      expect(fake.connections).toBe(2)
      expect(calls.get(first)!.at(-1)).toBe("unref")
      expect(calls.get(second)!.at(-1)).toBe("ref")
      run.end()
      await until(() => calls.get(second)!.at(-1) === "unref")
      expect(calls.get(second)!.at(-1)).toBe("unref")
    } finally {
      connectSpy.mockRestore()
    }
  })

  it("follows the new connection when the dead one held a request still draining", async () => {
    // Uncompressed, so the request stays larger than the socket buffers on the wire.
    resetRunCompressionForTests(ORIGIN)
    await completedRun()
    fake.dropNextRequest(200)

    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    // Larger than the socket buffers, so the write is still waiting to drain when the connection dies.
    const request = new Uint8Array(16_000_000).fill(5)
    expect(run.write(request)).toBe(false)
    await run.waitForDrain!()
    expect((await nextFrame(run)).done).toBe(false)
    await until(() => fake.streams.at(-1)?.bytes === 5 + request.length)

    expect(fake.connections).toBe(2)
    expect(fake.streams.at(-1)).toEqual({ answer: "answer", connection: 1, bytes: 5 + request.length })
    run.end()
  })

  it.each(["answer-then-drop", "goaway-processed", "cancel"] as const)(
    "does not send a Run again once Cursor may have taken it (%s)",
    async (answer) => {
      await completedRun()
      fake.answers.push(answer)

      const run = await bidiRunStream("token", { baseURL: ORIGIN })
      run.write(new Uint8Array([8]))
      const frames = run.frames()[Symbol.asyncIterator]()
      if (answer === "answer-then-drop") expect((await frames.next()).done).toBe(false)
      expect(await failureOf(frames.next())).toBeInstanceOf(CursorProviderError)
      await sleep(50)

      expect(fake.connections).toBe(1)
      expect(fake.streams.map((stream) => stream.answer)).toEqual(["answer", answer])
    },
  )

  it("does not send a Run again from a connection that answered its ping", async () => {
    await completedRun()
    setSystemTime(new Date(Date.now() + HTTP2_SESSION_LIVE_WINDOW_MS + 1_000))
    fake.answers.push("refuse")

    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    run.write(new Uint8Array([8]))
    expect(await failureOf(nextFrame(run))).toBeInstanceOf(CursorProviderError)
    await sleep(50)

    expect(fake.connections).toBe(1)
    expect(fake.streams.map((stream) => stream.answer)).toEqual(["answer", "refuse"])
  })

  it("sends a Run again only once", async () => {
    await completedRun()
    fake.dropNextRequest()
    fake.answers.push("refuse")

    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    run.write(new Uint8Array([8]))
    expect(await failureOf(nextFrame(run))).toBeInstanceOf(CursorProviderError)
    await sleep(50)

    expect(fake.connections).toBe(2)
    expect(fake.streams.map((stream) => [stream.answer, stream.connection])).toEqual([
      ["answer", 0],
      ["refuse", 1],
    ])
  })
})

describe("Runs spread over connections", () => {
  async function streamingRun() {
    fake.answers.push("answer-then-hold")
    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    run.write(new Uint8Array([8]))
    expect((await nextFrame(run)).done).toBe(false)
    return run
  }

  it("opens a new connection for a Run once the first carries its share of open Runs", async () => {
    const first = []
    for (let i = 0; i < RUNS_PER_HTTP2_SESSION; i++) first.push(await streamingRun())
    const next = await streamingRun()

    expect(fake.connections).toBe(2)
    expect(fake.streams.map((stream) => stream.connection)).toEqual([
      ...Array(RUNS_PER_HTTP2_SESSION).fill(0),
      1,
    ])
    for (const run of [...first, next]) run.end()
  })

  it("spreads Runs that start together, before any connection is open", async () => {
    const count = RUNS_PER_HTTP2_SESSION + 2
    for (let i = 0; i < count; i++) fake.answers.push("answer-then-hold")
    const runs = await Promise.all(Array.from({ length: count }, () => bidiRunStream("token", { baseURL: ORIGIN })))
    for (const run of runs) run.write(new Uint8Array([8]))
    for (const run of runs) expect((await nextFrame(run)).done).toBe(false)

    expect(fake.connections).toBe(2)
    const perConnection = fake.streams.reduce<number[]>((counts, stream) => {
      counts[stream.connection] = (counts[stream.connection] ?? 0) + 1
      return counts
    }, [])
    expect(perConnection).toEqual([RUNS_PER_HTTP2_SESSION, 2])
    for (const run of runs) run.end()
  })

  it("goes back to the first connection once it has room again", async () => {
    const first = [await streamingRun()]
    const firstConnection = await getSession(ORIGIN)
    for (let i = 1; i < RUNS_PER_HTTP2_SESSION; i++) first.push(await streamingRun())
    const spilled = await streamingRun()
    first[0]!.end()
    await until(() => openRunStreamsForTests(firstConnection) === RUNS_PER_HTTP2_SESSION - 1)
    expect(openRunStreamsForTests(firstConnection)).toBe(RUNS_PER_HTTP2_SESSION - 1)

    const next = await streamingRun()

    expect(fake.connections).toBe(2)
    expect(fake.streams.at(-1)!.connection).toBe(0)
    for (const run of [...first.slice(1), spilled, next]) run.end()
  })

  it("keeps the connection count bounded and shares the least loaded once all are full", async () => {
    const runs = []
    const total = RUNS_PER_HTTP2_SESSION * MAX_HTTP2_SESSIONS_PER_ORIGIN + 1
    for (let i = 0; i < total; i++) runs.push(await streamingRun())

    expect(fake.connections).toBe(MAX_HTTP2_SESSIONS_PER_ORIGIN)
    for (const run of runs) run.end()
  })
})

describe("Run on a connection where Cursor left a Run unanswered", () => {
  /**
   * One Run streams on the cached connection while Cursor leaves another without response headers
   * for a live window; then the streaming Run receives data, so the connection received data recently.
   */
  async function unansweredBesideStreaming(options: { closeUnanswered: boolean; mute: boolean }) {
    await completedRun()
    fake.answers.push("answer-then-hold", "hold")
    const streaming = await bidiRunStream("token", { baseURL: ORIGIN })
    streaming.write(new Uint8Array([8]))
    const streamingFrames = streaming.frames()[Symbol.asyncIterator]()
    expect((await streamingFrames.next()).done).toBe(false)
    const abandon = new AbortController()
    const unanswered = await bidiRunStream("token", { baseURL: ORIGIN, signal: abandon.signal })
    unanswered.write(new Uint8Array([9]))
    await until(() => fake.streams.length === 3)
    const connection = await getSession(ORIGIN)
    if (options.mute) fake.muteClient(0)
    setSystemTime(new Date(Date.now() + HTTP2_SESSION_LIVE_WINDOW_MS + 1_000))
    if (options.closeUnanswered) {
      abandon.abort()
      await until(() => awaitingRunAnswersForTests(connection) === 0)
      expect(awaitingRunAnswersForTests(connection)).toBe(0)
    }
    fake.releaseFirst()
    expect((await streamingFrames.next()).done).toBe(false)
    return { connection, streaming, unanswered }
  }

  it("pings the connection while that Run is still waiting", async () => {
    const { connection, streaming, unanswered } = await unansweredBesideStreaming({ closeUnanswered: false, mute: false })
    const ping = spyOn(connection, "ping")

    const next = await bidiRunStream("token", { baseURL: ORIGIN })
    next.write(new Uint8Array([10]))
    expect((await nextFrame(next)).done).toBe(false)

    expect(ping).toHaveBeenCalledTimes(1)
    expect(fake.connections).toBe(1)
    fake.release()
    expect((await nextFrame(unanswered)).done).toBe(false)
    streaming.end()
    unanswered.end()
    next.end()
  })

  it("opens the next Run on a new connection when that Run was given up and the ping goes unanswered", async () => {
    const { connection, streaming } = await unansweredBesideStreaming({ closeUnanswered: true, mute: true })

    const next = await bidiRunStream("token", { baseURL: ORIGIN, pingTimeoutMs: 100 })
    next.write(new Uint8Array([10]))
    expect((await nextFrame(next)).done).toBe(false)

    expect(connection.closed).toBe(true)
    expect(connection.destroyed).toBe(false)
    expect(fake.connections).toBe(2)
    expect(fake.streams.at(-1)).toMatchObject({ answer: "answer", connection: 1 })
    streaming.end()
    next.end()
  })

  it("reuses the connection without a ping again once it answers one", async () => {
    const { connection, streaming } = await unansweredBesideStreaming({ closeUnanswered: true, mute: false })
    const ping = spyOn(connection, "ping")

    const first = await bidiRunStream("token", { baseURL: ORIGIN })
    first.write(new Uint8Array([10]))
    expect((await nextFrame(first)).done).toBe(false)
    const second = await bidiRunStream("token", { baseURL: ORIGIN })
    second.write(new Uint8Array([11]))
    expect((await nextFrame(second)).done).toBe(false)

    expect(ping).toHaveBeenCalledTimes(1)
    expect(fake.connections).toBe(1)
    streaming.end()
    first.end()
    second.end()
  })

  it("does not ping for an unanswered Run given up within the live window", async () => {
    await completedRun()
    fake.answers.push("hold")
    const abandon = new AbortController()
    const abandoned = await bidiRunStream("token", { baseURL: ORIGIN, signal: abandon.signal })
    abandoned.write(new Uint8Array([8]))
    await until(() => fake.streams.length === 2)
    const connection = await getSession(ORIGIN)
    abandon.abort()
    await until(() => awaitingRunAnswersForTests(connection) === 0)
    expect(awaitingRunAnswersForTests(connection)).toBe(0)
    await completedRun()
    const ping = spyOn(await getSession(ORIGIN), "ping")

    const next = await bidiRunStream("token", { baseURL: ORIGIN })
    next.write(new Uint8Array([9]))
    expect((await nextFrame(next)).done).toBe(false)

    expect(ping).not.toHaveBeenCalled()
    expect(fake.connections).toBe(1)
    next.end()
  })
})

describe("Run on a connection whose ping fails for another Run", () => {
  /**
   * Opens a Run without a ping on the cached connection; then Cursor stops receiving on it, so the next
   * Run's ping times out.
   */
  async function runThenFailedPing(answer: Answer) {
    await completedRun()
    fake.answers.push(answer)
    const sibling = await bidiRunStream("token", { baseURL: ORIGIN })
    sibling.write(new Uint8Array([8]))
    const frames = sibling.frames()[Symbol.asyncIterator]()
    if (answer === "answer-then-hold") expect((await frames.next()).done).toBe(false)
    else await until(() => fake.streams.length === 2)
    const connection = await getSession(ORIGIN)
    fake.muteClient(0)
    setSystemTime(new Date(Date.now() + HTTP2_SESSION_LIVE_WINDOW_MS + 1_000))

    const next = await bidiRunStream("token", { baseURL: ORIGIN, pingTimeoutMs: 100 })
    next.write(new Uint8Array([9]))
    expect((await nextFrame(next)).done).toBe(false)
    expect(connection.closed).toBe(true)
    expect(connection.destroyed).toBe(false)
    return { sibling, frames, next }
  }

  it("keeps streaming a Run Cursor already answered", async () => {
    const { sibling, frames, next } = await runThenFailedPing("answer-then-hold")
    fake.release()

    expect((await frames.next()).done).toBe(false)
    expect(fake.connections).toBe(2)
    expect(fake.streams.map((stream) => [stream.answer, stream.connection])).toEqual([
      ["answer", 0],
      ["answer-then-hold", 0],
      ["answer", 1],
    ])
    sibling.end()
    next.end()
  })

  it("leaves a Run Cursor has not answered yet on its connection instead of sending it again", async () => {
    const { sibling, frames, next } = await runThenFailedPing("hold")
    fake.release()

    expect((await frames.next()).done).toBe(false)
    expect(fake.streams.map((stream) => [stream.answer, stream.connection])).toEqual([
      ["answer", 0],
      ["hold", 0],
      ["answer", 1],
    ])
    sibling.end()
    next.end()
  })

  it("does not send that Run again when Cursor then cancels it", async () => {
    const { frames, next } = await runThenFailedPing("hold-then-cancel")
    fake.release()

    expect(await failureOf(frames.next())).toBeInstanceOf(CursorProviderError)
    await sleep(50)
    expect(fake.streams.map((stream) => [stream.answer, stream.connection])).toEqual([
      ["answer", 0],
      ["hold-then-cancel", 0],
      ["answer", 1],
    ])
    next.end()
  })

  it("sends that Run again when its connection then dies before Cursor answers", async () => {
    const { sibling, frames, next } = await runThenFailedPing("hold")
    fake.dropConnection(0)

    expect((await frames.next()).done).toBe(false)
    expect(fake.streams.map((stream) => [stream.answer, stream.connection, stream.bytes])).toEqual([
      ["answer", 0, 6],
      ["hold", 0, 6],
      ["answer", 1, 6],
      ["answer", 1, 6],
    ])
    sibling.end()
    next.end()
  })
})

// The host these run on can be heavily loaded; each test still bounds its own waits.
const SLOW_TEST_MS = 15_000
// Random, so gzip leaves it above the large-upload threshold.
const LARGE_RESULT_BYTES = 96 * 1024

/** Resolves to "pending" when `promise` has not settled within `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | "pending"> {
  return Promise.race([promise, sleep(ms).then(() => "pending" as const)])
}

describe("Runs on a connection Cursor drains with a GOAWAY", () => {
  it("sends the first Run on a fresh connection again at once when the GOAWAY excludes it", async () => {
    fake.answers.push("hold")
    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    run.write(new Uint8Array([8]))
    await until(() => fake.streams[0]?.bytes === 6)
    await sleep(20)

    fake.injectGoaway(0, 0)
    expect((await within(nextFrame(run).then((frame) => frame.done), 3_000))).toBe(false)

    expect(fake.connections).toBe(2)
    expect(fake.streams.map((stream) => [stream.answer, stream.connection, stream.bytes])).toEqual([
      ["hold", 0, 6],
      ["answer", 1, 6],
    ])
    run.end()
  }, SLOW_TEST_MS)

  it("sends every Run opened with the connection again when the GOAWAY excludes them all", async () => {
    fake.answers.push("hold", "hold", "hold")
    const runs = await Promise.all([1, 2, 3].map(() => bidiRunStream("token", { baseURL: ORIGIN })))
    for (const run of runs) run.write(new Uint8Array([8]))
    await until(() => fake.streams.length === 3 && fake.streams.every((stream) => stream.bytes === 6))
    await sleep(20)

    fake.injectGoaway(0, 0)
    for (const run of runs) expect((await within(nextFrame(run).then((frame) => frame.done), 3_000))).toBe(false)

    expect(fake.connections).toBe(2)
    expect(fake.streams.map((stream) => [stream.answer, stream.connection])).toEqual([
      ["hold", 0], ["hold", 0], ["hold", 0],
      ["answer", 1], ["answer", 1], ["answer", 1],
    ])
    for (const run of runs) run.end()
  }, SLOW_TEST_MS)

  it("lets Runs at or below the last stream id finish on the draining connection while one above it moves", async () => {
    await completedRun()
    fake.answers.push("answer-then-hold", "goaway-unprocessed")
    // Each Run pings first, so neither counts as reused on recent traffic alone.
    setSystemTime(new Date(Date.now() + HTTP2_SESSION_LIVE_WINDOW_MS + 1_000))
    const below = await bidiRunStream("token", { baseURL: ORIGIN })
    below.write(new Uint8Array([8]))
    const belowFrames = below.frames()[Symbol.asyncIterator]()
    expect((await belowFrames.next()).done).toBe(false)
    const draining = await getSession(ORIGIN)
    setSystemTime(new Date(Date.now() + 2 * (HTTP2_SESSION_LIVE_WINDOW_MS + 1_000)))

    const above = await bidiRunStream("token", { baseURL: ORIGIN })
    above.write(new Uint8Array([9]))
    expect((await nextFrame(above)).done).toBe(false)

    expect(draining.closed).toBe(true)
    fake.release()
    expect((await belowFrames.next()).done).toBe(false)
    expect(fake.streams.map((stream) => [stream.answer, stream.connection])).toEqual([
      ["answer", 0],
      ["answer-then-hold", 0],
      ["goaway-unprocessed", 0],
      ["answer", 1],
    ])
    below.end()
    above.end()
  }, SLOW_TEST_MS)

  it("keeps the one resend after a loss when a GOAWAY moves a Run onto a lane reused without its ping", async () => {
    const lane0: BidiStream[] = []
    let lane0Session: http2.ClientHttp2Session | undefined
    for (let i = 0; i < RUNS_PER_HTTP2_SESSION; i++) {
      fake.answers.push("answer-then-hold")
      const run = await bidiRunStream("token", { baseURL: ORIGIN })
      run.write(new Uint8Array([8]))
      expect((await nextFrame(run)).done).toBe(false)
      lane0.push(run)
      lane0Session ??= await getSession(ORIGIN)
    }
    fake.answers.push("hold")
    const moved = await bidiRunStream("token", { baseURL: ORIGIN })
    moved.write(new Uint8Array([9]))
    await until(() => fake.streams.length === RUNS_PER_HTTP2_SESSION + 1 && fake.streams.at(-1)!.bytes === 6)
    lane0[0]!.end()
    await until(() => openRunStreamsForTests(lane0Session!) === RUNS_PER_HTTP2_SESSION - 1)
    await sleep(20)
    const lane0Request = spyOn(lane0Session!, "request")
    fake.dropNextRequest(0, 0)

    fake.injectGoaway(1, 0)
    expect(await within(nextFrame(moved).then((frame) => frame.done), 3_000)).toBe(false)

    expect(lane0Request).toHaveBeenCalledTimes(1)
    expect(fake.connections).toBe(3)
    expect(fake.streams.at(-1)).toMatchObject({ answer: "answer", connection: 2 })
    for (const run of [...lane0.slice(1), moved]) run.end()
  }, SLOW_TEST_MS)

  it("does not send a Run again when the GOAWAY says Cursor may have processed it", async () => {
    fake.answers.push("goaway-processed")

    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    run.write(new Uint8Array([8]))
    expect(await failureOf(nextFrame(run))).toBeInstanceOf(CursorProviderError)
    await sleep(50)

    expect(fake.connections).toBe(1)
  }, SLOW_TEST_MS)
})

describe("Keepalive PINGs", () => {
  beforeEach(() => setHttp2KeepaliveForTests({ intervalMs: 100, timeoutMs: 200 }))

  it("pings an idle connection and keeps using it while it answers", async () => {
    await completedRun()
    const connection = await getSession(ORIGIN)
    const ping = spyOn(connection, "ping")

    await sleep(450)
    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    run.write(new Uint8Array([8]))
    expect((await nextFrame(run)).done).toBe(false)

    expect(ping.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(connection.destroyed).toBe(false)
    expect(fake.connections).toBe(1)
    run.end()
  }, SLOW_TEST_MS)

  it("fails the Runs of a busy connection that stops answering at all, and opens the next Run elsewhere", async () => {
    const frames = []
    for (const request of [8, 9]) {
      fake.answers.push("answer-then-hold")
      const busy = await bidiRunStream("token", { baseURL: ORIGIN })
      busy.write(new Uint8Array([request]))
      frames.push(busy.frames()[Symbol.asyncIterator]())
      expect((await frames.at(-1)!.next()).done).toBe(false)
    }
    const connection = await getSession(ORIGIN)
    fake.muteClient(0)

    const failures = await Promise.all(frames.map((run) => within(failureOf(run.next()), 3_000)))
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(CursorProviderError)
      expect((failure as CursorProviderError).code).toBe("CURSOR_HTTP2_PING_TIMEOUT")
    }
    // Each Run's recovery marks its own error; a shared object would carry one Run's verdict to the other.
    expect(failures[0]).not.toBe(failures[1])
    expect(connection.destroyed).toBe(true)

    const next = await bidiRunStream("token", { baseURL: ORIGIN })
    next.write(new Uint8Array([9]))
    expect((await nextFrame(next)).done).toBe(false)
    expect(fake.connections).toBe(2)
    next.end()
  }, SLOW_TEST_MS)

  it("drops an idle connection that stops answering before a Run is sent on it", async () => {
    await completedRun()
    const connection = await getSession(ORIGIN)
    fake.muteClient(0)
    await until(() => connection.destroyed, 3_000)
    expect(connection.destroyed).toBe(true)

    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    run.write(new Uint8Array([8]))
    expect(await within(nextFrame(run).then((frame) => frame.done), 3_000)).toBe(false)
    expect(fake.connections).toBe(2)
    run.end()
  }, SLOW_TEST_MS)

  it("only moves new Runs off a connection whose PING may wait behind a large upload, then drops it once no upload is left", async () => {
    // Writes 100 ms apart must stay well inside the upload window on a loaded host.
    setHttp2KeepaliveForTests({ intervalMs: 100, timeoutMs: 1_000 })
    fake.answers.push("answer-then-hold")
    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    run.write(new Uint8Array([8]))
    const frames = run.frames()[Symbol.asyncIterator]()
    expect((await frames.next()).done).toBe(false)
    const connection = await getSession(ORIGIN)
    fake.muteClient(0)
    const failure = failureOf(frames.next())

    for (let i = 0; i < 20; i++) {
      run.write(crypto.getRandomValues(new Uint8Array(LARGE_RESULT_BYTES)))
      await sleep(100)
    }
    expect(await within(failure, 1)).toBe("pending")
    expect(connection.closed).toBe(true)
    expect(connection.destroyed).toBe(false)

    // Cursor never opened the flow-control window, so the upload ends only with its Run.
    run.destroy()
    await until(() => connection.destroyed, 3_000)
    expect(connection.destroyed).toBe(true)
  }, SLOW_TEST_MS)

  it("keeps a connection while one upload stays blocked past the timeout", async () => {
    setHttp2KeepaliveForTests({ intervalMs: 100, timeoutMs: 500 })
    resetRunCompressionForTests(ORIGIN)
    fake.answers.push("answer-then-hold")
    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    run.write(new Uint8Array([8]))
    const frames = run.frames()[Symbol.asyncIterator]()
    expect((await frames.next()).done).toBe(false)
    const connection = await getSession(ORIGIN)
    fake.stallClient(0)
    const failure = failureOf(frames.next())

    expect(run.write(new Uint8Array(16_000_000).fill(5))).toBe(false)
    const drained = run.waitForDrain!()
    await sleep(2_000)
    expect(await within(failure, 1)).toBe("pending")
    expect(connection.destroyed).toBe(false)

    fake.resumeClient(0)
    await drained
    fake.release()
    // The pending read gets Cursor's next frame instead of an error.
    expect(await within(failure, 3_000)).toBeUndefined()
    run.end()
  }, SLOW_TEST_MS)

  it("keeps a connection whose PING answers stop while Cursor keeps streaming", async () => {
    fake.answers.push("answer-then-trickle")
    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    run.write(new Uint8Array([8]))
    const frames = run.frames()[Symbol.asyncIterator]()
    expect((await frames.next()).done).toBe(false)
    const connection = await getSession(ORIGIN)
    fake.muteClient(0)

    await sleep(800)
    expect((await frames.next()).done).toBe(false)
    expect(connection.destroyed).toBe(false)
    run.end()
  }, SLOW_TEST_MS)

  it("closes an idle connection once it reaches the rotation age", async () => {
    await completedRun()
    const connection = await getSession(ORIGIN)
    spyOn(connection, "ping").mockImplementation(((callback: (error: Error | null) => void) => {
      callback(null)
      return true
    }) as typeof connection.ping)
    const close = spyOn(connection, "close")
    setSystemTime(new Date(Date.now() + 16 * 60_000))

    await until(() => close.mock.calls.length > 0)
    expect(close).toHaveBeenCalled()
    expect(fake.connections).toBe(1)
  }, SLOW_TEST_MS)
})
