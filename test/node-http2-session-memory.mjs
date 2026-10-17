import assert from "node:assert/strict"
import http2 from "node:http2"
import net from "node:net"
import {
  bidiRunStream,
  closeCachedHttp2SessionsForTests,
  getSession,
  resetRunCompressionForTests,
  routeHttp2ConnectionsForTests,
} from "../dist/transport/connect.js"
import { encodeFrame } from "../dist/protocol/framing.js"

// Node counts a session's unsent request bytes against maxSessionMemory too, so new Runs are checked here as well.
process.env.CURSOR_CLIENT_VERSION = "cli-node-session-memory-test-1"
const ORIGIN = "https://agentn.node-session-memory-test.cursor.sh"
// The pending requests must stay megabytes on the wire, which gzip would shrink to almost nothing.
resetRunCompressionForTests(ORIGIN)
const MiB = 1024 * 1024
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  routeHttp2ConnectionsForTests(() => net.connect(server.address().port, "127.0.0.1"))
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
    routeHttp2ConnectionsForTests()
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
