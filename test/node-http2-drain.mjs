import assert from "node:assert/strict"
import http2 from "node:http2"
import net from "node:net"
import {
  bidiRunStream,
  closeCachedHttp2SessionsForTests,
  routeHttp2ConnectionsForTests,
} from "../dist/transport/connect.js"
import { encodeFrame } from "../dist/protocol/framing.js"

// Node's own http2 stream keeps a large write's full size buffered until it is out, like Bun's, so the
// write drain's stall window is checked on Node too.
process.env.CURSOR_CLIENT_VERSION = "cli-node-drain-test-1"
const ORIGIN = "https://agentn.node-drain-test.cursor.sh"
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const failureOf = (promise) => promise.then(() => undefined, (error) => error)
const waitUntil = async (condition, ms = 5_000) => {
  for (const end = Date.now() + ms; !condition() && Date.now() < end;) await sleep(10)
}

async function startSlowCursor(bytesPerSecond, unread = []) {
  const received = []
  let stalled = false
  const sessions = new Set()
  const server = http2.createServer()
  server.on("session", (session) => sessions.add(session))
  server.on("stream", (stream) => {
    const index = received.push(0) - 1
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    stream.write(encodeFrame(0x00, new Uint8Array([1, 2, 3])))
    stream.on("error", () => {})
    if (unread.includes(index)) return
    stream.on("data", (chunk) => { received[index] += chunk.length })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const sockets = new Set()
  const timers = new Set()
  const relay = net.createServer((client) => {
    const upstream = net.connect(server.address().port, "127.0.0.1")
    sockets.add(client).add(upstream)
    const queue = []
    timers.add(setInterval(() => {
      if (stalled) return void client.pause()
      let budget = bytesPerSecond / 20
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
  routeHttp2ConnectionsForTests(() => net.connect(relay.address().port, "127.0.0.1"))
  return {
    received,
    stall() { stalled = true },
    async close() {
      for (const timer of timers) clearInterval(timer)
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => relay.close(resolve))
      for (const session of sessions) session.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function scenario(name, rate, unread, run) {
  const fake = await startSlowCursor(rate, unread)
  try {
    await run(fake)
  } finally {
    closeCachedHttp2SessionsForTests()
    routeHttp2ConnectionsForTests()
    await fake.close()
  }
  console.log(`node-http2-drain ${name}=ok`)
}

await scenario("progressing-write", 2_000_000, [], async (fake) => {
  const run = await bidiRunStream("token", { baseURL: ORIGIN })
  const request = new Uint8Array(3_000_000).fill(5)
  assert.equal(run.write(request), false)
  const startedAt = Date.now()
  await run.waitForDrain(300)
  assert.ok(Date.now() - startedAt > 600)
  await waitUntil(() => fake.received[0] === 5 + request.length)
  assert.equal(fake.received[0], 5 + request.length)
  run.end()
})

await scenario("stalled-write", 2_000_000, [], async (fake) => {
  const run = await bidiRunStream("token", { baseURL: ORIGIN })
  assert.equal(run.write(new Uint8Array(64_000_000).fill(5)), false)
  await waitUntil(() => fake.received[0] > 100_000)
  fake.stall()
  const error = await failureOf(run.waitForDrain(300))
  assert.equal(error?.code, "CURSOR_WRITE_DRAIN_TIMEOUT")
  assert.equal(error.replaySafe, false)
  assert.equal(run.isClosed(), true)
})

await scenario("shared-connection-stall", 2_000_000, [1], async (fake) => {
  const sibling = await bidiRunStream("token", { baseURL: ORIGIN })
  sibling.write(new Uint8Array([7]))
  await waitUntil(() => fake.received[0] === 6)
  const run = await bidiRunStream("token", { baseURL: ORIGIN })
  assert.equal(run.write(new Uint8Array(3_000_000).fill(5)), false)
  assert.equal(sibling.write(new Uint8Array(20_000_000).fill(6)), false)
  let siblingFailure
  const siblingDrain = sibling.waitForDrain(300).catch((error) => { siblingFailure = error })
  const siblingBefore = fake.received[0]
  const startedAt = Date.now()
  const error = await failureOf(run.waitForDrain(300))
  assert.equal(error?.code, "CURSOR_WRITE_DRAIN_TIMEOUT")
  assert.ok(Date.now() - startedAt < 2_000)
  assert.ok(fake.received[0] - siblingBefore > 128 * 1024)
  assert.equal(siblingFailure, undefined)
  sibling.destroy()
  await siblingDrain
})

await scenario("abort", 200_000, [], async (fake) => {
  const controller = new AbortController()
  const run = await bidiRunStream("token", { baseURL: ORIGIN, signal: controller.signal })
  assert.equal(run.write(new Uint8Array(3_000_000).fill(5)), false)
  const drain = failureOf(run.waitForDrain(5_000))
  await waitUntil(() => fake.received[0] > 50_000)
  const startedAt = Date.now()
  controller.abort()
  const error = await drain
  assert.equal(error?.name, "CursorLocalCancellationError")
  assert.ok(Date.now() - startedAt < 1_000)
})
