import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import http2 from "node:http2"
import net from "node:net"
import { encodeFrame } from "../src/protocol/framing.js"
import { resetClientVersionCache } from "../src/protocol/client-version.js"
import {
  bidiRunStream,
  closeCachedHttp2SessionsForTests,
  getSession,
  resetRunCompressionForTests,
  routeHttp2ConnectionsForTests,
  type BidiStream,
} from "../src/transport/connect.js"

const ORIGIN = "https://agentn.session-memory-test.cursor.sh"
const MiB = 1024 * 1024

/** An h2c "Cursor" that answers every Run but, like a busy agent host, reads none of its request yet. */
async function startBusyCursor() {
  const server = http2.createServer({ settings: { initialWindowSize: 512 * 1024 } })
  const sessions = new Set<http2.ServerHttp2Session>()
  let streams = 0
  server.on("session", (session) => {
    sessions.add(session)
    session.setLocalWindowSize(2 ** 31 - 1)
  })
  server.on("stream", (stream) => {
    streams++
    stream.on("error", () => {})
    stream.pause()
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    stream.write(encodeFrame(0x00, new Uint8Array([1, 2, 3])))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as net.AddressInfo).port
  routeHttp2ConnectionsForTests(() => net.connect(port, "127.0.0.1"))
  return {
    get streams() { return streams },
    async close() {
      for (const session of sessions) session.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function nextFrame(run: BidiStream) {
  return run.frames()[Symbol.asyncIterator]().next()
}

async function firstAnswer(run: BidiStream): Promise<string> {
  return nextFrame(run).then(
    (frame) => frame.done ? "ended" : "answered",
    (error: Error) => error.message,
  )
}

let cursor: Awaited<ReturnType<typeof startBusyCursor>>
const savedClientVersion = process.env.CURSOR_CLIENT_VERSION

beforeEach(async () => {
  process.env.CURSOR_CLIENT_VERSION = "cli-session-memory-test-1"
  resetClientVersionCache()
  // The pending requests must stay megabytes on the wire, which gzip would shrink to almost nothing.
  resetRunCompressionForTests(ORIGIN)
  cursor = await startBusyCursor()
})

afterEach(async () => {
  resetRunCompressionForTests()
  closeCachedHttp2SessionsForTests()
  routeHttp2ConnectionsForTests()
  await cursor.close()
  if (savedClientVersion === undefined) delete process.env.CURSOR_CLIENT_VERSION
  else process.env.CURSOR_CLIENT_VERSION = savedClientVersion
  resetClientVersionCache()
})

describe("Runs sharing a connection with requests Cursor has not read yet", () => {
  it("still opens a new Run while sibling Runs hold multi-megabyte requests", async () => {
    const siblings: BidiStream[] = []
    for (let i = 0; i < 5; i++) {
      const run = await bidiRunStream("token", { baseURL: ORIGIN })
      expect((await nextFrame(run)).done).toBe(false)
      run.write(new Uint8Array(3 * MiB).fill(i))
      siblings.push(run)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))

    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    run.write(new Uint8Array([9]))

    expect(await firstAnswer(run)).toBe("answered")
    expect(cursor.streams).toBe(6)
    run.destroy()
    for (const sibling of siblings) sibling.destroy()
  })

  it("still opens a new Run when the connection holds more unsent bytes than the runtime's default session memory", async () => {
    const opener = await bidiRunStream("token", { baseURL: ORIGIN })
    expect((await nextFrame(opener)).done).toBe(false)
    const session = await getSession(ORIGIN)
    const backlog = session.request({ ":method": "POST", ":path": "/agent.v1.AgentService/Run" }, { endStream: false })
    backlog.on("error", () => {})
    backlog.write(new Uint8Array(12 * MiB))
    await new Promise((resolve) => setTimeout(resolve, 100))

    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    run.write(new Uint8Array([9]))

    expect(await firstAnswer(run)).toBe("answered")
    run.destroy()
    backlog.close()
    opener.destroy()
  })
})
