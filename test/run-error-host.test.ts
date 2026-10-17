import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import fs from "node:fs"
import http2 from "node:http2"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { APICallError, type LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { CursorServerError } from "../src/errors.js"
import { decodeMessage } from "../src/protocol/messages.js"
import { cacheHttp2SessionForTests, closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { sessionManager } from "../src/session.js"
import { resetTurnStateForTests } from "../src/language-model.js"
import { resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"

const ORIGIN = "https://agentn.run-error-test.cursor.sh"
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const
// ErrorDetails{error:13, details{title, detail, is_retryable:false, analytics}, is_expected:true}, as Cursor sent it.
const POLICY_BLOCK = "CA0SlgEKHFJlcXVlc3QgYmxvY2tlZCBieSBBbnRocm9waWMSXVdlIGFyZSB1bmFibGUgdG8gY29tcGxldGUgdGhpcyByZXF1ZXN0IGJlY2F1c2UgaXQgd2FzIGJsb2NrZWQgdW5kZXIgQW50aHJvcGljJ3MgVXNhZ2UgUG9saWN5LiAAUhUKE2N5YmVyX3BvbGljeV9yZXZpZXcYAQ"

let server: http2.Http2Server
let client: http2.ClientHttp2Session
let trailer: Record<string, unknown> = {}
let runs = 0
const savedProxy: Record<string, string | undefined> = {}

function frame(payload: Uint8Array, flags = 0): Buffer {
  const header = Buffer.alloc(5)
  header[0] = flags
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, Buffer.from(payload)])
}

beforeAll(async () => {
  for (const key of PROXY_KEYS) {
    savedProxy[key] = process.env[key]
    delete process.env[key]
  }
  server = http2.createServer()
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    stream.on("error", () => {})
    let pending = Buffer.alloc(0)
    stream.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1)
        if (pending.length < 5 + length) break
        const message = decodeMessage<Record<string, unknown>>("AgentClientMessage", pending.subarray(5, 5 + length))
        pending = pending.subarray(5 + length)
        if (!message.run_request) continue
        runs++
        stream.write(frame(Buffer.from(JSON.stringify(trailer)), 2))
        stream.end()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address() as net.AddressInfo
  client = http2.connect(`http://127.0.0.1:${address.port}`)
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve())
    client.once("error", reject)
  })
})

afterAll(async () => {
  closeCachedHttp2SessionsForTests()
  client?.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const key of PROXY_KEYS) {
    if (savedProxy[key] === undefined) delete process.env[key]
    else process.env[key] = savedProxy[key]
  }
})

afterEach(() => {
  setHostCacheDirOverride(undefined)
  sessionManager.dispose()
  resetTurnStateForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
  runs = 0
})

async function streamError(sessionKey: string): Promise<unknown> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-run-error-"))
  cacheHttp2SessionForTests(ORIGIN, client)
  try {
    const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root })
      .languageModel("composer-2.5")
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      headers: { "x-opencode-session-id": sessionKey },
    } as LanguageModelV3CallOptions)
    const reader = stream.getReader()
    for (;;) {
      const { done } = await reader.read()
      if (done) return undefined
    }
  } catch (error) {
    return error
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("Run errors as the host sees them", () => {
  it("reports a request Cursor declared not retryable as a 400 APICallError, without a provider retry", async () => {
    trailer = {
      error: { code: "invalid_argument", message: "Error", details: [{ type: "aiserver.v1.ErrorDetails", value: POLICY_BLOCK }] },
    }
    const error = await streamError("ses_policy_block")

    expect(APICallError.isInstance(error)).toBe(true)
    expect(error).toMatchObject({ statusCode: 400, isRetryable: false })
    expect((error as Error).message).toBe("Cursor API error (code=invalid_argument): Request blocked by Anthropic " +
      "We are unable to complete this request because it was blocked under Anthropic's Usage Policy.")
    expect(runs).toBe(1)
  }, 30_000)

  it("keeps an error without a Cursor verdict as the provider error", async () => {
    trailer = { error: { code: "invalid_argument" } }
    const error = await streamError("ses_plain_error")

    expect(APICallError.isInstance(error)).toBe(false)
    expect(error).toBeInstanceOf(CursorServerError)
    expect((error as Error).message).toBe("Cursor API error (code=invalid_argument)")
    expect(runs).toBe(1)
  }, 30_000)
})
