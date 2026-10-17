import assert from "node:assert/strict"
import http2 from "node:http2"
import net from "node:net"
import {
  bidiRunStream,
  closeCachedHttp2SessionsForTests,
  getSession,
  resetRunCompressionForTests,
} from "../dist/transport/connect.js"
import { encodeFrame } from "../dist/protocol/framing.js"
import { writeStreamMessage } from "../dist/stream-write.js"

// Node counts a session's unsent request bytes against maxSessionMemory too, so
// Runs are checked here as well. From #79 (by @nkoynov).
process.env.CURSOR_CLIENT_VERSION = "cli-node-session-memory-test-1"
for (const key of ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"]) delete process.env[key]
const ORIGIN = "https://agentn.node-session-memory-test.cursor.sh"
// Gzip would shrink the filled requests far below the session memory these checks fill.
resetRunCompressionForTests(ORIGIN)
const MiB = 1024 * 1024
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const realConnect = http2.connect

async function startBusyCursor() {
  const server = http2.createServer({ maxSessionMemory: 64, settings: { initialWindowSize: 512 * 1024 } })
  const sessions = new Set()
  server.on("session", (session) => {
    sessions.add(session)
    session.setLocalWindowSize(2 ** 31 - 1)
  })
  server.on("stream", (stream) => {
    stream.on("error", () => {})
    stream.pause()
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    stream.write(encodeFrame(0x00, new Uint8Array([1, 2, 3])))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  // The provider's own connect call and options, over plain TCP to this server.
  http2.connect = (origin, options) =>
    realConnect(origin, { ...options, createConnection: () => net.connect(server.address().port, "127.0.0.1") })
  return {
    async close() {
      for (const session of sessions) session.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const nextFrame = (run) => run.frames()[Symbol.asyncIterator]().next()
const firstAnswer = (run) => nextFrame(run).then(
  (frame) => frame.done ? "ended" : "answered",
  (error) => error.message,
)

async function scenario(name, run) {
  const cursor = await startBusyCursor()
  try {
    await run()
  } finally {
    closeCachedHttp2SessionsForTests()
    http2.connect = realConnect
    await cursor.close()
  }
  console.log(`node-http2-session-memory ${name}=ok`)
}

await scenario("new-run-beside-multi-megabyte-requests", async () => {
  const siblings = []
  for (let i = 0; i < 5; i++) {
    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    assert.equal((await nextFrame(run)).done, false)
    run.write(new Uint8Array(3 * MiB).fill(i))
    siblings.push(run)
  }
  await sleep(100)
  const run = await bidiRunStream("token", { baseURL: ORIGIN })
  run.write(new Uint8Array([9]))
  assert.equal(await firstAnswer(run), "answered")
  run.destroy()
  for (const sibling of siblings) sibling.destroy()
})

await scenario("new-run-beside-backlog-over-default-session-memory", async () => {
  const opener = await bidiRunStream("token", { baseURL: ORIGIN })
  assert.equal((await nextFrame(opener)).done, false)
  const session = await getSession(ORIGIN)
  const backlog = session.request({ ":method": "POST", ":path": "/agent.v1.AgentService/Run" }, { endStream: false })
  backlog.on("error", () => {})
  backlog.write(new Uint8Array(12 * MiB))
  await sleep(100)
  const run = await bidiRunStream("token", { baseURL: ORIGIN })
  run.write(new Uint8Array([9]))
  assert.equal(await firstAnswer(run), "answered")
  run.destroy()
  backlog.close()
  opener.destroy()
})

// On Node a single Run request over the default limit fails its own stream at
// once when the uplink, not Cursor's window, is what holds it back. A relay
// forwards to a reading server at 8 MB/s, standing in for a slow uplink.
{
  const server = http2.createServer({ maxSessionMemory: 64 })
  let received = 0
  server.on("stream", (stream) => {
    stream.on("error", () => {})
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    stream.write(encodeFrame(0x00, new Uint8Array([1, 2, 3])))
    stream.on("data", (chunk) => { received += chunk.length })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const sockets = new Set()
  const timers = new Set()
  const relay = net.createServer((client) => {
    const upstream = net.connect(server.address().port, "127.0.0.1")
    sockets.add(client).add(upstream)
    const queue = []
    timers.add(setInterval(() => {
      let budget = 8_000_000 / 20
      while (queue.length > 0 && budget > 0) {
        const sent = queue[0].subarray(0, budget)
        upstream.write(sent)
        budget -= sent.length
        if (sent.length === queue[0].length) queue.shift()
        else queue[0] = queue[0].subarray(sent.length)
      }
      if (queue.length > 4) client.pause()
      else client.resume()
    }, 50))
    client.on("data", (chunk) => queue.push(chunk))
    upstream.on("data", (chunk) => client.write(chunk))
    client.on("error", () => {})
    upstream.on("error", () => {})
  })
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve))
  http2.connect = (origin, options) =>
    realConnect(origin, { ...options, createConnection: () => net.connect(relay.address().port, "127.0.0.1") })
  try {
    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    const request = new Uint8Array(18 * MiB).fill(7)
    await writeStreamMessage(run, request, "test request")
    for (const end = Date.now() + 5_000; received < 5 + request.length && Date.now() < end;) await sleep(10)
    assert.equal(received, 5 + request.length)
    run.destroy()
  } finally {
    closeCachedHttp2SessionsForTests()
    http2.connect = realConnect
    for (const timer of timers) clearInterval(timer)
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => relay.close(resolve))
    await new Promise((resolve) => server.close(resolve))
  }
  console.log("node-http2-session-memory single-request-over-default-session-memory=ok")
}
