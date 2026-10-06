import { describe, expect, it } from "bun:test"
import http2 from "node:http2"
import net from "node:net"
import { cacheHttp2SessionForTests, closeCachedHttp2SessionsForTests, getSession } from "../src/transport/connect.js"

const ORIGIN = "https://agentn.ping-test.cursor.sh"
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("expected TCP address")
  return address.port
}

describe("getSession cached-session ping failure", () => {
  it("retires the session without aborting Runs still streaming on it", async () => {
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => { release = resolve })
    const server = http2.createServer()
    server.on("stream", (stream) => {
      stream.respond({ ":status": 200 })
      stream.write("first")
      void released.then(() => stream.end("last"))
    })
    const serverPort = await listen(server)

    // Reconnecting after the failed ping goes through a proxy that rejects, so
    // the test never reaches the network.
    const proxy = net.createServer((socket) => {
      socket.on("error", () => {})
      socket.once("data", () => socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"))
    })
    const proxyPort = await listen(proxy)
    const saved = Object.fromEntries(PROXY_KEYS.map((key) => [key, process.env[key]]))
    for (const key of PROXY_KEYS) delete process.env[key]
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`

    const client = http2.connect(`http://127.0.0.1:${serverPort}`)
    try {
      await new Promise<void>((resolve, reject) => {
        client.once("connect", () => resolve())
        client.once("error", reject)
      })
      cacheHttp2SessionForTests(ORIGIN, client)

      const sibling = client.request({ ":path": "/run" })
      let body = ""
      const firstChunk = new Promise<void>((resolve) => sibling.once("data", () => resolve()))
      sibling.on("data", (chunk: Buffer) => { body += chunk.toString("utf8") })
      const ended = new Promise<void>((resolve, reject) => {
        sibling.once("end", () => resolve())
        sibling.once("error", reject)
      })
      await firstChunk

      client.ping = () => false
      const error = await getSession(ORIGIN).catch((err: unknown) => err)
      expect(error).toMatchObject({ code: "CURSOR_PROXY_CONNECT_REJECTED" })
      expect(client.destroyed).toBe(false)
      expect(client.closed).toBe(true)

      release()
      await ended
      expect(body).toBe("firstlast")
    } finally {
      for (const key of PROXY_KEYS) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
      release()
      closeCachedHttp2SessionsForTests()
      client.destroy()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
