import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import fs from "node:fs"
import http2 from "node:http2"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { cacheHttp2SessionForTests, closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"
import { sessionManager } from "../src/session.js"
import { resetTurnStateForTests } from "../src/language-model.js"
import { resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"

const ORIGIN = "https://agentn.held-run-test.cursor.sh"
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const

let server: http2.Http2Server
let client: http2.ClientHttp2Session
let runStream: http2.ServerHttp2Stream | undefined
/** Everything the client sent on the Run after its run_request. */
let received: Array<Record<string, any>> = []
const savedProxy: Record<string, string | undefined> = {}

function frame(payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, Buffer.from(payload)])
}

function send(message: Record<string, unknown>): void {
  runStream!.write(frame(encodeMessage("AgentServerMessage", message)))
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
        const message = decodeMessage<Record<string, any>>("AgentClientMessage", pending.subarray(5, 5 + length))
        pending = pending.subarray(5 + length)
        if (message.run_request) {
          runStream = stream
          send({ exec_server_message: { id: 0, shell_args: { command: "sleep 600", tool_call_id: "call-shell" } } })
        } else {
          received.push(message)
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

afterEach(() => {
  sessionManager.dispose()
  resetTurnStateForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
  runStream = undefined
  received = []
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const kinds = () => received.map((message) => Object.keys(message)[0])
const execHeartbeats = () => received.filter((message) => message.exec_client_control_message?.heartbeat).length

async function streamParts(root: string, prompt: LanguageModelV3Prompt): Promise<Array<Record<string, any>>> {
  cacheHttp2SessionForTests(ORIGIN, client)
  const model = createCursor({ name: "cursor", accessToken: "test-token", agentBaseURL: ORIGIN, cacheDir: root })
    .languageModel("composer-2.5")
  const { stream } = await model.doStream({
    prompt,
    tools: [{ type: "function", name: "bash", description: "Run a shell command", inputSchema: { type: "object", properties: { command: { type: "string" } } } }],
    headers: { "x-opencode-session-id": "ses_held_run" },
  } as LanguageModelV3CallOptions)
  const parts: Array<Record<string, any>> = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return parts
    parts.push(value as Record<string, any>)
  }
}

describe("a Run held on a host tool", () => {
  it("answers KV and honours an abort before the tool returns", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-held-run-"))
    try {
      const prompt: LanguageModelV3Prompt = [{ role: "user", content: [{ type: "text", text: "run it" }] }]
      const first = await streamParts(root, prompt)
      const call = first.find((part) => part.type === "tool-call")!
      expect(call.toolName).toBe("bash")

      // The host is still running the tool. As seen live, Cursor first lists the call
      // and checkpoints, then writes blobs.
      send({ interaction_update: { tool_requests_listed: { call_count: 1 } } })
      send({ conversation_checkpoint_update: Uint8Array.from([0x0a, 0x00]) })
      send({ interaction_update: { heartbeat: {} } })
      send({ kv_server_message: { id: 5, set_blob_args: { blob_id: new Uint8Array(32).fill(5), blob_data: Uint8Array.from([9]) } } })
      await wait(100)
      expect(received.find((message) => message.kv_client_message)?.kv_client_message.id).toBe(5)

      // The exec is heartbeated while it is owed, and no longer once Cursor aborts it.
      await wait(3_300)
      expect(execHeartbeats()).toBeGreaterThan(0)
      send({ exec_server_control_message: { abort: { id: 0 } } })
      await wait(100)
      const afterAbort = execHeartbeats()
      send({ interaction_update: { text_delta: { text: "Stopped waiting on the shell." } } })
      send({ interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } })
      await wait(3_300)
      expect(execHeartbeats()).toBe(afterAbort)

      // The tool finally returns: its result is dropped, and Cursor's later output reaches the host.
      const second = await streamParts(root, [
        ...prompt,
        { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: "bash", input: { command: "sleep 600" } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: "bash", output: { type: "text", value: "late output" } }] },
      ] as LanguageModelV3Prompt)
      expect(kinds()).not.toContain("exec_client_message")
      expect(second.filter((part) => part.type === "text-delta").map((part) => part.delta).join("")).toBe("Stopped waiting on the shell.")
      expect(second.at(-1)?.type).toBe("finish")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it("applies an abort that arrives right behind its exec request while another exec runs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-held-run-"))
    try {
      const prompt: LanguageModelV3Prompt = [{ role: "user", content: [{ type: "text", text: "run it" }] }]
      const first = await streamParts(root, prompt)
      const call0 = first.find((part) => part.type === "tool-call")!

      // While exec 0 runs, Cursor lists a call, requests exec 1 and aborts it at once.
      send({ interaction_update: { tool_requests_listed: { call_count: 1 } } })
      send({ exec_server_message: { id: 1, shell_args: { command: "sleep 8", tool_call_id: "call-shell-1" } } })
      send({ exec_server_control_message: { abort: { id: 1 } } })
      await wait(100)

      // Exec 0 returns; the pump emits exec 1 from the queue and ends the step there.
      const history: LanguageModelV3Prompt = [
        ...prompt,
        { role: "assistant", content: [{ type: "tool-call", toolCallId: call0.toolCallId, toolName: "bash", input: { command: "sleep 600" } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: call0.toolCallId, toolName: "bash", output: { type: "text", value: "done" } }] },
      ] as LanguageModelV3Prompt
      const second = await streamParts(root, history)
      const call1 = second.find((part) => part.type === "tool-call")!
      expect(call1?.toolCallId.endsWith("_1")).toBe(true)

      // Exec 1 was aborted before the host ran it: no heartbeats while the host runs it anyway.
      await wait(3_300)
      expect(received.filter((message) => message.exec_client_control_message?.heartbeat?.id === 1)).toHaveLength(0)

      // Its late result is dropped, and Cursor's later output reaches the host.
      send({ interaction_update: { text_delta: { text: "Skipped the second shell." } } })
      send({ interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } })
      const third = await streamParts(root, [
        ...history,
        { role: "assistant", content: [{ type: "tool-call", toolCallId: call1.toolCallId, toolName: "bash", input: { command: "sleep 8" } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: call1.toolCallId, toolName: "bash", output: { type: "text", value: "late" } }] },
      ] as LanguageModelV3Prompt)
      expect(received.filter((message) => message.exec_client_message?.id === 1)).toHaveLength(0)
      expect(third.filter((part) => part.type === "text-delta").map((part) => part.delta).join("")).toBe("Skipped the second shell.")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
