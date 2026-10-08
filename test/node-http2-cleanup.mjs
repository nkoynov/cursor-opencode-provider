import assert from "node:assert/strict"
import http2 from "node:http2"
import net from "node:net"
import {
  cacheHttp2SessionForTests,
  closeCachedHttp2SessionsForTests,
  getSession,
  installSessionInvalidationForTests,
} from "../dist/transport/connect.js"

const server = http2.createServer()
const remoteReady = new Promise((resolve) => server.once("session", resolve))
await new Promise((resolve, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", resolve)
})

try {
  const address = server.address()
  assert(address && typeof address === "object")
  const origin = `http://127.0.0.1:${address.port}`
  const client = http2.connect(origin)
  await new Promise((resolve, reject) => {
    client.once("connect", resolve)
    client.once("error", reject)
  })
  installSessionInvalidationForTests(origin, client)
  const remote = await remoteReady
  const closed = new Promise((resolve) => client.once("close", resolve))
  remote.destroy()
  await closed
  assert.equal(client.closed || client.destroyed, true)
} finally {
  await new Promise((resolve) => server.close(resolve))
}

console.log("node-http2-cleanup=ok")

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert(address && typeof address === "object")
  return address.port
}

for (const failure of ["refused", "timeout", "callback-error", "throw"]) {
  let release
  const released = new Promise(resolve => { release = resolve })
  const server = http2.createServer()
  server.on("stream", stream => {
    stream.respond({ ":status": 200 })
    stream.write("first")
    void released.then(() => stream.end("last"))
  })
  const port = await listen(server)
  const proxy = net.createServer(socket => {
    socket.on("error", () => {})
    socket.once("data", () => socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"))
  })
  const proxyPort = await listen(proxy)
  const keys = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"]
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  keys.forEach(key => { delete process.env[key] })
  process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`
  const client = http2.connect(`http://127.0.0.1:${port}`)
  try {
    await new Promise((resolve, reject) => {
      client.once("connect", resolve)
      client.once("error", reject)
    })
    const origin = "https://agentn.ping-test.cursor.sh"
    cacheHttp2SessionForTests(origin, client)
    const sibling = client.request({ ":path": "/run" })
    let body = ""
    const first = new Promise(resolve => sibling.once("data", resolve))
    sibling.on("data", chunk => { body += chunk.toString("utf8") })
    const ended = new Promise((resolve, reject) => {
      sibling.once("end", resolve)
      sibling.once("error", reject)
    })
    await first
    client.ping = (...args) => {
      if (failure === "throw") throw new Error("ping failed")
      if (failure === "callback-error") args.at(-1)(new Error("ping failed"), 0, Buffer.alloc(8))
      return failure !== "refused"
    }
    await assert.rejects(getSession(origin, { pingTimeoutMs: 10 }), { code: "CURSOR_PROXY_CONNECT_REJECTED" })
    assert.equal(client.destroyed, false)
    assert.equal(client.closed, true)
    release()
    await ended
    assert.equal(body, "firstlast")
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    release()
    closeCachedHttp2SessionsForTests()
    client.destroy()
    await new Promise(resolve => proxy.close(resolve))
    await new Promise(resolve => server.close(resolve))
  }
}

console.log("node-http2-ping-retirement=ok (4 failure modes)")
