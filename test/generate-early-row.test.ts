import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import http2 from "node:http2"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { decodeFramePayload } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { cacheHttp2SessionForTests, closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"
import { sessionManager } from "../src/session.js"
import { resetTurnStateForTests, settleRunSavesForTests } from "../src/language-model.js"
import { resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { getHostCacheDirOverride, setHostCacheDirOverride } from "../src/context/paths.js"

const ORIGIN = "https://agentn.generate-early-row-test.cursor.sh"
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const

let server: http2.Http2Server
let client: http2.ClientHttp2Session
let editPath = ""
const savedProxy: Record<string, string | undefined> = {}

function frame(message: Record<string, unknown>): Buffer {
  const payload = encodeMessage("AgentServerMessage", message)
  const header = Buffer.alloc(5)
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
        const message = decodeMessage<Record<string, unknown>>("AgentClientMessage", decodeFramePayload({ flags: pending[0]!, payload: pending.subarray(5, 5 + length) }))
        pending = pending.subarray(5 + length)
        if (!message.run_request) continue
        // Cursor announces an edit, then answers in text without ever running it.
        stream.write(frame({
          interaction_update: {
            partial_tool_call: { call_id: "edit-1", tool_call: { edit_tool_call: { args: { path: editPath } } } },
          },
        }))
        stream.write(frame({ interaction_update: { text_delta: { text: "No change was needed." } } }))
        stream.write(frame({ interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } }))
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

// `createCursor({ cacheDir })` sets the process-wide host cache root; a later
// test would write into this file's removed temp dir.
let previousCache: string | undefined
beforeEach(() => { previousCache = getHostCacheDirOverride() })

afterEach(() => {
  setHostCacheDirOverride(previousCache)
  sessionManager.dispose()
  resetTurnStateForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
})

describe("doGenerate with an announced edit that never runs", () => {
  it("returns the text without the closed row's tool call", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-generate-row-"))
    try {
      editPath = path.join(root, "notes.txt")
      fs.writeFileSync(editPath, "one\n")
      cacheHttp2SessionForTests(ORIGIN, client)
      const model = createCursor({
        name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir: root, workspaceRoot: root,
      }).languageModel("composer-2.5")
      const result = await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Check notes.txt" }] }],
        tools: [{ type: "function", name: "edit", description: "Edit a file", inputSchema: { type: "object", properties: {} } }],
        headers: { "x-opencode-session-id": "ses_generate_row" },
      } as LanguageModelV3CallOptions)

      expect(result.content).toEqual([{ type: "text", text: "No change was needed." }])
    } finally {
      await settleRunSavesForTests()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
