import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test"
import http2 from "node:http2"
import net from "node:net"
import { CursorProviderError } from "../src/errors.js"
import { encodeFrame } from "../src/protocol/framing.js"
import { resetClientVersionCache } from "../src/protocol/client-version.js"
import {
  bidiRunStream,
  closeCachedHttp2SessionsForTests,
  getSession,
  HTTP2_SESSION_LIVE_WINDOW_MS,
  receivedRecently,
  routeHttp2ConnectionsForTests,
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
        stream.session!.goaway(http2.constants.NGHTTP2_NO_ERROR, stream.id! - 2)
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
      if (dropNextRequest !== undefined) {
        const afterMs = dropNextRequest
        dropNextRequest = undefined
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
    dropNextRequest(afterMs = 0) { dropNextRequest = afterMs },
    dropConnection(index: number) { clientsByConnection.get(index)?.destroy() },
    /** Stops forwarding what the client sends on a connection, so Cursor sees neither its pings nor its GOAWAY. */
    muteClient(index: number) { muted.add(index) },
    /** Answers, continues or cancels the streams held so far. */
    release() {
      for (const next of held.splice(0)) next()
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

  it("follows the new connection when the dead one held a request still draining", async () => {
    await completedRun()
    fake.dropNextRequest(200)

    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    // Larger than the socket buffers, so the write is still waiting to drain when the connection dies.
    const request = new Uint8Array(16_000_000).fill(5)
    expect(run.write(request)).toBe(false)
    await run.waitForDrain!(5_000)
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
