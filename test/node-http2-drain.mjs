import "./node-tmpdir.mjs"
import assert from "node:assert/strict"
import http2 from "node:http2"
import net from "node:net"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  bidiRunStream,
  cacheHttp2SessionForTests,
  closeCachedHttp2SessionsForTests,
  resetRunCompressionForTests,
} from "../dist/transport/connect.js"
import { encodeFrame } from "../dist/protocol/framing.js"
import { writeStreamMessage } from "../dist/stream-write.js"
import { createCursor } from "../dist/index.js"
import { notifyHostInterrupt } from "../dist/host-interrupt.js"
import { sessionManager } from "../dist/session.js"
import { getHostCacheDirOverride, setHostCacheDirOverride } from "../dist/context/paths.js"
import { encodeMessage } from "../dist/protocol/messages.js"
import { settleRunSavesForTests } from "../dist/language-model.js"


// Node keeps a large write's full size buffered until it is out and holds back
// a stream's `close` while it is, so the drain is checked on Node as well as
// Bun. Adapted from the relay tests in #77 (by @nkoynov).
process.env.CURSOR_CLIENT_VERSION = "cli-node-drain-test-1"
const ORIGIN = "https://agentn.node-drain-test.cursor.sh"
// Gzip would shrink these filled payloads below the stream's buffers, so nothing would backpressure.
resetRunCompressionForTests(ORIGIN)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const failureOf = (promise) => promise.then(() => undefined, (error) => error)
const waitUntil = async (condition, ms = 5_000) => {
  for (const end = Date.now() + ms; !condition() && Date.now() < end;) await sleep(10)
}

