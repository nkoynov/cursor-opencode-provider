import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import http2 from "node:http2"
import net from "node:net"
import tls from "node:tls"
import { encodeFrame } from "../src/protocol/framing.js"
import { resetClientVersionCache } from "../src/protocol/client-version.js"
import {
  bidiRunStream,
  closeCachedHttp2SessionsForTests,
  getSession,
  resetRunCompressionForTests,
  type BidiStream,
} from "../src/transport/connect.js"

// From #79 (by @nkoynov).

const ORIGIN = "https://agentn.session-memory-test.cursor.sh"
const MiB = 1024 * 1024
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const
const realConnect = http2.connect
const realTlsConnect = tls.connect

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
  // The provider's own connect call and options, over plain TCP to this server (or the proxy's tunnel to it).
  ;(http2 as { connect: unknown }).connect = (origin: string, options?: http2.ClientSessionOptions) =>
    realConnect(origin, { ...options, createConnection: options?.createConnection ?? (() => net.connect(port, "127.0.0.1")) })
  return {
    port,
    get streams() { return streams },
    async close() {
      for (const session of sessions) session.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** A CONNECT proxy that tunnels to the busy Cursor; TLS over the tunnel is a pass-through. */
async function startTunnelProxy(cursorPort: number) {
  const requests: string[] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer((client) => {
    sockets.add(client)
    client.on("error", () => {})
    client.once("data", (head) => {
      requests.push(head.toString("utf8"))
      const upstream = net.connect(cursorPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        client.pipe(upstream).pipe(client)
      })
      sockets.add(upstream)
      upstream.on("error", () => {})
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  ;(tls as { connect: unknown }).connect = ({ socket }: { socket: net.Socket }) => {
    setImmediate(() => socket.emit("secureConnect"))
    return socket
  }
  return {
    port: (server.address() as net.AddressInfo).port,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy()
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
const savedProxy: Record<string, string | undefined> = {}

beforeEach(async () => {
  for (const key of PROXY_KEYS) {
    savedProxy[key] = process.env[key]
    delete process.env[key]
  }
  process.env.CURSOR_CLIENT_VERSION = "cli-session-memory-test-1"
  resetClientVersionCache()
  // The filled requests would compress to a few kilobytes and never fill the session.
  resetRunCompressionForTests(ORIGIN)
  cursor = await startBusyCursor()
})

afterEach(async () => {
  resetRunCompressionForTests()
  closeCachedHttp2SessionsForTests()
  ;(http2 as { connect: unknown }).connect = realConnect
  ;(tls as { connect: unknown }).connect = realTlsConnect
  await cursor.close()
  for (const key of PROXY_KEYS) {
    if (savedProxy[key] === undefined) delete process.env[key]
    else process.env[key] = savedProxy[key]
  }
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

  async function expectRunOpensPastDefaultSessionMemory() {
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
  }

  it("still opens a new Run when the connection holds more unsent bytes than the runtime's default session memory", async () => {
    await expectRunOpensPastDefaultSessionMemory()
  })

  it("gives a connection through HTTPS_PROXY the same session memory", async () => {
    const proxy = await startTunnelProxy(cursor.port)
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`
    try {
      await expectRunOpensPastDefaultSessionMemory()
      expect(proxy.requests).toHaveLength(1)
      expect(proxy.requests[0]).toStartWith("CONNECT agentn.session-memory-test.cursor.sh:443 HTTP/1.1")
    } finally {
      await proxy.close()
    }
  })
})
