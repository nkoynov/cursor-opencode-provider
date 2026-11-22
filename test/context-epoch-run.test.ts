import { afterAll, afterEach, beforeAll, expect, it } from "bun:test"
import fs from "node:fs/promises"
import http2 from "node:http2"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { createCursor } from "../src/index.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { resetContextEpochsForTests } from "../src/context/epoch.js"
import { resetTurnStateForTests, settleRunSavesForTests } from "../src/language-model.js"
import { CURSOR_VARIANT_PARAMETERS_KEY, cacheFilePath, mapAvailableModelsResponse, writeCache } from "../src/models.js"
import { resetConversationBindingsForTests } from "../src/protocol/conversation-bind.js"
import { resetConversationPersistenceForTests } from "../src/protocol/conversation-persistence.js"
import { resetCheckpointsForTests } from "../src/protocol/checkpoint.js"
import { decodeFramePayload } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { sessionManager } from "../src/session.js"
import { MODEL_CACHE_SCHEMA_VERSION } from "../src/shared.js"
import { cacheHttp2SessionForTests, closeCachedHttp2SessionsForTests } from "../src/transport/connect.js"

const ORIGIN = "https://agentn.context-epoch-run-test.cursor.sh"
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] as const
const savedProxy = new Map<string, string | undefined>()
const runTexts: string[] = []
let server: http2.Http2Server
let client: http2.ClientHttp2Session

function frame(payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, Buffer.from(payload)])
}

beforeAll(async () => {
  for (const key of PROXY_KEYS) {
    savedProxy.set(key, process.env[key])
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
        const message = decodeMessage<Record<string, any>>(
          "AgentClientMessage", decodeFramePayload({ flags: pending[0]!, payload: pending.subarray(5, 5 + length) }),
        )
        pending = pending.subarray(5 + length)
        if (!message.run_request) continue
        runTexts.push(message.run_request.action.user_message_action.user_message.text as string)
        for (const reply of [
          { interaction_update: { text_delta: { text: "Done." } } },
          { conversation_checkpoint_update: Uint8Array.from([0x0a, 0x00]) },
          { interaction_update: { turn_ended: { input_tokens: 10, output_tokens: 1 } } },
        ]) stream.write(frame(encodeMessage("AgentServerMessage", reply)))
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

afterEach(() => {
  sessionManager.dispose()
  resetTurnStateForTests()
  resetContextEpochsForTests()
  resetConversationBindingsForTests()
  resetConversationPersistenceForTests()
  resetCheckpointsForTests()
  setHostCacheDirOverride(undefined)
  runTexts.length = 0
})

afterAll(async () => {
  closeCachedHttp2SessionsForTests()
  client?.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const key of PROXY_KEYS) {
    const value = savedProxy.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

it("sends a host instruction change again after a stale model cache refused the turn", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-epoch-stale-cache-"))
  const parameters = [{ id: "reasoning_effort", value: "high" }, { id: "fast", value: "true" }]
  const writeModels = () => writeCache(directory, {
    models: mapAvailableModelsResponse({ models: [{ name: "grok-4.7", variants: [
      { parameterValues: parameters, isDefaultNonMaxConfig: true },
    ] }] }),
    fetchedAt: Date.now(),
    schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
  })
  const turn = (system: string, prompt: LanguageModelV3CallOptions["prompt"]) => ({
    prompt: [{ role: "system", content: system }, ...prompt],
    tools: [{ type: "function", name: "read", description: "Read", inputSchema: { type: "object", properties: {} } }],
    providerOptions: { cursor: { [CURSOR_VARIANT_PARAMETERS_KEY]: parameters } },
    headers: { "x-opencode-session-id": "ses_epoch_stale_cache" },
  }) as LanguageModelV3CallOptions
  const drain = async (call: LanguageModelV3CallOptions) => {
    const { stream } = await model.doStream(call)
    const reader = stream.getReader()
    while (!(await reader.read()).done) { /* consume */ }
    await settleRunSavesForTests()
  }
  cacheHttp2SessionForTests(ORIGIN, client)
  const model = createCursor({ name: "cursor", accessToken: "example-token", cacheDir: directory, agentBaseURL: ORIGIN })
    .languageModel("grok-4.7")
  try {
    await writeModels()
    await drain(turn("Host rules A.", [{ role: "user", content: [{ type: "text", text: "Hello" }] }]))
    const second = turn("Host rules B.", [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
      { role: "user", content: [{ type: "text", text: "Again" }] },
    ])
    await fs.unlink(cacheFilePath(directory))
    await expect(model.doStream(second)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining("no cached variants") }),
    })
    expect(runTexts).toHaveLength(1)

    await writeModels()
    await drain(second)
    expect(runTexts).toHaveLength(2)
    expect(runTexts[1]).toContain("Host system instructions were updated")
    expect(runTexts[1]).toContain("Host rules B.")
  } finally {
    await settleRunSavesForTests()
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 30_000)