async function startSlowCursor(bytesPerSecond, { endWithoutReading = false } = {}) {
  const received = []
  const serverStreams = []
  let stalled = false
  const sessions = new Set()
  const server = http2.createServer()
  server.on("session", (session) => sessions.add(session))
  server.on("stream", (stream) => {
    const index = received.push(0) - 1
    serverStreams.push(stream)
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    stream.write(encodeFrame(0x00, encodeMessage("AgentServerMessage", { interaction_update: { heartbeat: {} } })))
    stream.on("error", () => {})
    if (endWithoutReading) return void setTimeout(() => stream.end(), 100)
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
  const client = http2.connect(ORIGIN, { createConnection: () => net.connect(relay.address().port, "127.0.0.1") })
  client.on("error", () => {})
  await new Promise((resolve, reject) => {
    client.once("connect", resolve)
    client.once("error", reject)
  })
  cacheHttp2SessionForTests(ORIGIN, client)
  return {
    received,
    send(index, message) { serverStreams[index].write(encodeFrame(0, encodeMessage("AgentServerMessage", message))) },
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

async function scenario(name, rate, run, options) {
  const fake = await startSlowCursor(rate, options)
  try {
    await run(fake)
  } finally {
    closeCachedHttp2SessionsForTests()
    await fake.close()
  }
  console.log(`node-http2-drain ${name}=ok`)
}

await scenario("slow-upload", 500_000, async (fake) => {
  const run = await bidiRunStream("token", { baseURL: ORIGIN })
  const request = new Uint8Array(3_000_000).fill(5)
  const startedAt = Date.now()
  await writeStreamMessage(run, request, "test request")
  assert.ok(Date.now() - startedAt > 5_000)
  await waitUntil(() => fake.received[0] === 5 + request.length)
  assert.equal(fake.received[0], 5 + request.length)
  run.end()
})

await scenario("abort", 200_000, async (fake) => {
  const controller = new AbortController()
  const run = await bidiRunStream("token", { baseURL: ORIGIN, signal: controller.signal })
  assert.equal(run.write(new Uint8Array(3_000_000).fill(5)), false)
  const drain = failureOf(run.waitForDrain())
  await waitUntil(() => fake.received[0] > 50_000)
  const startedAt = Date.now()
  controller.abort()
  const error = await drain
  assert.equal(error?.name, "CursorLocalCancellationError")
  assert.ok(Date.now() - startedAt < 1_000)
})

for (const close of ["destroy", "end"]) {
  await scenario(close, 200_000, async (fake) => {
    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    assert.equal(run.write(new Uint8Array(3_000_000).fill(5)), false)
    const drain = failureOf(run.waitForDrain())
    await waitUntil(() => fake.received[0] > 50_000)
    fake.stall()
    const startedAt = Date.now()
    run[close]()
    const error = await drain
    assert.equal(error?.name, "CursorLocalCancellationError")
    assert.ok(Date.now() - startedAt < 1_000)
  })
}

await scenario("response-end", 200_000, async () => {
  const run = await bidiRunStream("token", { baseURL: ORIGIN })
  assert.equal(run.write(new Uint8Array(3_000_000).fill(5)), false)
  const error = await Promise.race([failureOf(run.waitForDrain()), sleep(3_000).then(() => "pending")])
  assert.notEqual(error, "pending")
  assert.ok(error instanceof Error)
  assert.notEqual(error.name, "CursorLocalCancellationError")
}, { endWithoutReading: true })

await scenario("read-idle", 200_000, async (fake) => {
  const run = await bidiRunStream("token", { baseURL: ORIGIN, readIdleMs: 500 })
  assert.equal(run.write(new Uint8Array(3_000_000).fill(5)), false)
  const drain = failureOf(run.waitForDrain())
  await waitUntil(() => fake.received[0] > 50_000)
  fake.stall()
  const error = await drain
  assert.equal(error?.code, "CURSOR_READ_IDLE_TIMEOUT")
  assert.equal(run.isClosed(), true)
})

// Cancellation must work through the provider callers, which deliberately do
// not bind a completed tool step's signal to the held HTTP/2 stream.
for (const [kind, stop] of [["initial", "abort"], ["initial", "host-stop"], ["replacement", "abort"], ["replacement", "host-stop"], ["continuation", "abort"], ["kv", "abort"]]) {
  await scenario(`provider-${kind}-${stop}`, 200_000, async (fake) => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-node-upload-cancel-"))
    const previousCache = getHostCacheDirOverride()
    const controller = new AbortController()
    const sessionKey = `ses_node_upload_${kind}_${stop}`
    let opening
    try {
      const model = createCursor({ name: "cursor", accessToken: "token", agentBaseURL: ORIGIN,
        workspaceRoot: cacheDir, cacheDir }).languageModel("composer-2.5")
      const call = {
        prompt: [{ role: "user", content: [{ type: "text", text: kind === "initial" ? "x".repeat(3_000_000) : "Read" }] }],
        tools: [{ type: "function", name: "read", description: "Read", inputSchema: {
          type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"],
        } }],
        headers: { "x-opencode-session-id": sessionKey }, abortSignal: controller.signal,
      }
      if (kind === "kv") {
        const result = await model.doStream(call)
        const session = sessionManager.findOpenByOpenCodeSessionId(sessionKey)
        session.blobs.set("b10b", new Uint8Array(3_000_000))
        const reader = result.stream.getReader()
        opening = (async () => { while (!(await reader.read()).done) { /* consume */ } })()
        void opening.catch(() => {})
        await waitUntil(() => fake.received.length === 1)
        fake.send(0, { kv_server_message: { id: 4, get_blob_args: { blob_id: Uint8Array.of(0xb1, 0x0b) } } })
      } else if (kind === "replacement") {
        await model.doStream(call)
        opening = sessionManager.findOpenByOpenCodeSessionId(sessionKey).reopenWithUserMessage("x".repeat(3_000_000), controller.signal)
      } else if (kind === "continuation") {
        const stream = await bidiRunStream("token", { baseURL: ORIGIN })
        const session = {
          sessionId: "node-upload-continuation", conversationId: "node-upload-conversation", openCodeSessionId: sessionKey,
          cacheDir, pending: new Map(), blobs: new Map(), displayToolCalls: new Map(), editToolCalls: new Map(),
          nextBridgedExecId: 900_000, pumpActive: false, heartbeat: null,
          usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
          billing: { key: sessionKey, prefixTokens: 0 },
          stream, frames: stream.frames()[Symbol.asyncIterator](), allowTools: true, toolCatalog: [], toolDescriptors: [], requestContext: {},
        }
        sessionManager.registerPending(4, session, "read_result", "read")
        const toolCallId = `cursor_${session.sessionId}_4`
        call.prompt.push(
          { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName: "read", input: { filePath: "example.txt" } }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId, toolName: "read", output: { type: "text", value: "x".repeat(3_000_000) } }] },
        )
        opening = Promise.resolve(model.doStream(call))
      } else opening = Promise.resolve(model.doStream(call))
      const outcome = failureOf(opening)
      const index = kind === "replacement" ? 1 : 0
      await waitUntil(() => fake.received[index] > 50_000)
      assert.ok(fake.received[index] > 50_000)
      fake.stall()
      if (stop === "abort") controller.abort()
      else await notifyHostInterrupt(sessionKey, "user", Date.now())
      const error = await Promise.race([outcome, sleep(1_000).then(() => "still uploading")])
      assert.equal(error?.name, "CursorLocalCancellationError")
    } finally {
      sessionManager.dispose()
      closeCachedHttp2SessionsForTests()
      if (opening) await failureOf(opening)
      // The stop saves the cancelled Run afterwards; that write would recreate the dir.
      await settleRunSavesForTests()
      setHostCacheDirOverride(previousCache)
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
  })
}

// A destroyed Run must close its stream so the cached session is released and
// the process can exit, with an idle stream and with a blocked request write.
const CONNECT_MODULE = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/transport/connect.js")).href
for (const [name, bytes, close] of [
  ["exit-after-destroy-idle", 10, "destroy"],
  ["exit-after-destroy-blocked", 3_000_000, "destroy"],
  ["exit-after-end-blocked", 3_000_000, "end"],
  ["exit-after-end-destroy-idle", 10, "end-then-destroy"],
  ["exit-after-end-destroy-blocked", 3_000_000, "end-then-destroy"],
]) {
  const script = `
import { randomBytes } from "node:crypto"
import http2 from "node:http2"
import { bidiRunStream, cacheHttp2SessionForTests, resetRunCompressionForTests } from ${JSON.stringify(CONNECT_MODULE)}
// Gzip would shrink the filled request below the stream's buffers, so it would never block.
resetRunCompressionForTests("https://agentn.node-exit-test.cursor.sh")
const server = http2.createServer()
server.on("session", (session) => session.unref())
const arrived = new Promise((resolve) => server.on("stream", (stream) => {
  stream.respond({ ":status": 200 })
  stream.on("error", () => {})
  resolve()
}))
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
server.unref()
const client = http2.connect("http://127.0.0.1:" + server.address().port)
await new Promise((resolve) => client.once("connect", resolve))
cacheHttp2SessionForTests("https://agentn.node-exit-test.cursor.sh", client)
void (async () => {
  const run = await bidiRunStream("token", { baseURL: "https://agentn.node-exit-test.cursor.sh" })
  run.write(new Uint8Array(randomBytes(${bytes})))
  await arrived
  await new Promise((resolve) => setTimeout(resolve, 200))
  ${close !== "destroy" ? "run.end()" : ""}
  ${close !== "end" ? "run.destroy()" : ""}
  console.log("destroyed")
})()
`
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-provider-node-exit-"))
  try {
    const file = path.join(directory, "run.mjs")
    await fs.writeFile(file, script)
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, CURSOR_CLIENT_VERSION: "cli-node-exit-test" },
      stdio: ["ignore", "pipe", "inherit"],
    })
    let stdout = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    let timer
    const exited = new Promise((resolve, reject) => {
      child.once("close", resolve)
      child.once("error", reject)
    })
    const code = await Promise.race([
      exited,
      new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), 8_000) }),
    ]).finally(() => clearTimeout(timer))
    if (code === "timeout") { child.kill(); await exited }
    assert.equal(code, 0)
    assert.equal(stdout, "destroyed\n")
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
  console.log(`node-http2-drain ${name}=ok`)
}
