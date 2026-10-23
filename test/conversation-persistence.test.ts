import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import {
  conversationCacheDirectoryPath,
  conversationCacheFilePath,
  getPersistedConversation,
  loadPersistedConversation,
  persistConversation,
  resetConversationPersistenceForTests,
  setConversationPersistenceHookForTests,
  waitForConversationMaintenanceForTests,
} from "../src/protocol/conversation-persistence.js"
import { notifyHostInterrupt } from "../src/host-interrupt.js"
import {
  hydrateConversationState,
  persistConversationState,
} from "../src/protocol/conversation-state.js"
import {
  bindConversationId,
  MAX_ACTIVE_CONVERSATION_BINDINGS,
  resetConversationBindingsForTests,
  restoreConversationBinding,
} from "../src/protocol/conversation-bind.js"
import {
  getCheckpoint,
  resetCheckpointsForTests,
  setCheckpoint,
  checkpointTokenDetails,
} from "../src/protocol/checkpoint.js"
import {
  getConversationBlob,
  resetConversationBlobsForTests,
  setConversationBlob,
} from "../src/protocol/blob-store.js"
import {
  getFrozenRequestContext,
  resetFrozenRequestContextsForTests,
  setFrozenRequestContext,
} from "../src/context/frozen.js"
import {
  confirmHistoryImagesAtTurnEnd,
  heldHistoryImageHashes,
  noteHistoryImageCheckpoint,
  noteHistoryImagesSent,
  runHistoryImages,
  snapshotHeldHistoryImagesForTests,
} from "../src/protocol/sent-history-images.js"
import { CONVERSATION_CACHE_SCHEMA_VERSION, CONVERSATION_CACHE_TTL_MS } from "../src/shared.js"
import { recordSessionEditsGuidance, sessionEditsGuidance } from "../src/protocol/session-edits.js"
import { encodeMessage } from "../src/protocol/messages.js"
import {
  pump,
  resetTurnStateForTests,
  resolveTurnToolState,
  restoreTurnToolCatalog,
  settleTerminalCheckpointSavesForTests,
} from "../src/language-model.js"
import type { CursorSession, Frame } from "../src/session.js"
import { forgetEarlySteers, recordEarlySteer, serializeEarlySteers } from "../src/host-steer.js"
import { checkpointKey, resetLostRequestsForTests, serializeLostRequest } from "../src/lost-request.js"
import { parseModelFallbackStop } from "../src/model-fallback.js"
import { sessionFixture } from "./session-fixture.js"

const roots: string[] = []

function varint(value: number): Buffer {
  const out: number[] = []
  while (value >= 0x80) {
    out.push((value % 0x80) | 0x80)
    value = Math.floor(value / 0x80)
  }
  out.push(value)
  return Buffer.from(out)
}

async function cacheRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cursor-conversation-cache-"))
  roots.push(root)
  return root
}

async function clearMemory(): Promise<void> {
  await settleTerminalCheckpointSavesForTests()
  resetConversationPersistenceForTests()
  resetConversationBindingsForTests()
  resetCheckpointsForTests()
  resetConversationBlobsForTests()
  resetFrozenRequestContextsForTests()
  resetTurnStateForTests()
}

function turnEndedSession(root: string, checkpoint: Uint8Array | undefined): CursorSession {
  const payloads = [
    ...(checkpoint ? [encodeMessage("AgentServerMessage", { conversation_checkpoint_update: checkpoint })] : []),
    encodeMessage("AgentServerMessage", {
      interaction_update: { turn_ended: { input_tokens: 3, output_tokens: 1 } },
    }),
  ]
  let index = 0
  const frames: AsyncIterator<Frame> = {
    next: async () => index < payloads.length
      ? { done: false, value: { flags: 0, payload: payloads[index++]! } }
      : { done: true, value: undefined },
  }
  return sessionFixture({
    sessionId: "turn-ended-persistence",
    conversationId: "turn-ended-conversation",
    cacheDir: root,
    openCodeSessionId: "ses_turn_ended",
    stream: {
      write() {},
      end() {},
      destroy() {},
      frames: () => ({ [Symbol.asyncIterator]: () => frames }),
      isClosed: () => false,
      onTerminal: () => () => {},
    },
    frames,
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolDescriptors: [],
    requestContext: { rules_info_complete: true },
    allowTools: true,
    usageEstimate: {
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningTokens: 0,
    },
    pumpActive: true,
    heartbeat: null,
  })
}

