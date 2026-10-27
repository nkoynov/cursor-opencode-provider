import assert from "node:assert/strict"
import http2 from "node:http2"
import net from "node:net"
import {
  bidiRunStream,
  closeCachedHttp2SessionsForTests,
  getSession,
  HTTP2_SESSION_LIVE_WINDOW_MS,
  resetRunCompressionForTests,
  routeHttp2ConnectionsForTests,
  setHttp2KeepaliveForTests,
} from "../dist/transport/connect.js"
import { encodeFrame } from "../dist/protocol/framing.js"

// Node destroys a closed session as soon as its last stream ends, and its stream backpressure lasts
// until the socket takes the data, so the resend of a Run reused without a ping is checked here too.
process.env.CURSOR_CLIENT_VERSION = "cli-node-resend-test-1"
const ORIGIN = "https://agentn.node-resend-test.cursor.sh"
// Uncompressed, so a large request stays larger than the socket buffers on the wire.
resetRunCompressionForTests(ORIGIN)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function startFakeCursor() {
  const answers = []
  const streams = []
  const sessions = new Map()
  const clients = new Set()
  const clientsByConnection = new Map()
  const held = []
  const muted = new Set()
  let connections = 0
  let dropAfterMs
  let connectDelayMs = 0
  const server = http2.createServer({ maxSessionMemory: 64 })
  server.on("session", (session) => sessions.set(session, sessions.size))
  server.on("stream", (stream) => {
    const answer = answers.shift() ?? "answer"
    const record = { answer, connection: sessions.get(stream.session), bytes: 0 }
    streams.push(record)
    stream.on("data", (chunk) => { record.bytes += chunk.length })
    stream.on("end", () => { try { stream.end() } catch { /* already closed */ } })
    stream.on("error", () => {})
    const respond = () => {
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
      stream.write(encodeFrame(0x00, new Uint8Array([1, 2, 3])))
    }
    if (answer === "refuse") return stream.close(http2.constants.NGHTTP2_REFUSED_STREAM)
    if (answer === "cancel") return stream.close(http2.constants.NGHTTP2_CANCEL)
    if (answer === "hold") return held.push(respond)
    if (answer === "goaway-unprocessed") return stream.session.goaway(http2.constants.NGHTTP2_NO_ERROR, stream.id - 2)
    if (answer === "hold-then-cancel") return held.push(() => stream.close(http2.constants.NGHTTP2_CANCEL))
    respond()
    if (answer === "answer-then-hold") held.push(() => stream.write(encodeFrame(0x00, new Uint8Array([4, 5, 6]))))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const proxy = net.createServer((client) => {
    clientsByConnection.set(connections, client)
    connections++
    clients.add(client)
    const upstream = net.connect(server.address().port, "127.0.0.1")
    let swallowing = false
    const connection = connections - 1
    client.on("data", (chunk) => {
      if (swallowing || muted.has(connection)) return
      if (dropAfterMs !== undefined) {
        const afterMs = dropAfterMs
        dropAfterMs = undefined
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
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  routeHttp2ConnectionsForTests(() => {
    const delayMs = connectDelayMs
    connectDelayMs = 0
    if (!delayMs) return net.connect(proxy.address().port, "127.0.0.1")
    const lookup = (_host, options, callback) => setTimeout(() => {
      if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }])
      else callback(null, "127.0.0.1", 4)
    }, delayMs)
    return net.connect({ host: "fake-cursor.invalid", port: proxy.address().port, lookup })
  })
  return {
    answers,
    streams,
    get connections() { return connections },
    dropNextRequest(afterMs = 0) { dropAfterMs = afterMs },
    delayNextConnection(ms) { connectDelayMs = ms },
    dropConnection(index) { clientsByConnection.get(index)?.destroy() },
    muteClient(index) { muted.add(index) },
    release() { for (const next of held.splice(0)) next() },
    async close() {
      for (const client of clients) client.destroy()
      await new Promise((resolve) => proxy.close(resolve))
      for (const session of sessions.keys()) session.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const nextFrame = (run) => run.frames()[Symbol.asyncIterator]().next()
const failureOf = (promise) => promise.then(() => undefined, (error) => error)

async function scenario(name, run, keepalive) {
  const fake = await startFakeCursor()
  setHttp2KeepaliveForTests(keepalive)
  try {
    const first = await bidiRunStream("token", { baseURL: ORIGIN })
    first.write(new Uint8Array([7]))
    assert.equal((await nextFrame(first)).done, false)
    first.end()
    await sleep(50)
    await run(fake)
  } finally {
    clockOffsetMs = 0
    setHttp2KeepaliveForTests()
    closeCachedHttp2SessionsForTests()
    routeHttp2ConnectionsForTests()
    await fake.close()
  }
  console.log(`node-http2-resend ${name}=ok`)
}

let clockOffsetMs = 0
const realNow = Date.now
Date.now = () => realNow() + clockOffsetMs

// Node also destroys a session retired after a failed ping once its last stream ends.
async function runThenFailedPing(fake, answer) {
  fake.answers.push(answer)
  const sibling = await bidiRunStream("token", { baseURL: ORIGIN })
  sibling.write(new Uint8Array([8]))
  const frames = sibling.frames()[Symbol.asyncIterator]()
  if (answer === "answer-then-hold") assert.equal((await frames.next()).done, false)
  else for (let i = 0; i < 400 && fake.streams.length < 2; i++) await sleep(5)
  const connection = await getSession(ORIGIN)
  fake.muteClient(0)
  clockOffsetMs = HTTP2_SESSION_LIVE_WINDOW_MS + 1_000
  const next = await bidiRunStream("token", { baseURL: ORIGIN, pingTimeoutMs: 100 })
  next.write(new Uint8Array([9]))
  assert.equal((await nextFrame(next)).done, false)
  assert.equal(connection.closed, true)
  assert.equal(connection.destroyed, false)
  return { sibling, frames, next }
}

const streamsOf = (fake) => fake.streams.map((stream) => [stream.answer, stream.connection])

await scenario("cancel-not-resent", async (fake) => {
  fake.answers.push("cancel")
  const run = await bidiRunStream("token", { baseURL: ORIGIN })
  run.write(new Uint8Array([8]))
  assert.ok(await failureOf(nextFrame(run)))
  await sleep(50)
  assert.equal(fake.connections, 1)
  assert.deepEqual(fake.streams.map((stream) => stream.answer), ["answer", "cancel"])
})

await scenario("refused-resent", async (fake) => {
  fake.answers.push("refuse")
  const run = await bidiRunStream("token", { baseURL: ORIGIN })
  run.write(new Uint8Array([8]))
  assert.equal((await nextFrame(run)).done, false)
  assert.equal(fake.connections, 2)
  assert.deepEqual(fake.streams.map((stream) => [stream.answer, stream.connection]), [["answer", 0], ["refuse", 0], ["answer", 1]])
  run.end()
})

await scenario("dead-connection-resent-after-slow-reconnect", async (fake) => {
  fake.dropNextRequest(200)
  fake.delayNextConnection(6_000)
  const run = await bidiRunStream("token", { baseURL: ORIGIN })
  const request = new Uint8Array(8_000_000).fill(5)
  assert.equal(run.write(request), false)
  await run.waitForDrain()
  assert.equal((await nextFrame(run)).done, false)
  for (let i = 0; i < 400 && fake.streams.at(-1)?.bytes !== 5 + request.length; i++) await sleep(5)
  assert.equal(fake.connections, 2)
  assert.deepEqual(fake.streams.at(-1), { answer: "answer", connection: 1, bytes: 5 + request.length })
  run.end()
})

await scenario("ping-failure-keeps-answered-run", async (fake) => {
  const { sibling, frames, next } = await runThenFailedPing(fake, "answer-then-hold")
  fake.release()
  assert.equal((await frames.next()).done, false)
  assert.deepEqual(streamsOf(fake), [["answer", 0], ["answer-then-hold", 0], ["answer", 1]])
  sibling.end()
  next.end()
})

await scenario("ping-failure-leaves-unanswered-run", async (fake) => {
  const { sibling, frames, next } = await runThenFailedPing(fake, "hold")
  fake.release()
  assert.equal((await frames.next()).done, false)
  assert.deepEqual(streamsOf(fake), [["answer", 0], ["hold", 0], ["answer", 1]])
  sibling.end()
  next.end()
})

await scenario("ping-failure-cancel-not-resent", async (fake) => {
  const { frames, next } = await runThenFailedPing(fake, "hold-then-cancel")
  fake.release()
  assert.ok(await failureOf(frames.next()))
  await sleep(50)
  assert.deepEqual(streamsOf(fake), [["answer", 0], ["hold-then-cancel", 0], ["answer", 1]])
  next.end()
})

await scenario("ping-failure-dead-connection-resent", async (fake) => {
  const { sibling, frames, next } = await runThenFailedPing(fake, "hold")
  fake.dropConnection(0)
  assert.equal((await frames.next()).done, false)
  assert.deepEqual(streamsOf(fake), [["answer", 0], ["hold", 0], ["answer", 1], ["answer", 1]])
  sibling.end()
  next.end()
})

// Node cancels PINGs on a session a GOAWAY closed; its Runs below the last stream id must still finish.
const SHORT_KEEPALIVE = { intervalMs: 100, timeoutMs: 200 }

await scenario("goaway-drains-below-and-resends-above", async (fake) => {
  fake.answers.push("answer-then-hold", "goaway-unprocessed")
  clockOffsetMs = HTTP2_SESSION_LIVE_WINDOW_MS + 1_000
  const below = await bidiRunStream("token", { baseURL: ORIGIN })
  below.write(new Uint8Array([8]))
  const belowFrames = below.frames()[Symbol.asyncIterator]()
  assert.equal((await belowFrames.next()).done, false)
  clockOffsetMs += HTTP2_SESSION_LIVE_WINDOW_MS + 1_000
  const above = await bidiRunStream("token", { baseURL: ORIGIN })
  above.write(new Uint8Array([9]))
  assert.equal((await nextFrame(above)).done, false)
  await sleep(600)
  fake.release()
  assert.equal((await belowFrames.next()).done, false)
  assert.deepEqual(streamsOf(fake), [["answer", 0], ["answer-then-hold", 0], ["goaway-unprocessed", 0], ["answer", 1]])
  below.end()
  above.end()
}, SHORT_KEEPALIVE)

await scenario("ping-timeout-fails-busy-run", async (fake) => {
  fake.answers.push("answer-then-hold")
  const busy = await bidiRunStream("token", { baseURL: ORIGIN })
  busy.write(new Uint8Array([8]))
  const frames = busy.frames()[Symbol.asyncIterator]()
  assert.equal((await frames.next()).done, false)
  fake.muteClient(0)
  const failure = await Promise.race([failureOf(frames.next()), sleep(3_000).then(() => "pending")])
  assert.equal(failure?.code, "CURSOR_HTTP2_PING_TIMEOUT")
  const next = await bidiRunStream("token", { baseURL: ORIGIN })
  next.write(new Uint8Array([9]))
  assert.equal((await nextFrame(next)).done, false)
  assert.equal(fake.connections, 2)
  next.end()
}, SHORT_KEEPALIVE)
