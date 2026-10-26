import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import http2 from "node:http2"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from "@ai-sdk/provider"
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

const ORIGIN = "https://agentn.lifecycle-isolation-test.cursor.sh"
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const

let server: http2.Http2Server
let client: http2.ClientHttp2Session
let runs = 0
/** Client messages on the first (parent) Run after its run_request. */
let parentWrites: string[] = []
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
    let run = 0
    stream.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1)
        if (pending.length < 5 + length) break
        const message = decodeMessage<Record<string, unknown>>("AgentClientMessage", decodeFramePayload({ flags: pending[0]!, payload: pending.subarray(5, 5 + length) }))
        pending = pending.subarray(5 + length)
        if (!message.run_request) {
          if (run === 1) parentWrites.push(Object.keys(message).join(","))
          continue
        }
        run = ++runs
        if (run === 1) {
          // The parent asks the host to run a long shell command and waits on it.
          stream.write(frame(encodeMessage("AgentServerMessage", {
            exec_server_message: { id: 1, shell_args: { command: "sleep 50", tool_call_id: "call-shell" } },
          })))
        } else {
          stream.write(frame(encodeMessage("AgentServerMessage", {
            interaction_update: { text_delta: { text: "A title" } },
          })))
          stream.write(frame(encodeMessage("AgentServerMessage", {
            interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } },
          })))
          stream.end()
        }
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
  runs = 0
  parentWrites = []
})

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as LanguageModelV3Prompt[number]

async function streamParts(root: string, options: Partial<LanguageModelV3CallOptions>): Promise<Array<{ type: string }>> {
  cacheHttp2SessionForTests(ORIGIN, client)
  const model = createCursor({ name: "cursor", accessToken: "example-token", agentBaseURL: ORIGIN, cacheDir: root })
    .languageModel("composer-2.5")
  const { stream } = await model.doStream({
    headers: { "x-opencode-session-id": "ses_lifecycle_parent" },
    ...options,
  } as LanguageModelV3CallOptions)
  const parts: Array<{ type: string }> = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return parts
    parts.push(value as { type: string })
  }
}

describe("tool-less lifecycle call beside a held Run", () => {
  it("leaves the parent's running tool and Run alone", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-lifecycle-"))
    try {
      const parentParts = await streamParts(root, {
        prompt: [user("run sleep 50")],
        tools: [{ type: "function", name: "bash", description: "Run a shell command", inputSchema: { type: "object", properties: { command: { type: "string" } } } }],
      })
      expect(parentParts.some((part) => part.type === "tool-call")).toBe(true)
      const parent = sessionManager.findOpenByOpenCodeSessionId("ses_lifecycle_parent")
      expect(parent?.pending.size).toBe(1)

      // While the host still runs that tool, it asks for a title with no tools.
      const titleParts = await streamParts(root, { prompt: [user("Generate a title for: run sleep 50")] })
      expect(titleParts.some((part) => part.type === "text-delta")).toBe(true)
      expect(runs).toBe(2)

      expect(parent?.closed).toBe(false)
      expect(parent?.pending.size).toBe(1)
      expect(sessionManager.findOpenByOpenCodeSessionId("ses_lifecycle_parent")).toBe(parent)
      // No cancel result and no cancel action reached the parent Run.
      expect(parentWrites.filter((kind) => kind !== "client_heartbeat" && kind !== "exec_client_control_message")).toEqual([])
    } finally {
      // The parent Run is still held for its tool and saves its state after a
      // second; close it and wait for that save, or it recreates the root.
      sessionManager.dispose()
      await settleRunSavesForTests()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
