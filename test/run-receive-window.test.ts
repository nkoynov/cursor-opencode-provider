import { afterEach, describe, expect, it } from "bun:test"
import http2 from "node:http2"
import net from "node:net"
import { encodeFrame } from "../src/protocol/framing.js"
import {
  bidiRunStream,
  closeCachedHttp2SessionsForTests,
  routeHttp2ConnectionsForTests,
  RUN_SESSION_WINDOW_BYTES,
  RUN_STREAM_WINDOW_BYTES,
} from "../src/transport/connect.js"

const ORIGIN = "https://agentn.window-test.cursor.sh"
const BLOB_BYTES = 3 * 1024 * 1024

afterEach(() => {
  closeCachedHttp2SessionsForTests()
  routeHttp2ConnectionsForTests(undefined)
})

describe("Run connection receive window", () => {
  it("lets Cursor send a multi-MB frame without waiting for a window update", async () => {
    let serverSession: http2.ServerHttp2Session | undefined
    let sentBeforeUpdate = 0
    const server = http2.createServer()
    server.on("session", (session) => { serverSession = session })
    server.on("stream", (stream) => {
      stream.on("error", () => {})
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
      // What the server may send right away, before the client reads anything.
      sentBeforeUpdate = Math.min(
        stream.session!.state.remoteWindowSize ?? 0,
        stream.session!.remoteSettings.initialWindowSize ?? 0,
      )
      stream.end(encodeFrame(0x00, new Uint8Array(BLOB_BYTES)))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as net.AddressInfo).port
    routeHttp2ConnectionsForTests(() => net.connect(port, "127.0.0.1"))
    try {
      const stream = await bidiRunStream("token", { baseURL: ORIGIN })
      stream.write(new Uint8Array([1]))
      let received = 0
      try {
        for await (const frame of stream.frames()) received += frame.payload.length
      } catch {
        // The fake ends the stream without a Connect end-stream frame.
      }
      expect(received).toBe(BLOB_BYTES)
      expect(serverSession?.remoteSettings.initialWindowSize).toBe(RUN_STREAM_WINDOW_BYTES)
      expect(sentBeforeUpdate).toBeGreaterThan(BLOB_BYTES)
      expect(RUN_SESSION_WINDOW_BYTES).toBeGreaterThan(RUN_STREAM_WINDOW_BYTES)
      stream.destroy()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