describe("conversation restart persistence", () => {
  beforeEach(clearMemory)

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  })

  it("persists measured occupancy independently of the zero-token resume checkpoint", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_occupancy_restart"
    const conversationId = "conversation-occupancy-restart"
    // Independently specified protobuf #5: used_tokens=42, max_tokens=256.
    const measured = Uint8Array.of(0x2a, 5, 8, 42, 16, 0x80, 2)
    const terminal = Uint8Array.of(0x2a, 5, 8, 0, 16, 0x80, 2)
    restoreConversationBinding(sessionKey, conversationId)
    setCheckpoint(conversationId, measured)
    setCheckpoint(conversationId, terminal)
    await persistConversationState(root, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })
    const file = conversationCacheFilePath(root, sessionKey)
    const raw = gunzipSync(await readFile(file))
    // Private cache field #18 (wire type 2) holds only the measured field #5.
    expect(raw.includes(Buffer.from([0x92, 1, measured.length, ...measured]))).toBe(true)
    await clearMemory()
    await hydrateConversationState(root, sessionKey)
    expect(getCheckpoint(conversationId)).toEqual(terminal)
    expect(checkpointTokenDetails(conversationId, terminal)?.usedTokens).toBe(42)

    // Wrong wire type for #18 invalidates the snapshot rather than trusting it.
    await writeFile(file, gzipSync(Buffer.concat([raw, Buffer.from([0x90, 1, 1])])))
    await clearMemory()
    expect((await loadPersistedConversation(root, sessionKey)).status).toBe("invalid")
  })

  it("persists whether a session edit deny was ever sent, so a restart adds no needless correction", async () => {
    const root = await cacheRoot()
    const requestContext = { rules_info_complete: true }
    const checkpoint = Uint8Array.of(0x2a, 5, 8, 42, 16, 0x80, 2)
    const save = async (sessionKey: string, conversationId: string, denied: boolean) => {
      restoreConversationBinding(sessionKey, conversationId)
      setCheckpoint(conversationId, checkpoint)
      recordSessionEditsGuidance(conversationId, denied)
      await persistConversationState(root, { sessionKey, conversationId, requestContext })
      return gunzipSync(await readFile(conversationCacheFilePath(root, sessionKey)))
    }
    // Private cache field #19 (varint): tag 0x98 0x01, value 1.
    const marker = Buffer.from([0x98, 1, 1])
    expect((await save("ses_never_denied", "conv-never-denied", false)).includes(marker)).toBe(false)
    expect((await save("ses_was_denied", "conv-was-denied", true)).includes(marker)).toBe(true)

    await clearMemory()
    await hydrateConversationState(root, "ses_never_denied")
    await hydrateConversationState(root, "ses_was_denied")
    const carried = { carriesEarlierState: true }
    expect(sessionEditsGuidance("conv-never-denied", false, carried)).toBeUndefined()
    expect(sessionEditsGuidance("conv-was-denied", false, carried)).toBe(false)

    // Wrong wire type for #19 invalidates the snapshot rather than trusting it.
    const file = conversationCacheFilePath(root, "ses_was_denied")
    const raw = gunzipSync(await readFile(file))
    await writeFile(file, gzipSync(Buffer.concat([raw, Buffer.from([0x9a, 1, 0])])))
    await clearMemory()
    expect((await loadPersistedConversation(root, "ses_was_denied")).status).toBe("invalid")
  })

  it("restores the complete resumable state after process memory is cleared", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_restart"
    const conversationId = "conversation-after-compaction"
    const checkpoint = Uint8Array.from([1, 2, 3, 255])
    const blobId = Uint8Array.from([10, 11, 12])
    const blobData = Uint8Array.from([0, 4, 8, 12])
    const requestContext = {
      tools: [{
        name: "opencode-read",
        tool_name: "read",
        provider_identifier: "opencode",
        input_schema: Uint8Array.from([123, 125]),
      }],
      env: { process_working_directory: "/tmp/project", workspace_paths: ["/tmp/project"] },
      rules_info_complete: true,
    }
    const toolCatalog = [{
      name: "read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    }]
    restoreConversationBinding(sessionKey, conversationId)
    setCheckpoint(conversationId, checkpoint)
    setConversationBlob(conversationId, blobId, blobData)
    setFrozenRequestContext(conversationId, requestContext)
    await persistConversationState(root, {
      sessionKey,
      conversationId,
      requestContext,
      toolCatalog,
      hostAgent: "plan",
      systemPromptHash: "stable-prompt-hash",
    })

    await clearMemory()
    const hydrated = await hydrateConversationState(root, sessionKey)
    expect(hydrated?.conversationId).toBe(conversationId)
    expect(hydrated?.toolCatalog).toEqual(toolCatalog)
    expect(hydrated?.hostAgent).toBe("plan")
    expect(hydrated?.systemPromptHash).toBe("stable-prompt-hash")
    restoreTurnToolCatalog(sessionKey, hydrated!.toolCatalog)
    // Host-empty lifecycle turns advertise [] (title / OC1 compaction). The
    // hydrated catalog is still available for the next nonempty turn.
    expect(await resolveTurnToolState({ sessionKey, incomingTools: [], isCompaction: false }))
      .toEqual({ advertisedTools: [], allowTools: false })
    expect(await resolveTurnToolState({ sessionKey, incomingTools: [], isCompaction: true }))
      .toEqual({ advertisedTools: [], allowTools: false })
    expect(await resolveTurnToolState({ sessionKey, incomingTools: toolCatalog, isCompaction: false }))
      .toEqual({ advertisedTools: toolCatalog, allowTools: true })
    expect(bindConversationId(sessionKey).conversationId).toBe(conversationId)
    expect(getCheckpoint(conversationId)).toEqual(checkpoint)
    expect(getConversationBlob(conversationId, blobId)).toEqual(blobData)
    const restoredContext = getFrozenRequestContext(conversationId)
    expect(restoredContext).toMatchObject({ env: requestContext.env, rules_info_complete: true })
    expect(restoredContext?.tools).toBeUndefined()
  })

  it("keeps across a restart the history images the saved checkpoint holds", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_restart_images"
    const conversationId = "conversation-with-images"
    const checkpoint = Uint8Array.from([1])
    restoreConversationBinding(sessionKey, conversationId)
    setCheckpoint(conversationId, checkpoint)
    const run = runHistoryImages()
    noteHistoryImagesSent(run, ["a", "b"])
    noteHistoryImageCheckpoint(run, sessionKey, conversationId, checkpoint)
    confirmHistoryImagesAtTurnEnd(run, sessionKey, conversationId, checkpoint)
    await persistConversationState(root, { sessionKey, conversationId, requestContext: { rules_info_complete: true } })

    await clearMemory()
    expect(snapshotHeldHistoryImagesForTests(sessionKey)).toEqual([])
    await hydrateConversationState(root, sessionKey)
    expect([...heldHistoryImageHashes(sessionKey, conversationId, getCheckpoint(conversationId)!) ?? []]).toEqual(["a", "b"])
  })

  it("saves no history images beside a checkpoint that does not hold them", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_restart_images_mid_turn"
    const conversationId = "conversation-mid-turn"
    restoreConversationBinding(sessionKey, conversationId)
    const run = runHistoryImages()
    noteHistoryImagesSent(run, ["a"])
    noteHistoryImageCheckpoint(run, sessionKey, conversationId, Uint8Array.from([1]))
    confirmHistoryImagesAtTurnEnd(run, sessionKey, conversationId, Uint8Array.from([1]))
    // A held Run's save after Cursor moved on to a checkpoint nothing was confirmed for.
    setCheckpoint(conversationId, Uint8Array.from([2]))
    await persistConversationState(root, { sessionKey, conversationId, requestContext: { rules_info_complete: true }, runInProgress: true })

    const saved = await getPersistedConversation(root, sessionKey)
    expect(saved?.sentImageHashes).toBeUndefined()
    expect(saved?.sentImagesCheckpoint).toBeUndefined()
    await clearMemory()
    await hydrateConversationState(root, sessionKey)
    expect(snapshotHeldHistoryImagesForTests(sessionKey)).toEqual([])
  })

  it("restores no history images from a snapshot written before they were saved with their checkpoint", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_old_snapshot"
    const conversationId = "conversation-old-snapshot"
    await persistConversation(root, {
      sessionKey,
      conversationId,
      checkpoint: Uint8Array.from([1]),
      blobs: [],
      requestContext: { rules_info_complete: true },
      toolCatalog: [],
      postCompactionRebase: false,
    })
    await clearMemory()
    await hydrateConversationState(root, sessionKey)
    expect(snapshotHeldHistoryImagesForTests(sessionKey)).toEqual([])

    // A hash list without the checkpoint it belongs to (field 16 alone) counts for nothing.
    const filePath = conversationCacheFilePath(root, sessionKey)
    const hash = Buffer.from("a".repeat(64))
    const field16 = Buffer.concat([Buffer.from([0x82, 0x01, hash.length]), hash])
    await writeFile(filePath, gzipSync(Buffer.concat([gunzipSync(await readFile(filePath)), field16])))
    await clearMemory()
    expect((await getPersistedConversation(root, sessionKey))?.sentImageHashes).toBeUndefined()
    await clearMemory()
    await hydrateConversationState(root, sessionKey)
    expect(snapshotHeldHistoryImagesForTests(sessionKey)).toEqual([])
  })

  it("saves history image hashes on field 16 and their checkpoint on field 17", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_image_fields"
    const hashes = ["a".repeat(64), "b".repeat(64)]
    const checkpoint = "c".repeat(64)
    const text = (value: string) => {
      const bytes = Buffer.from(value)
      return [...(bytes.length < 0x80 ? [bytes.length] : [(bytes.length & 0x7f) | 0x80, bytes.length >> 7]), ...bytes]
    }
    const fields = Buffer.from([
      0x82, 0x01, ...text(hashes[0]!), // sent_image_hashes #16
      0x82, 0x01, ...text(hashes[1]!), // sent_image_hashes #16
      0x8a, 0x01, ...text(checkpoint), // sent_images_checkpoint_sha256 #17
    ])
    const earlySteers = JSON.stringify({ version: 1, records: [] })
    const lostRequest = JSON.stringify({ conversationId: "conversation-image-fields", checkpointKey: "k", text: "lost" })
    const modelFallbackStop = "model-fallback-stop"
    const snapshot = {
      sessionKey,
      conversationId: "conversation-image-fields",
      checkpoint: Uint8Array.from([1]),
      blobs: [],
      requestContext: { rules_info_complete: true },
      toolCatalog: [],
      postCompactionRebase: false,
      earlySteers,
      lostRequest,
      modelFallbackStop,
    }
    const filePath = conversationCacheFilePath(root, sessionKey)

    await persistConversation(root, { ...snapshot, sentImageHashes: hashes, sentImagesCheckpoint: checkpoint })
    const saved16and17 = gunzipSync(await readFile(filePath))
    expect(saved16and17.includes(fields)).toBe(true)
    expect(saved16and17.includes(Buffer.from([0x72, ...text(earlySteers)]))).toBe(true) // early_steers_json #14
    expect(saved16and17.includes(Buffer.from([0x7a, ...text(lostRequest)]))).toBe(true) // lost_request_json #15
    expect(saved16and17.includes(Buffer.from([0xaa, 0x06, ...text(modelFallbackStop)]))).toBe(true) // #101

    await persistConversation(root, snapshot)
    const withoutImages = gunzipSync(await readFile(filePath))
    expect(withoutImages.includes(fields)).toBe(false)
    await writeFile(filePath, gzipSync(Buffer.concat([withoutImages, fields])))
    await clearMemory()
    const saved = await getPersistedConversation(root, sessionKey)
    expect(saved?.sentImageHashes).toEqual(hashes)
    expect(saved?.sentImagesCheckpoint).toBe(checkpoint)
    expect(saved?.earlySteers).toBe(earlySteers)
    expect(saved?.lostRequest).toBe(lostRequest)
    expect(saved?.modelFallbackStop).toBe(modelFallbackStop)
  })

  it("keeps the older checkpoint's images when a turn ends without a checkpoint of its own", async () => {
    const root = await cacheRoot()
    const older = Uint8Array.from([4, 5])
    const session = turnEndedSession(root, undefined)
    const sessionKey = session.openCodeSessionId!
    restoreConversationBinding(sessionKey, session.conversationId)
    setCheckpoint(session.conversationId, older)
    const before = runHistoryImages()
    noteHistoryImagesSent(before, ["a"])
    noteHistoryImageCheckpoint(before, sessionKey, session.conversationId, older)
    confirmHistoryImagesAtTurnEnd(before, sessionKey, session.conversationId, older)
    session.historyImages = runHistoryImages(heldHistoryImageHashes(sessionKey, session.conversationId, older))
    noteHistoryImagesSent(session.historyImages, ["b"])
    await pump(session, {
      enqueue() {},
      error(error: unknown) { throw error },
    } as unknown as ReadableStreamDefaultController<any>, { textId: "text", reasoningId: "reasoning" })
    await settleTerminalCheckpointSavesForTests()

    const saved = await getPersistedConversation(root, sessionKey)
    expect(saved?.checkpoint).toEqual(older)
    expect(saved?.sentImageHashes).toEqual(["a"])
    await clearMemory()
    await hydrateConversationState(root, sessionKey)
    expect([...heldHistoryImageHashes(sessionKey, session.conversationId, older) ?? []]).toEqual(["a"])
  })

  it("takes the durable snapshot at the successful TurnEnded boundary", async () => {
    const root = await cacheRoot()
    const checkpoint = Uint8Array.from([7, 8, 9])
    const session = turnEndedSession(root, checkpoint)
    restoreConversationBinding(session.openCodeSessionId!, session.conversationId)
    session.postCompactionRebase = true
    session.hostAgent = "build"
    session.stableSystemPromptHash = "build-prompt-hash"
    session.toolCatalog = [{ name: "bash", inputSchema: { type: "object" } }]
    const parts: unknown[] = []
    await pump(session, {
      enqueue(part: unknown) { parts.push(part) },
      error(error: unknown) { throw error },
    } as unknown as ReadableStreamDefaultController<any>, { textId: "text", reasoningId: "reasoning" })

    await clearMemory()
    const restored = await getPersistedConversation(root, "ses_turn_ended")
    expect(restored?.conversationId).toBe("turn-ended-conversation")
    expect(restored?.checkpoint).toEqual(checkpoint)
    expect(restored?.postCompactionRebase).toBe(true)
    expect(restored?.toolCatalog).toEqual(session.toolCatalog)
    expect(restored?.hostAgent).toBe("build")
    expect(restored?.systemPromptHash).toBe("build-prompt-hash")
    expect(parts.some((part: any) => part.type === "finish")).toBe(true)
  })

  it("hands the turn's finish to the host before its snapshot is written, and a shutdown waits for the write", async () => {
    const root = await cacheRoot()
    const checkpoint = Uint8Array.from([3, 1, 4])
    const session = turnEndedSession(root, checkpoint)
    restoreConversationBinding(session.openCodeSessionId!, session.conversationId)
    let releaseWrite!: () => void
    const writeHeld = new Promise<void>((resolve) => { releaseWrite = resolve })
    let writeStarted = false
    setConversationPersistenceHookForTests(async (phase) => {
      if (phase !== "before-write") return
      writeStarted = true
      await writeHeld
    })
    try {
      const parts: Array<{ type: string }> = []
      await pump(session, {
        enqueue(part: { type: string }) { parts.push(part) },
        error(error: unknown) { throw error },
      } as unknown as ReadableStreamDefaultController<any>, { textId: "text", reasoningId: "reasoning" })
      expect(parts.some((part) => part.type === "finish")).toBe(true)
      for (let i = 0; i < 100 && !writeStarted; i++) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(writeStarted).toBe(true)
      expect(await getPersistedConversation(root, session.openCodeSessionId!)).toBeUndefined()

      let shutdownDone = false
      const shutdown = notifyHostInterrupt(undefined, "shutdown").then(() => { shutdownDone = true })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(shutdownDone).toBe(false)
      releaseWrite()
      await shutdown
    } finally {
      setConversationPersistenceHookForTests(undefined)
    }
    await clearMemory()
    expect((await getPersistedConversation(root, "ses_turn_ended"))?.checkpoint).toEqual(checkpoint)
  })

  it("keeps the early steers a turn answered in its TurnEnded snapshot", async () => {
    const root = await cacheRoot()
    const session = turnEndedSession(root, Uint8Array.from([7]))
    const sessionKey = session.openCodeSessionId!
    restoreConversationBinding(sessionKey, session.conversationId)
    const steer = (text: string, injectionId: string, delivered: boolean) => ({
      sessionID: sessionKey,
      inboxID: `msg_${injectionId}`,
      text,
      injectionId,
      run: session.sessionId,
      delivered,
      checkpointed: delivered,
      answered: false,
    })
    recordEarlySteer(steer("Also check the README", "inj_delivered", true))
    recordEarlySteer(steer("Not taken by this Run", "inj_other", false))
    try {
      await pump(session, {
        enqueue() {},
        error(error: unknown) { throw error },
      } as unknown as ReadableStreamDefaultController<any>, { textId: "text", reasoningId: "reasoning" })

      await clearMemory()
      const saved = await getPersistedConversation(root, sessionKey)
      expect(JSON.parse(saved!.earlySteers!).records).toMatchObject([{ text: "Also check the README", answered: true }])
      const filePath = conversationCacheFilePath(root, sessionKey)
      // Field 14 (tag 0x72) holds them, as upstream writes it.
      const bytes = gunzipSync(await readFile(filePath))
      expect(bytes.includes(Buffer.concat([Buffer.from([0x72]), varint(saved!.earlySteers!.length), Buffer.from(saved!.earlySteers!)]))).toBe(true)
    } finally {
      forgetEarlySteers(sessionKey)
    }
  })

  it("restores an older fork build's snapshot, whose field 14 holds answered-steer texts, without them", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_old_fork_snapshot"
    const conversationId = "conversation-old-fork"
    const fallbackStop = JSON.stringify({ servedModel: "claude-opus-4-8", userText: "Fix the build" })
    const bytes = (field: number, value: Uint8Array | string) => {
      const data = typeof value === "string" ? Buffer.from(value) : Buffer.from(value)
      return Buffer.concat([varint((field << 3) | 2), varint(data.length), data])
    }
    // The layout fork main f40dbcc wrote: answered_steers=14 (repeated), model_fallback_stop_json=15.
    const snapshot = Buffer.concat([
      varint(1 << 3), varint(CONVERSATION_CACHE_SCHEMA_VERSION),
      bytes(2, sessionKey),
      bytes(3, conversationId),
      varint(4 << 3), varint(Date.now()),
      bytes(5, Uint8Array.from([0x0a, 0x02, 0x08, 0x01])),
      bytes(7, encodeMessage("RequestContext", { rules_info_complete: true })),
      bytes(14, "Also check the README"),
      bytes(14, "{\"version\":1,\"records\":[]}"),
      bytes(14, "Then run the tests"),
      bytes(15, fallbackStop),
    ])
    await mkdir(conversationCacheDirectoryPath(root), { recursive: true })
    await writeFile(conversationCacheFilePath(root, sessionKey), gzipSync(snapshot))

    const loaded = await loadPersistedConversation(root, sessionKey)
    expect(loaded.status).toBe("restored")
    expect(loaded.value?.conversationId).toBe(conversationId)
    expect(loaded.value?.checkpoint).toEqual(Uint8Array.from([0x0a, 0x02, 0x08, 0x01]))
    expect(loaded.value?.modelFallbackStop).toBe(fallbackStop)
    expect(loaded.value?.earlySteers).toBeUndefined()

    await clearMemory()
    const hydrated = await hydrateConversationState(root, sessionKey)
    expect(hydrated).toMatchObject({ conversationId, modelFallbackStop: fallbackStop })
    expect(getCheckpoint(conversationId)).toEqual(Uint8Array.from([0x0a, 0x02, 0x08, 0x01]))
    expect(serializeEarlySteers(sessionKey)).toBeUndefined()
  })

  it("ignores a lone field-14 text that is not early-steer receipts", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_old_fork_one_steer"
    await persistConversation(root, {
      sessionKey,
      conversationId: "conversation-old-fork-one",
      checkpoint: Uint8Array.from([1]),
      blobs: [],
      requestContext: { rules_info_complete: true },
      toolCatalog: [],
      postCompactionRebase: false,
    })
    const filePath = conversationCacheFilePath(root, sessionKey)
    const text = Buffer.from("{not json")
    await writeFile(filePath, gzipSync(Buffer.concat([gunzipSync(await readFile(filePath)), Buffer.from([0x72, text.length]), text])))
    await clearMemory()

    const loaded = await loadPersistedConversation(root, sessionKey)
    expect(loaded.status).toBe("restored")
    expect(loaded.value?.checkpoint).toEqual(Uint8Array.from([1]))
    expect(loaded.value?.earlySteers).toBeUndefined()
  })

  describe("lost request (field 15) and model-fallback stop (field 101)", () => {
    const stop = {
      requestedModel: "claude-opus-5-5",
      servedModel: "claude-opus-4-8",
      userText: "Fix the build",
      checkpointHoldsTurn: false,
      unrecordedTools: [],
      message: "**Stopped:** Cursor served this step with claude-opus-4-8.",
    }
    const checkpoint = Uint8Array.from([0x0a, 0x02, 0x08, 0x01])
    const lost = (conversationId: string) => JSON.stringify({
      conversationId,
      checkpointKey: checkpointKey(checkpoint),
      text: "Create catalog.md",
      latest: "Create catalog.md",
    })
    const field = (number: number, value: Uint8Array | string) => {
      const data = Buffer.from(value)
      return Buffer.concat([varint((number << 3) | 2), varint(data.length), data])
    }
    const snapshot = (sessionKey: string, conversationId: string, ...extra: Buffer[]) => Buffer.concat([
      varint(1 << 3), varint(CONVERSATION_CACHE_SCHEMA_VERSION),
      field(2, sessionKey),
      field(3, conversationId),
      varint(4 << 3), varint(Date.now()),
      field(5, checkpoint),
      field(7, encodeMessage("RequestContext", { rules_info_complete: true })),
      ...extra,
    ])
    const write = async (root: string, sessionKey: string, bytes: Buffer) => {
      await mkdir(conversationCacheDirectoryPath(root), { recursive: true })
      await writeFile(conversationCacheFilePath(root, sessionKey), gzipSync(bytes))
    }
    beforeEach(() => resetLostRequestsForTests())

    it("moves an older fork build's model-fallback stop out of field 15 and never reads it as a lost request", async () => {
      const root = await cacheRoot()
      const sessionKey = "ses_old_fork_fallback"
      const conversationId = "conversation-old-fork-fallback"
      // Fork main 7f7ae9e: early_steers_json=14, model_fallback_stop_json=15, sent images 16/17.
      await write(root, sessionKey, snapshot(sessionKey, conversationId,
        field(15, JSON.stringify(stop)),
        field(16, "a".repeat(64)),
        field(17, "b".repeat(64)),
      ))

      const loaded = await loadPersistedConversation(root, sessionKey)
      expect(loaded.status).toBe("restored")
      expect(loaded.value?.lostRequest).toBeUndefined()
      expect(parseModelFallbackStop(loaded.value!.modelFallbackStop!)).toEqual(stop)
      expect(loaded.value?.sentImageHashes).toEqual(["a".repeat(64)])

      await clearMemory()
      await hydrateConversationState(root, sessionKey)
      expect(serializeLostRequest(sessionKey)).toBeUndefined()

      // Saved again, the stop moves to field 101 and field 15 stays empty.
      await persistConversation(root, { ...loaded.value!, sessionKey })
      const bytes = gunzipSync(await readFile(conversationCacheFilePath(root, sessionKey)))
      expect(bytes.includes(field(101, JSON.stringify(stop)))).toBe(true)
      expect(bytes.includes(field(15, JSON.stringify(stop)))).toBe(false)
    })

    it("does not turn any other older field-15 value into a lost request", async () => {
      const root = await cacheRoot()
      const sessionKey = "ses_old_fork_garbage"
      await write(root, sessionKey, snapshot(sessionKey, "conversation-garbage", field(15, "{not json")))

      const loaded = await loadPersistedConversation(root, sessionKey)
      expect(loaded.status).toBe("restored")
      expect(loaded.value?.lostRequest).toBeUndefined()
      expect(parseModelFallbackStop(loaded.value!.modelFallbackStop!)).toBeUndefined()
      await clearMemory()
      await hydrateConversationState(root, sessionKey)
      expect(serializeLostRequest(sessionKey)).toBeUndefined()
    })

    it("restores the lost request of an upstream snapshot", async () => {
      const root = await cacheRoot()
      const sessionKey = "ses_upstream_lost"
      const conversationId = "conversation-upstream-lost"
      // Upstream a1aa47a: early_steers_json=14, lostRequest=15, nothing above.
      await write(root, sessionKey, snapshot(sessionKey, conversationId,
        field(14, "{\"version\":1,\"records\":[]}"),
        field(15, lost(conversationId)),
      ))

      const loaded = await loadPersistedConversation(root, sessionKey)
      expect(loaded.value?.lostRequest).toBe(lost(conversationId))
      expect(loaded.value?.modelFallbackStop).toBeUndefined()
      await clearMemory()
      await hydrateConversationState(root, sessionKey)
      expect(JSON.parse(serializeLostRequest(sessionKey)!)).toEqual(JSON.parse(lost(conversationId)))
    })

    it("keeps both in a new snapshot, and field 101 over an older field-15 stop", async () => {
      const root = await cacheRoot()
      const sessionKey = "ses_new_fork"
      const conversationId = "conversation-new-fork"
      await persistConversation(root, {
        sessionKey,
        conversationId,
        checkpoint,
        blobs: [],
        requestContext: { rules_info_complete: true },
        toolCatalog: [],
        postCompactionRebase: false,
        lostRequest: lost(conversationId),
        modelFallbackStop: JSON.stringify(stop),
      })
      const bytes = gunzipSync(await readFile(conversationCacheFilePath(root, sessionKey)))
      expect(bytes.includes(field(15, lost(conversationId)))).toBe(true)
      expect(bytes.includes(field(101, JSON.stringify(stop)))).toBe(true)
      await clearMemory()
      const loaded = await loadPersistedConversation(root, sessionKey)
      expect(loaded.value).toMatchObject({ lostRequest: lost(conversationId), modelFallbackStop: JSON.stringify(stop) })

      const mixedKey = "ses_mixed_fields"
      const newer = { ...stop, userText: "the newer stop" }
      await write(root, mixedKey, snapshot(mixedKey, "conversation-mixed",
        field(15, JSON.stringify(stop)),
        field(101, JSON.stringify(newer)),
      ))
      const mixed = await loadPersistedConversation(root, mixedKey)
      expect(parseModelFallbackStop(mixed.value!.modelFallbackStop!)).toEqual(newer)
      expect(mixed.value?.lostRequest).toBeUndefined()
    })
  })

  it("does not migrate legacy JSON snapshots", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_legacy_json"
    const legacyPath = conversationCacheFilePath(root, sessionKey).replace(/\.pb\.gz$/, ".json")
    await mkdir(conversationCacheDirectoryPath(root), { recursive: true })
    await writeFile(legacyPath, JSON.stringify({ schemaVersion: 2, conversation: {} }))

    await waitForConversationMaintenanceForTests(root)

    await expect(stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await loadPersistedConversation(root, sessionKey)).status).toBe("missing")
  })

  it("does not let a late TurnEnded resurrect a superseded conversation", async () => {
    const root = await cacheRoot()
    restoreConversationBinding("ses_late", "current-conversation")
    await persistConversationState(root, {
      sessionKey: "ses_late",
      conversationId: "superseded-conversation",
      requestContext: { rules_info_complete: true },
    })
    expect(await getPersistedConversation(root, "ses_late")).toBeUndefined()
  })

  it("persists a reminted conversation after its recent binding is soft-evicted", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_evicted_remint"
    bindConversationId(sessionKey)
    const conversationId = bindConversationId(sessionKey, { reset: true }).conversationId
    const checkpoint = Uint8Array.from([7, 8, 9])
    setCheckpoint(conversationId, checkpoint)

    for (let i = 0; i < MAX_ACTIVE_CONVERSATION_BINDINGS; i++) {
      bindConversationId(`pressure-${i}`)
    }

    await persistConversationState(root, {
      sessionKey,
      conversationId,
      requestContext: { rules_info_complete: true },
    })
    await clearMemory()
    const restored = await hydrateConversationState(root, sessionKey)
    expect(restored?.conversationId).toBe(conversationId)
    expect(getCheckpoint(conversationId)).toEqual(checkpoint)
  })

  it("refreshes one session record instead of retaining its prior conversation id", async () => {
    const root = await cacheRoot()
    const now = 1_900_000_000_000
    const requestContext = { rules_info_complete: true }
    await persistConversation(root, {
      sessionKey: "ses_same",
      conversationId: "old-conversation",
      blobs: [],
      requestContext,
    }, now)
    await persistConversation(root, {
      sessionKey: "ses_same",
      conversationId: "new-conversation",
      checkpoint: Uint8Array.from([9]),
      blobs: [],
      requestContext,
    }, now + 1)

    const fileBytes = await readFile(conversationCacheFilePath(root, "ses_same"))
    expect([...fileBytes.subarray(0, 2)]).toEqual([0x1f, 0x8b])
    expect(gunzipSync(fileBytes)[0]).not.toBe("{".charCodeAt(0))
    await clearMemory()
    expect(await getPersistedConversation(root, "ses_same")).toMatchObject({
      conversationId: "new-conversation",
      updatedAt: now + 1,
    })
  })

  it("prunes records older than 24 hours in maintenance but keeps the exact boundary", async () => {
    const staleRoot = await cacheRoot()
    const boundaryRoot = await cacheRoot()
    const writtenAt = 1_900_000_000_000
    const value = {
      sessionKey: "ses_age",
      conversationId: "aged-conversation",
      blobs: [],
      requestContext: { rules_info_complete: true },
    }
    await persistConversation(staleRoot, value, writtenAt)
    await persistConversation(boundaryRoot, value, writtenAt)

    await clearMemory()
    await waitForConversationMaintenanceForTests(staleRoot, writtenAt + CONVERSATION_CACHE_TTL_MS + 1)
    expect((await loadPersistedConversation(staleRoot, value.sessionKey)).status).toBe("expired")
    await expect(stat(conversationCacheFilePath(staleRoot, value.sessionKey)))
      .rejects.toMatchObject({ code: "ENOENT" })

    await clearMemory()
    await waitForConversationMaintenanceForTests(boundaryRoot, writtenAt + CONVERSATION_CACHE_TTL_MS)
    expect((await getPersistedConversation(boundaryRoot, value.sessionKey))?.conversationId)
      .toBe(value.conversationId)
    expect((await stat(conversationCacheFilePath(boundaryRoot, value.sessionKey))).isFile()).toBe(true)
  })

  it("serializes overlapping updates without losing either session", async () => {
    const root = await cacheRoot()
    const requestContext = { rules_info_complete: true }
    await Promise.all([
      persistConversation(root, {
        sessionKey: "ses_a",
        conversationId: "conversation-a",
        blobs: [],
        requestContext,
      }),
      persistConversation(root, {
        sessionKey: "ses_b",
        conversationId: "conversation-b",
        blobs: [],
        requestContext,
      }),
    ])

    await clearMemory()
    expect((await getPersistedConversation(root, "ses_a"))?.conversationId).toBe("conversation-a")
    expect((await getPersistedConversation(root, "ses_b"))?.conversationId).toBe("conversation-b")
    const files = (await readdir(conversationCacheDirectoryPath(root)))
      .filter((name) => name.endsWith(".pb.gz"))
    expect(files).toHaveLength(2)
    expect(conversationCacheFilePath(root, "ses_a")).not.toBe(conversationCacheFilePath(root, "ses_b"))
  })

  it("does not lose an unrelated session written by another process with stale startup state", async () => {
    const root = await cacheRoot()
    const persistenceModule = new URL("../src/protocol/conversation-persistence.ts", import.meta.url).href
    const childScript = `
      const persistence = await import(${JSON.stringify(persistenceModule)})
      const root = ${JSON.stringify(root)}
      await persistence.getPersistedConversation(root, "ses_child")
      process.stdout.write("ready\\n")
      await new Promise((resolve) => process.stdin.once("data", resolve))
      await persistence.persistConversation(root, {
        sessionKey: "ses_child",
        conversationId: "conversation-child",
        blobs: [],
        requestContext: { rules_info_complete: true },
      })
    `
    const child = Bun.spawn([process.execPath, "-e", childScript], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const reader = child.stdout.getReader()
    const ready = await reader.read()
    reader.releaseLock()
    expect(new TextDecoder().decode(ready.value)).toContain("ready")

    await persistConversation(root, {
      sessionKey: "ses_parent",
      conversationId: "conversation-parent",
      blobs: [],
      requestContext: { rules_info_complete: true },
    })
    child.stdin.write("continue\n")
    child.stdin.end()
    expect(await child.exited).toBe(0)

    await clearMemory()
    expect((await getPersistedConversation(root, "ses_parent"))?.conversationId)
      .toBe("conversation-parent")
    expect((await getPersistedConversation(root, "ses_child"))?.conversationId)
      .toBe("conversation-child")
  })

  it("discards a corrupt session record and uses private permissions for its replacement", async () => {
    const root = await cacheRoot()
    const sessionKey = "ses_corrupt"
    const filePath = conversationCacheFilePath(root, sessionKey)
    await mkdir(conversationCacheDirectoryPath(root), { recursive: true })
    await writeFile(filePath, "not protobuf gzip", "utf-8")
    await waitForConversationMaintenanceForTests(root)

    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await loadPersistedConversation(root, sessionKey)).status).toBe("invalid")
    await persistConversation(root, {
      sessionKey,
      conversationId: "replacement-conversation",
      blobs: [],
      requestContext: { rules_info_complete: true },
    })
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600)
      expect((await stat(conversationCacheDirectoryPath(root))).mode & 0o777).toBe(0o700)
    }
  })
})
