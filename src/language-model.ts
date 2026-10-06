import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { APICallError } from "@ai-sdk/provider"
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamResult, LanguageModelV3GenerateResult, LanguageModelV3StreamPart, LanguageModelV3Usage, LanguageModelV3FinishReason } from "@ai-sdk/provider"
import type { CreateCursorOptions, CursorRetryOptions } from "./index.js"
import {
  bidiRunStream,
  CursorRunInterruptedError,
  normalizeAgentRunOrigin,
  type BidiStream,
} from "./transport/connect.js"
import { trace, traceRequestContextPaths } from "./debug.js"
import { isExchangeableApiKey } from "./auth.js"
import { resolveBearerToken } from "./auth-renewal.js"
import { buildRunRequest, buildHeartbeat, buildExecHeartbeat, buildCancelAction } from "./protocol/request.js"
import { onHostInterrupt } from "./host-interrupt.js"
import { decodeFramePayload } from "./protocol/framing.js"
import { debugWalkTurnEnded, decodeMessage, encodeMessage } from "./protocol/messages.js"
import {
  parseExecServerMessage,
  buildToolCallPart,
  buildExecClientMessages,
  buildExecClientMessagesWithNote,
  resultCanCarryNote,
  execResultImages,
  type ToolResultInput,
  buildReadRejectionMessages,
  buildUnsupportedExecDeny,
  classifyMissingReadTarget,
  isUriReadTarget,
  resolveReadTargetPath,
  parseExecIdFromToolCallId,
  detectExecVariantField,
  buildRequestContextResult,
  buildMcpStateResult,
  buildListMcpResourcesFallback,
  buildReadMcpResourceFallback,
  buildCustomWebToolAliases,
  extractHostSubagentCatalog,
  toolsToDescriptors,
  resolveCustomWebToolAlias,
  remapNativeSubagentForCatalog,
  preferCorrelatedTaskDescription,
  remapCorrelatedEditWriteForCatalog,
  remapEditToolsForCatalog,
  buildCompleteEditReadMessages,
  buildTerminalFileReadMessages,
  rejectPartialReadMutation,
  binaryWritePayload,
  CUSTOM_WEBFETCH_TOOL,
  CUSTOM_WEBSEARCH_TOOL,
  CUSTOM_LIST_MCP_RESOURCES_TOOL,
  CUSTOM_READ_MCP_RESOURCE_TOOL,
  hostToolDialectFromTools,
  opencodePathArg,
  type OpencodeToolDef,
  type ParsedExecRequest,
} from "./protocol/tools.js"
import { buildGitDiffExecMessages } from "./protocol/git-diff.js"
import { cursorExecVariantByRequestField, describeCursorExecVariant } from "./protocol/exec-variants.js"
import { appendCheckpointUserGrounding, appendWorkspaceRootGrounding } from "./protocol/workspace-grounding.js"
import {
  progressOnlyContinuationPrompt,
  shouldContinueProgressOnlyTurn,
} from "./protocol/progress-continuation.js"
import {
  advertisedToolNamesFromDescriptors,
  extractExecDisplayCallId,
  extractProtobufSubmessage,
  listProtobufFieldNumbers,
  parseDisplayToolCall,
  resolveBridgedOpenCodeToolCall,
  isNativeDisplayToolCall,
  snapshotMirroredTodos,
  snapshotMirroredTodosFromReadOutput,
} from "./protocol/tool-call-bridge.js"
import { handleKvServerMessage } from "./protocol/kv.js"
import {
  buildAskQuestionInteractionReply,
  buildAsyncAskQuestionCompletion,
  buildCreatePlanInteractionReply,
  buildInjectUserMessage,
  buildSwitchModeInteractionReply,
  handleInteractionQuery,
} from "./protocol/interactions.js"
import {
  ASK_QUESTION_RESULT_FIELD,
  type CursorAskQuestionArgs,
  askQuestionResultFromToolOutput,
  askQuestionToolInput,
} from "./protocol/ask-question.js"
import {
  SWITCH_MODE_RESULT_FIELD,
  getActiveCursorMode,
  isBridgedCursorPlanModeActive,
  isCursorPlanModeActive,
  setActiveCursorMode,
  switchModeResultFromQuestionOutput,
  switchModeResultFromToolOutput,
  switchModeToolInput,
  takeActiveCursorModeReminder,
} from "./protocol/switch-mode.js"
import {
  CREATE_PLAN_NOT_APPROVED_REASON,
  CREATE_PLAN_RESULT_FIELD,
  CURSOR_PLAN_STAGE_TOOL,
  createPlanApproved,
  createPlanStageInput,
} from "./protocol/create-plan.js"
import {
  flushPlanExecutionKickoff,
  formatPlanKickoffPath,
  hasPlanExecutionKickoff,
  planExecutionKickoffState,
  planPathFromUri,
  queuePlanExecutionKickoff,
  takePlanExecutionKickoffWarning,
} from "./plan-execution-kickoff.js"
import {
  flushHostAgentModeSwitch,
  queueHostAgentModeSwitch,
} from "./host-agent-mode.js"
import {
  CURSOR_IMAGE_SAVE_TOOL,
  imageMimeForPath,
  remapCursorImageWritePath,
} from "./protocol/generate-image.js"
import { stageCursorImage } from "./image-staging.js"
import { IMAGE_PERMISSION_DENIED_PREFIX } from "./image-save.js"
import { clearCheckpoint, getCheckpoint, setCheckpoint } from "./protocol/checkpoint.js"
import {
  cursorContextUsageMetadata,
  decodeConversationTokenDetails,
  type CursorContextUsageSource,
  type CursorConversationTokenDetails,
} from "./protocol/token-details.js"
import {
  conversationBlobCount,
  inspectConversationBlobGraph,
  type ConversationBlobGraphStats,
} from "./protocol/blob-store.js"
import {
  bindConversationId,
  peekConversationId,
  resolveConversationGroupId,
} from "./protocol/conversation-bind.js"
import {
  beginEmittedStep,
  detectForeignHistory,
  recordEmittedPart,
  trackTurnProvenance,
  type ForeignHistoryReason,
} from "./protocol/turn-provenance.js"
import {
  clearPersistedConversationState,
  hydrateConversationState,
  hydrateTurnProvenance,
  persistConversationState,
} from "./protocol/conversation-state.js"
import { initializeConversationPersistence } from "./protocol/conversation-persistence.js"
import {
  resolveContinuationPolicy,
  sessionManager,
  stoppedWith,
  type CursorSession,
  type Frame,
  type PendingExec,
  type SteerInjection,
} from "./session.js"
import {
  CursorAuthError,
  CursorLocalCancellationError,
  CursorProtocolError,
  CursorProviderError,
  CursorRetryExhaustedError,
  CursorServerError,
  CursorTransportError,
  isRejectedCredentialError,
  isTransientGrpcStatus,
  retrySuppressedError,
  toCursorProviderError,
} from "./errors.js"
import { readCache, cacheFilePath, resolveVariantParameters, resolveVariantMaxMode, extractCursorVariantParameters, resolveCursorWireModelId, type ModelInfo } from "./models.js"
import { getFrozenRequestContext, getOrBuildRequestContext } from "./context/frozen.js"
import { systemInstructionsRuleText, type SystemInstructions } from "./context/build.js"
import { loadMergedConfig } from "./context/rules.js"
import {
  buildDynamicCatalogRoutingInstruction,
} from "./context/dynamic-catalog.js"
import {
  admitContextEpoch,
  appendMidConversationMessage,
  resetContextEpochsForTests,
} from "./context/epoch.js"
import { terminalsFolderFromRequestContext, workspaceRootFromRequestContext } from "./context/env.js"
import {
  ensureOpencodeProjectDir,
  opencodeGlobalCacheDir,
  setHostCacheDirOverride,
} from "./context/paths.js"
import { resolveAgentUrl } from "./agent-url.js"
import {
  CURSOR_API_HOST,
  CURSOR_COMPACTION_OPTION,
  CURSOR_HISTORY_REWRITE_OPTION,
  CURSOR_HOST_AGENT_OPTION,
} from "./shared.js"
import { isCompactionSession } from "./compaction-marker.js"
import { resolveSessionWorkspaceRoot } from "./session-directory.js"
import type { SeedHistoryMessage } from "./protocol/request.js"
import {
  assertCursorUserImageSupport,
  extractCursorPromptImages,
  extractCursorToolResultImages,
  type CursorImageInput,
} from "./image-input.js"
import { getDocumentedCursorModelContext, resolveCursorModelSupportsImages } from "./model-metadata.js"
import {
  consumeCursorShellResult,
  peekCursorShellResult,
  registerCursorShellCall,
  sweepStaleTerminalFiles,
  type CursorShellOutcome,
} from "./shell-timeout.js"
import { analyzeReplayFrame, AttemptReplaySafety } from "./replay-safety.js"
import { readAllFieldsStrict } from "./protocol/struct.js"
import {
  cursorUsageCountersFromTurnEnded,
  emptyLanguageModelV3Usage,
  formatCursorCacheDiagnostics,
  formatCursorTokenCategories,
  formatTurnUsageValidation,
  occupancyUsageFromTokenDetails,
  occupancyValidationCounters,
  OPENCODE_DISPLAY_ONLY_COST_METADATA,
  turnEndedCounter,
} from "./usage.js"

let _availableModels: ModelInfo[] | undefined
// mtime of the cache file the last time we loaded it. Compared on each call
// so discoverModels' background refresh is picked up without a process restart.
let _availableModelsMtimeMs = -1

// OpenCode omits tools from compaction calls. Keep the last real catalog per
// session so the new Cursor conversation is still born with tool definitions;
// execution remains disabled for the summary turn itself.
const toolCatalogBySession = new Map<string, OpencodeToolDef[]>()
const sentHistoryImageHashesBySession = new Map<string, Set<string>>()
// A compaction Run uses its own summary-agent system prompt. Its opaque Cursor
// checkpoint must never become the base for the resumed normal agent: doing so
// suppresses OpenCode's compacted prompt/system seed and makes Cursor narrate
// tool use instead of emitting exec requests. Rebase once on the next turn.
const postCompactionRebaseBySession = new Set<string>()
type PromptIdentity = { hostAgent?: string; systemPromptHash?: string }
const promptIdentityBySession = new Map<string, PromptIdentity>()
export const MAX_TURN_STATE_SESSIONS = 256
const MAX_SENT_HISTORY_IMAGES_PER_SESSION = 256
const DEFAULT_RETRY_POLICY = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
} as const
const MAX_RETRY_ATTEMPTS = 10
const MAX_RETRY_DELAY_MS = 30_000
const RUN_REQUEST_DECODE_FAILED = "CURSOR_RUN_REQUEST_DECODE_FAILED"
const RUN_REQUEST_UNSUPPORTED = "CURSOR_RUN_REQUEST_UNSUPPORTED"
const RUN_REPLY_FAILED = "CURSOR_RUN_REPLY_FAILED"
/**
 * Cursor CLI's conversation **export / transfer-to-cloud** path treats state
 * above 100 MiB as large (`conversation-export.ts` default `104857600`). That
 * budget must not remint a sticky conversation on resume — CLI soft-reuses.
 */
export const MAX_CHECKPOINT_BLOB_GRAPH_BYTES = 100 * 1024 * 1024

/** @deprecated Never remints; kept for call-site/tests. Always false. */
export function checkpointBlobGraphRequiresRebase(
  _stats: ConversationBlobGraphStats,
  _maxBytes = MAX_CHECKPOINT_BLOB_GRAPH_BYTES,
): boolean {
  return false
}

/** Warn-only concern for incomplete / oversized checkpoint graphs (no remint). */
export function checkpointBlobGraphConcern(
  stats: ConversationBlobGraphStats,
  maxBytes = MAX_CHECKPOINT_BLOB_GRAPH_BYTES,
): "incomplete-checkpoint-graph" | "oversized-checkpoint-graph" | undefined {
  if (!stats.complete) return "incomplete-checkpoint-graph"
  if (stats.bytes > maxBytes) return "oversized-checkpoint-graph"
  return undefined
}

type ResponseRequiredChannel = "exec" | "kv" | "interaction" | "multiple"
const RESPONSE_REQUIRED_CHANNEL_BY_FIELD = new Map<
  number,
  Exclude<ResponseRequiredChannel, "multiple">
>([
  [2, "exec"],
  [4, "kv"],
  [7, "interaction"],
])

function responseRequiredChannel(payload: Uint8Array): ResponseRequiredChannel | undefined {
  const fields = readAllFieldsStrict(payload)
  if (fields) {
    const channels = fields
      .map((field) => RESPONSE_REQUIRED_CHANNEL_BY_FIELD.get(field.fn))
      .filter((channel): channel is Exclude<ResponseRequiredChannel, "multiple"> => !!channel)
    if (channels.length > 1) return "multiple"
    return channels[0]
  }

  // Request tags are single-byte because all must-reply top-level fields are <16.
  const tag = payload[0]
  return tag !== undefined ? RESPONSE_REQUIRED_CHANNEL_BY_FIELD.get(tag >> 3) : undefined
}

// AgentServerMessage fields that never carry output or stateful activity.
const ASM_INTERACTION_UPDATE_FIELD = 1
const ASM_CHECKPOINT_UPDATE_FIELD = 3
const ASM_KV_SERVER_MESSAGE_FIELD = 4
const INTERACTION_UPDATE_HEARTBEAT_FIELD = 13

/**
 * True when the raw frame holds exactly one control message: a KV request, a
 * checkpoint update, or an interaction update that is only a heartbeat. Extra
 * fields inside a KV request are tolerated (Cursor has sent them live); extra
 * top-level fields are not.
 */
export function isSoleControlFrame(payload: Uint8Array): boolean {
  const fields = readAllFieldsStrict(payload)
  if (!fields || fields.length !== 1) return false
  const [field] = fields
  if (field!.wt !== 2) return false
  if (field!.fn === ASM_KV_SERVER_MESSAGE_FIELD || field!.fn === ASM_CHECKPOINT_UPDATE_FIELD) return true
  if (field!.fn !== ASM_INTERACTION_UPDATE_FIELD || !field!.bytes) return false
  const update = readAllFieldsStrict(field!.bytes)
  return update?.length === 1
    && update[0]!.fn === INTERACTION_UPDATE_HEARTBEAT_FIELD
    && update[0]!.wt === 2
}

export type CursorRetryPolicy = {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

function retryInteger(name: string, value: unknown, fallback: number): number {
  const resolved = value === undefined ? fallback : value
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new CursorProtocolError(`Cursor retry ${name} must be a positive integer`)
  }
  return resolved
}

export function resolveRetryPolicy(options: CursorRetryOptions | undefined): CursorRetryPolicy {
  if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
    throw new CursorProtocolError("Cursor retry options must be an object")
  }
  for (const key of Object.keys(options ?? {})) {
    if (!["maxAttempts", "baseDelayMs", "maxDelayMs"].includes(key)) {
      throw new CursorProtocolError(`Unknown Cursor retry option: ${key}`)
    }
  }
  const maxAttempts = retryInteger("maxAttempts", options?.maxAttempts, DEFAULT_RETRY_POLICY.maxAttempts)
  const baseDelayMs = retryInteger("baseDelayMs", options?.baseDelayMs, DEFAULT_RETRY_POLICY.baseDelayMs)
  const maxDelayMs = retryInteger("maxDelayMs", options?.maxDelayMs, DEFAULT_RETRY_POLICY.maxDelayMs)
  if (maxAttempts > MAX_RETRY_ATTEMPTS) {
    throw new CursorProtocolError(`Cursor retry maxAttempts must be no greater than ${MAX_RETRY_ATTEMPTS}`)
  }
  if (baseDelayMs > MAX_RETRY_DELAY_MS || maxDelayMs > MAX_RETRY_DELAY_MS) {
    throw new CursorProtocolError(`Cursor retry delays must be no greater than ${MAX_RETRY_DELAY_MS}ms`)
  }
  if (baseDelayMs > maxDelayMs) {
    throw new CursorProtocolError("Cursor retry baseDelayMs must be no greater than maxDelayMs")
  }
  return { maxAttempts, baseDelayMs, maxDelayMs }
}

function retryDelayMs(error: CursorProviderError, attempt: number, policy: CursorRetryPolicy): number {
  if (error.retryAfterMs !== undefined) return Math.min(MAX_RETRY_DELAY_MS, error.retryAfterMs)
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1))
  return Math.floor(Math.random() * ceiling)
}

function sleepForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CursorLocalCancellationError("Cursor retry cancelled"))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs)
    const onAbort = () => finish(new CursorLocalCancellationError("Cursor retry cancelled"))
    function finish(error?: Error) {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      if (error) reject(error)
      else resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function retryDelayFromValue(value: unknown): number | undefined {
  if (typeof value === "string") {
    const seconds = /^(\d+(?:\.\d+)?)s$/.exec(value.trim())
    if (seconds) return Math.ceil(Number(seconds[1]) * 1_000)
    const protobufDelay = retryInfoProtobufDelayMs(value.trim())
    if (protobufDelay !== undefined) return protobufDelay
  }
  if (!value || typeof value !== "object") return undefined
  const duration = value as { seconds?: unknown; nanos?: unknown }
  const seconds = Number(duration.seconds ?? 0)
  const nanos = Number(duration.nanos ?? 0)
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos) || seconds < 0 || nanos < 0) return undefined
  return Math.ceil(seconds * 1_000 + nanos / 1_000_000)
}

/** Decode google.rpc.RetryInfo.value without adding another protobuf schema. */
function retryInfoProtobufDelayMs(encoded: string): number | undefined {
  if (!encoded || encoded.length > 512 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) {
    return undefined
  }
  let bytes: Uint8Array
  try {
    bytes = Buffer.from(encoded.replaceAll("-", "+").replaceAll("_", "/"), "base64")
  } catch {
    return undefined
  }
  const readVarint = (input: Uint8Array, start: number): [bigint, number] | undefined => {
    let value = 0n
    let shift = 0n
    for (let offset = start; offset < input.length && offset < start + 10; offset++) {
      const byte = input[offset]!
      value |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return [value, offset + 1]
      shift += 7n
    }
    return undefined
  }
  const outerKey = readVarint(bytes, 0)
  if (!outerKey || outerKey[0] !== 0x0an) return undefined
  const outerLength = readVarint(bytes, outerKey[1])
  if (!outerLength || outerLength[0] > BigInt(bytes.length - outerLength[1])) return undefined
  const duration = bytes.subarray(
    outerLength[1],
    outerLength[1] + Number(outerLength[0]),
  )
  let offset = 0
  let seconds = 0n
  let nanos = 0n
  while (offset < duration.length) {
    const key = readVarint(duration, offset)
    if (!key) return undefined
    offset = key[1]
    const field = Number(key[0] >> 3n)
    if (Number(key[0] & 7n) !== 0) return undefined
    const item = readVarint(duration, offset)
    if (!item) return undefined
    offset = item[1]
    if (field === 1) seconds = item[0]
    else if (field === 2) nanos = item[0]
  }
  if (seconds > BigInt(Number.MAX_SAFE_INTEGER) || nanos > 999_999_999n) return undefined
  return Math.ceil(Number(seconds) * 1_000 + Number(nanos) / 1_000_000)
}

export function connectFrameError(payload: string): CursorProviderError {
  try {
    const envelope = JSON.parse(payload) as {
      error?: { code?: unknown; details?: unknown; retryAfter?: unknown; retry_after?: unknown }
    }
    const code = typeof envelope.error?.code === "string" ? envelope.error.code : "unknown"
    if (code === "unauthenticated" || code === "permission_denied") {
      return new CursorAuthError(`Cursor authentication failed (${code}); reauthenticate with Cursor`, {
        code,
        replaySafe: code === "unauthenticated",
      })
    }
    let retryAfterMs = retryDelayFromValue(
      envelope.error?.retryAfter ?? envelope.error?.retry_after,
    )
    let hasRetryInfo = false
    if (Array.isArray(envelope.error?.details)) {
      for (const detail of envelope.error.details) {
        if (!detail || typeof detail !== "object") continue
        const record = detail as Record<string, unknown>
        const type = record.type
        if (type === "google.rpc.RetryInfo" || (typeof type === "string" && type.endsWith("/google.rpc.RetryInfo"))) {
          hasRetryInfo = true
          retryAfterMs ??= retryDelayFromValue(
            record.retryDelay ?? record.retry_delay ?? record.value,
          )
        }
      }
    }
    return new CursorServerError(`Cursor API error (code=${code})`, {
      transient: isTransientGrpcStatus(code) || hasRetryInfo,
      replaySafe: true,
      code,
      retryAfterMs: retryAfterMs === undefined
        ? undefined
        : Math.min(MAX_RETRY_DELAY_MS, retryAfterMs),
    })
  } catch {
    return new CursorProtocolError("Cursor returned a malformed Connect error envelope")
  }
}

/**
 * Cold-start race: OpenCode's title/lifecycle Run often arrives with tools=[]
 * before the real agent Run publishes the catalog. Materializing RequestContext
 * with tools=0 and later with the full set changes its bytes, forces a prompt-
 * cache rebuild, and incurs avoidable cost. A valid session-keyed lifecycle Run
 * therefore waits for the first real catalog; cancellation is the only escape.
 */
type ToolCatalogWaiter = {
  resolve: (tools: OpencodeToolDef[]) => void
  cancel: () => void
}

const toolCatalogWaitersBySession = new Map<string, Set<ToolCatalogWaiter>>()

function publishToolCatalogWaiters(sessionKey: string, tools: OpencodeToolDef[]): void {
  const waiters = toolCatalogWaitersBySession.get(sessionKey)
  if (!waiters || waiters.size === 0) return
  toolCatalogWaitersBySession.delete(sessionKey)
  for (const waiter of waiters) waiter.resolve(tools)
}

function waitForSiblingToolCatalog(
  sessionKey: string,
  signal?: AbortSignal,
): Promise<OpencodeToolDef[]> {
  const existing = toolCatalogBySession.get(sessionKey)
  if (existing && existing.length > 0) {
    return Promise.resolve(structuredClone(existing))
  }
  if (signal?.aborted) {
    return Promise.reject(new CursorLocalCancellationError("Cursor tool-catalog wait cancelled"))
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let set = toolCatalogWaitersBySession.get(sessionKey)
    const finish = (tools?: OpencodeToolDef[], error?: CursorLocalCancellationError) => {
      if (settled) return
      settled = true
      set?.delete(waiter)
      if (set?.size === 0) toolCatalogWaitersBySession.delete(sessionKey)
      signal?.removeEventListener("abort", onAbort)
      if (error) reject(error)
      else resolve(structuredClone(tools!))
    }
    const onAbort = () => finish(
      undefined,
      new CursorLocalCancellationError("Cursor tool-catalog wait cancelled"),
    )
    const waiter: ToolCatalogWaiter = {
      resolve: (tools) => finish(tools),
      cancel: onAbort,
    }

    if (!set) {
      set = new Set()
      toolCatalogWaitersBySession.set(sessionKey, set)
    }
    set.add(waiter)
    signal?.addEventListener("abort", onAbort, { once: true })

    // Re-check after enqueue: a sibling may have published between the initial
    // map lookup and waiter registration.
    const raced = toolCatalogBySession.get(sessionKey)
    if (raced && raced.length > 0) finish(raced)
  })
}

function rememberToolCatalog(sessionKey: string, tools: OpencodeToolDef[]): void {
  toolCatalogBySession.delete(sessionKey)
  toolCatalogBySession.set(sessionKey, structuredClone(tools))
  publishToolCatalogWaiters(sessionKey, tools)
  while (toolCatalogBySession.size > MAX_TURN_STATE_SESSIONS) {
    const oldest = toolCatalogBySession.keys().next().value as string | undefined
    if (!oldest) break
    toolCatalogBySession.delete(oldest)
  }
}

/** Restore the last real catalog solely for lifecycle turns such as compaction. */
export function restoreTurnToolCatalog(sessionKey: string, tools: OpencodeToolDef[]): void {
  if (!sessionKey || tools.length === 0) return
  rememberToolCatalog(sessionKey, tools)
}

function snapshotToolCatalog(sessionKey: string | undefined): OpencodeToolDef[] {
  if (!sessionKey) return []
  return structuredClone(toolCatalogBySession.get(sessionKey) ?? [])
}

// Last known full host todo list per OpenCode session. Run-local
// `session.mirroredTodos` dies with the Run (turn_ended closes the session),
// but merges in later turns still need a base — same shape of problem as the
// tool catalog above, same solution. In-memory only: never enters the prompt,
// RequestContext, or persisted restart state, so the cache prefix is untouched.
// Refreshed on every todo write/read we observe; replaced wholesale, never
// merged, so it tracks host truth instead of accumulating guesses.
const mirroredTodosBySession = new Map<string, Array<Record<string, unknown>>>()

/** Record the authoritative host todo list for an OpenCode session. */
export function rememberMirroredTodos(
  sessionKey: string | undefined,
  todos: ReadonlyArray<Record<string, unknown>>,
): void {
  if (!sessionKey) return
  mirroredTodosBySession.delete(sessionKey)
  mirroredTodosBySession.set(
    sessionKey,
    todos.map((t) => ({ ...t })),
  )
  while (mirroredTodosBySession.size > MAX_TURN_STATE_SESSIONS) {
    const oldest = mirroredTodosBySession.keys().next().value as string | undefined
    if (!oldest) break
    mirroredTodosBySession.delete(oldest)
  }
}

/** Copy of the last known host todo list for an OpenCode session, if any. */
export function snapshotMirroredTodosBySession(
  sessionKey: string | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!sessionKey) return undefined
  const todos = mirroredTodosBySession.get(sessionKey)
  return todos ? todos.map((t) => ({ ...t })) : undefined
}

/**
 * Store a bridged/observed full todo snapshot on both the live Run session
 * (for merges later this turn) and the per-OpenCode-session copy (for merges
 * in later turns and across checkpoint resumes).
 */
function storeMirroredTodos(
  session: CursorSession,
  todos: ReadonlyArray<Record<string, unknown>>,
): void {
  session.mirroredTodos = todos.map((t) => ({ ...t }))
  rememberMirroredTodos(session.openCodeSessionId, session.mirroredTodos)
}

function rememberPostCompactionRebase(sessionKey: string): void {
  postCompactionRebaseBySession.delete(sessionKey)
  postCompactionRebaseBySession.add(sessionKey)
  while (postCompactionRebaseBySession.size > MAX_TURN_STATE_SESSIONS) {
    const oldest = postCompactionRebaseBySession.values().next().value as string | undefined
    if (!oldest) break
    postCompactionRebaseBySession.delete(oldest)
  }
}

function normalizePromptIdentity(value: PromptIdentity): PromptIdentity {
  const hostAgent = value.hostAgent?.trim()
  const systemPromptHash = value.systemPromptHash?.trim()
  return {
    ...(hostAgent ? { hostAgent } : {}),
    ...(systemPromptHash ? { systemPromptHash } : {}),
  }
}

function rememberPromptIdentity(sessionKey: string, value: PromptIdentity): void {
  const normalized = normalizePromptIdentity(value)
  if (!normalized.hostAgent && !normalized.systemPromptHash) return
  promptIdentityBySession.delete(sessionKey)
  promptIdentityBySession.set(sessionKey, normalized)
  while (promptIdentityBySession.size > MAX_TURN_STATE_SESSIONS) {
    const oldest = promptIdentityBySession.keys().next().value as string | undefined
    if (!oldest) break
    promptIdentityBySession.delete(oldest)
  }
}

/**
 * Prompt identity is diagnostics / persistence only and never drives remint.
 * Kept as a named helper so call sites / tests that still mention identity
 * churn have a single no-op definition.
 */
export function promptIdentityWouldRemint(
  _previous: PromptIdentity,
  _current: PromptIdentity,
): boolean {
  return false
}

function sentHistoryImageHashes(sessionKey: string | undefined): ReadonlySet<string> | undefined {
  if (!sessionKey) return undefined
  const hashes = sentHistoryImageHashesBySession.get(sessionKey)
  if (!hashes) return undefined
  sentHistoryImageHashesBySession.delete(sessionKey)
  sentHistoryImageHashesBySession.set(sessionKey, hashes)
  return hashes
}

function rememberSentHistoryImageHashes(sessionKey: string | undefined, hashes: readonly string[]): void {
  if (!sessionKey || hashes.length === 0) return
  const remembered = sentHistoryImageHashesBySession.get(sessionKey) ?? new Set<string>()
  for (const hash of hashes) {
    remembered.delete(hash)
    remembered.add(hash)
    while (remembered.size > MAX_SENT_HISTORY_IMAGES_PER_SESSION) {
      const oldest = remembered.values().next().value as string | undefined
      if (!oldest) break
      remembered.delete(oldest)
    }
  }
  sentHistoryImageHashesBySession.delete(sessionKey)
  sentHistoryImageHashesBySession.set(sessionKey, remembered)
  while (sentHistoryImageHashesBySession.size > MAX_TURN_STATE_SESSIONS) {
    const oldest = sentHistoryImageHashesBySession.keys().next().value as string | undefined
    if (!oldest) break
    sentHistoryImageHashesBySession.delete(oldest)
  }
}

type V3Part = LanguageModelV3StreamPart

export function createCursorLanguageModel(
  modelId: string,
  providerId: string,
  options: CreateCursorOptions,
): LanguageModelV3 {
  // Host Path.cache / explicit override wins over XDG heuristics for this process.
  if (options.cacheDir) setHostCacheDirOverride(options.cacheDir)
  // Start loading and pruning restart state as soon as the provider is built.
  // startSession awaits this same per-cache-root initialization before binding.
  void initializeConversationPersistence(opencodeGlobalCacheDir()).catch((error) => {
    trace(`conversation persistence: startup load failed: ${String(error)}`)
  })
  return {
    specificationVersion: "v3",
    provider: providerId,
    modelId,
    supportedUrls: {},

    async doStream(callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      return doStreamImpl(modelId, options, callOptions)
    },

    async doGenerate(callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const result = await doStreamImpl(modelId, options, callOptions)
      const parts: V3Part[] = []
      const reader = result.stream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
      }
      return foldStreamParts(parts)
    },
  }
}

/** Bearer token for a new Run from whichever single credential source `options` carries. */
function resolveRunBearerToken(options: CreateCursorOptions, forceRefresh = false): Promise<string> {
  return resolveBearerToken({
    getAccessToken: options.getAccessToken,
    accessToken: options.accessToken,
    apiKey: options.apiKey,
    baseUrl: resolveApiBaseURL(options),
    forceRefresh,
  })
}

async function doStreamImpl(
  modelId: string,
  options: CreateCursorOptions,
  callOptions: LanguageModelV3CallOptions,
): Promise<LanguageModelV3StreamResult> {
  const prompt = callOptions.prompt
  const retryPolicy = resolveRetryPolicy(options.retry)
  // The Bearer token is resolved for every Run this call opens, including
  // recovery Runs after a long-held tool: a host `getAccessToken` (or the
  // apiKey exchange) renews it, so a Run never starts on a token that expired
  // while the turn was in progress. A held Run being continued keeps the
  // token it was opened with. After Cursor rejects the credential, the next
  // open asks the source for a forced renewal.
  let forceCredentialRefresh = false
  const credentialRenewable = Boolean(options.getAccessToken)
    || (!options.accessToken && options.apiKey !== undefined && isExchangeableApiKey(options.apiKey))
  let prefetchedToken: string | undefined
  const requestedAt = Date.now()
  // pumpWithRecovery owns the complete per-turn attempt budget.  Opening a
  // replacement session here must be a single attempt; otherwise setup retry
  // loops nest inside recovery and `maxAttempts` no longer caps total Runs.
  const openSession = async (startOptions?: { recovery?: CursorRunRecovery; isolate?: boolean }) => {
    const forceRefresh = forceCredentialRefresh
    forceCredentialRefresh = false
    const prefetched = prefetchedToken
    prefetchedToken = undefined
    const token = prefetched !== undefined && !forceRefresh
      ? prefetched
      : await resolveRunBearerToken(options, forceRefresh)
    const opened = await startSession(modelId, token, callOptions, options, { ...startOptions, requestedAt })
    cancelIfHostStoppedSince(opened)
    return opened
  }

  // ── Continuation vs fresh turn ──
  // OpenCode embeds *all* historical tool results in every prompt. Only the
  // trailing tool-message suffix (after the last assistant/user message) is a
  // live continuation. Treating mid-prompt history as continuation caused
  // false "orphaned tool results" errors after Cursor turn_ended and OpenCode
  // started the next step with old tools still in the prompt body.
  let trailingToolResults = extractTrailingToolResults(prompt)
  let steerMessages: string[] = []
  if (trailingToolResults.length === 0 && mayBeUserStep(callOptions)) {
    const steered = extractLiveSteerResults(
      prompt,
      opencodeSessionKey(callOptions),
      resolveCursorWireModelId(callOptions.providerOptions?.cursor as Record<string, unknown> | undefined, modelId),
      extractTools(callOptions),
    )
    if (steered) {
      trace(
        `continuation: ${steered.messages.length} mid-turn user message(s) after ` +
          `${steered.results.length} trailing tool result(s)`,
      )
      trailingToolResults = steered.results
      steerMessages = steered.messages
    }
  }
  let session = findContinuationSession(trailingToolResults)
  // A call that must open a Run gets its credential before it changes any
  // session state (plan mode, finishing the prior held Run), so a login that
  // cannot be renewed fails the turn without side effects.
  if (!session) prefetchedToken = await resolveRunBearerToken(options)
  // A host may submit an already rendered plan through its canonical stage
  // tool after the Cursor Run has ended. The next call carries that tool result
  // without a Cursor exec id; reconcile the approved mode before a fresh Run.
  if (hasApprovedUncorrelatedPlanStageResult(prompt)) {
    setActiveCursorMode(opencodeSessionKey(callOptions), "agent")
  }

  if (session) {
    // Write pending results onto the held-open Run. A dead stream closes the
    // session and returns undefined so we fall through to history rebase
    // instead of pumping a connection that can no longer accept writes.
    const results = session.supportsImages
      ? await decodeTrailingToolImages(trailingToolResults, callOptions.abortSignal)
      : trailingToolResults
    if (steerMessages.length > 0) session = injectSteerMessages(session, steerMessages)
    const resultsAfterCheckpoint = session && (steerMessages.length > 0 || session.resultsAfterCheckpoint)
      ? resultsAwaitingCheckpoint(session, results)
      : undefined
    if (session) session = deliverContinuationResults(session, results)
    if (session && resultsAfterCheckpoint) session.resultsAfterCheckpoint = resultsAfterCheckpoint
    if (session) await refreshHeldSessionToolCatalog(session, callOptions)
  }

  if (!session) {
    const sessionKey = opencodeSessionKey(callOptions)
    if (!session && trailingToolResults.length > 0) {
      // True continuation (prompt ends with tool results) but the held-open Run
      // is gone (or its write path just failed). Rebase the complete OpenCode
      // prompt onto a fresh conversation: its seed history includes the
      // completed tool result, so no result or advertised tool is lost and
      // Cursor can continue instead of deadlocking.
      const ids = trailingToolResults.map((r) => `${r.sessionId}:${r.execId}`).join(",")
      trace(`continuation: ${trailingToolResults.length} interrupted trailing tool result(s) [${ids}] — rebasing fresh Run`)
      session = await openSession({ recovery: { kind: "rebase", ...(steerMessages.length > 0 ? { steer: true } : {}) } })
    } else {
      // Fresh turn (prompt ends with user/assistant text). Historical tool
      // results may exist mid-prompt; they are not live exec replies.
      const historical = extractToolResults(prompt).length
      if (historical > 0) {
        trace(`fresh turn: ignoring ${historical} historical tool result(s) (not trailing)`)
      }
      // An in-session helper (title/memory/task child) that reuses the parent
      // OpenCode session id with a strictly smaller catalog must not cancel or
      // supersede the held parent Run — that remints (`interrupted-run`) when
      // the trailing tool result returns. Isolate onto an ephemeral conversation.
      const busyPrior = sessionManager.findOpenByOpenCodeSessionId(sessionKey)
      if (
        busyPrior
        && !busyPrior.closed
        && isProperCatalogSubset(extractTools(callOptions), busyPrior.toolCatalog ?? [])
      ) {
        trace(
          `fresh turn: isolating in-session helper — incomingTools subset of ` +
            `parentTools=${busyPrior.toolCatalog?.length ?? 0} ` +
            `priorSession=${busyPrior.sessionId} pending=${busyPrior.pending.size}`,
        )
        session = await openSession({ isolate: true })
      } else {
        // Host may start a new user turn while the prior Run still has pending
        // tools. Finish that Run on the same conversation (cancel stranded execs,
        // drain turn_ended) before opening the new Run so the checkpoint prefix
        // is preserved. registerSession will not close a prior Run that still
        // has real pending execs; a failed prepare leaves that Run held.
        try {
          await preparePriorSessionForFreshTurn(sessionKey)
        } catch (error) {
          trace(
            `fresh turn: prepare-prior failed — opening the new Run and leaving ` +
              `any still-pending prior held — ${(error as Error).message}`,
          )
        }
        session = await openSession()
      }
    }
  }

  let activeSession = session

  return {
    stream: new ReadableStream<V3Part>({
      async pull(controller) {
        // The outer try is a safety net for any throw that escapes pump() —
        // e.g. an unhandled decode/gunzip error or a frames-iterator throw on
        // a non-200 HTTP/2 response. Without it the pull promise rejects, the
        // ReadableStream errors, and the session is never cleaned up.
        try {
          try {
            controller.enqueue({ type: "stream-start", warnings: [] } as V3Part)
          } catch (e) {
            // Controller already cancelled by the consumer — stop pumping.
            trace(`pull: stream-start enqueue failed (cancelled) err=${(e as Error).message}`)
            return
          }
          if (activeSession.openCodeSessionId) {
            beginEmittedStep(activeSession.openCodeSessionId, activeSession.conversationId)
          }
          activeSession = await pumpWithRecovery({
            initialSession: activeSession,
            controller,
            abortSignal: callOptions.abortSignal,
            retryPolicy,
            recover: (recovery) => openSession({ recovery }),
            onSession: (next) => { activeSession = next },
            ...(steerMessages.length > 0 ? { steer: true } : {}),
            ...(credentialRenewable
              ? { renewRejectedCredential: () => { forceCredentialRefresh = true } }
              : {}),
          })
          try {
            controller.close()
          } catch (e) {
            trace(`pull: close failed (already closed/cancelled) err=${(e as Error).message}`)
          }
          // pumpWithRecovery has returned only after the Run reached terminal
          // turn_ended and endPump cleared ownership. This is the first safe
          // point to start a second OpenCode generation. A failed prior handoff
          // is retried only because this explicit new provider turn reached its
          // own terminal boundary — never from a timer or tight loop.
          const kickoff = await flushPlanExecutionKickoff(activeSession.openCodeSessionId, {
            cursorSessionID: activeSession.sessionId,
            terminal: activeSession.closed,
            pumpActive: activeSession.pumpActive || activeSession.pumpOwner != null,
            pendingExecs: activeSession.pending.size,
          })
          if (!kickoff) {
            const state = planExecutionKickoffState(activeSession.openCodeSessionId)
            if (state?.status === "failed") {
              setActiveCursorMode(activeSession.openCodeSessionId, "plan")
            }
          }
          await flushHostAgentModeSwitch(activeSession.openCodeSessionId, {
            cursorSessionID: activeSession.sessionId,
            terminal: activeSession.closed,
            pumpActive: activeSession.pumpActive || activeSession.pumpOwner != null,
            pendingExecs: activeSession.pending.size,
          })
        } catch (e) {
          activeSession.pumpActive = false
          trace(`pull: pump threw (cleaning up): ${(e as Error).message}`)
          // A Run the host stopped is drained and closed by its cancel.
          if (!activeSession.hostInterrupted) sessionManager.close(activeSession)
          try {
            controller.error(e instanceof Error ? e : new Error(String(e)))
          } catch {
            /* controller already errored/closed */
          }
        }
      },
      cancel() {
        // OpenCode cancels the ReadableStream after "tool-calls"; keep the
        // Cursor Run stream alive so the next doStream can write results.
        trace("ReadableStream cancel() → closeUnlessPending")
        sessionManager.closeUnlessPending(activeSession)
      },
    }),
  }
}

export async function pumpWithRecovery(input: {
  initialSession: CursorSession
  controller: ReadableStreamDefaultController<V3Part>
  abortSignal?: AbortSignal
  retryPolicy?: CursorRetryPolicy
  recover: (recovery: CursorRunRecovery) => Promise<CursorSession>
  onSession?: (session: CursorSession) => void
  maxRecoveries?: number
  /** The call's prompt ends with mid-turn user messages after the step's results. */
  steer?: boolean
  /**
   * Set when the credential source can renew: called once per turn after
   * Cursor rejects the token (401 / unauthenticated) before the attempt did
   * anything, so the reopened Run uses a force-renewed token. This retry does
   * not count against the transient-failure budget.
   */
  renewRejectedCredential?: () => void
}): Promise<CursorSession> {
  let session = input.initialSession
  const retryPolicy = input.retryPolicy ?? {
    ...DEFAULT_RETRY_POLICY,
    maxAttempts: (input.maxRecoveries ?? 1) + 1,
  }
  const maxRecoveries = retryPolicy.maxAttempts - 1
  let credentialRenewed = false
  input.onSession?.(session)

  const resumableCheckpoint = (pumpedSession: CursorSession) =>
    pumpedSession.resultsAfterCheckpoint ? undefined : pumpedSession.resumeCheckpoint

  const reopen = async (pumpedSession: CursorSession, failure: CursorProviderError) => {
    const checkpoint = resumableCheckpoint(pumpedSession)
    const toolCallIds = pumpedSession.resultsAfterCheckpoint?.toolCallIds
    const recovery: CursorRunRecovery = failure.checkpointUnusable
      ? { kind: "rebase", reason: "checkpoint-unusable" }
      : checkpoint
        ? {
            kind: "resume",
            conversationId: pumpedSession.conversationId,
            checkpoint: Uint8Array.from(checkpoint),
            ...(pumpedSession.pendingFollowUp !== undefined ? { followUp: pumpedSession.pendingFollowUp } : {}),
          }
        : {
            kind: "rebase",
            ...(input.steer ? { steer: true } : {}),
            ...(toolCallIds?.size ? { toolCallIds: new Set(toolCallIds) } : {}),
          }
    const next = await input.recover(recovery)
    if (recovery.kind === "resume") {
      next.usageEstimate = { ...pumpedSession.usageEstimate }
      next.editToolCalls = new Map(pumpedSession.editToolCalls)
      next.deferredNote = pumpedSession.deferredNote
      next.pendingFollowUp = recovery.followUp
      // The resumed Run never saw these; its turn_ended sends them as a follow-up. One delivered
      // after the checkpoint it resumes from is lost with that checkpoint, so it goes too.
      const resend = pumpedSession.steerInjections
        ?.filter((injection) => injection.state !== "delivered" || !injection.checkpointed)
        .map((injection) => ({ ...injection, state: "carried" as const, checkpointed: false }))
      if (resend?.length) next.steerInjections = resend
      // mirroredTodos rides along via rememberMirroredTodos (per-OpenCode-
      // session, seeded in startSession) — no handoff needed here.
    }
    input.onSession?.(next)
    return next
  }

  for (let attempt = 0; ; attempt++) {
    const pumpedSession = session
    const pumpOwner = Symbol("cursor-pump")
    sessionManager.beginPump(pumpedSession, pumpOwner)
    try {
      await pump(
        pumpedSession,
        input.controller,
        {
          textId: crypto.randomUUID(),
          reasoningId: crypto.randomUUID(),
        },
        input.abortSignal,
      )
      return session
    } catch (error) {
      // A cancelled Run's stream fails or ends on purpose; recovering would restart the stopped turn.
      if (pumpedSession.hostInterrupted) {
        if (error instanceof CursorLocalCancellationError) throw error
        throw new CursorLocalCancellationError("Cursor Run cancelled: the host stopped the turn", error)
      }
      const failure = toCursorProviderError(error, {
        replaySafe: error instanceof CursorProviderError ? error.replaySafe : false,
        fallback: "Cursor Run interrupted",
      })
      if (
        input.renewRejectedCredential
        && !credentialRenewed
        && isRejectedCredentialError(failure)
        && failure.replaySafe
      ) {
        credentialRenewed = true
        trace(
          `Run credential rejected: sessionId=${pumpedSession.sessionId} err=${failure.message} ` +
            `— renewing the token and reopening once`,
        )
        sessionManager.close(pumpedSession, "remote-error", failure)
        input.renewRejectedCredential()
        session = await reopen(pumpedSession, failure)
        attempt--
        continue
      }
      if (!failure.transient) throw failure
      const checkpoint = resumableCheckpoint(pumpedSession)
      if (!failure.replaySafe && !checkpoint) {
        throw retrySuppressedError(
          failure,
          "after visible output or stateful server activity",
          attempt + 1,
          maxRecoveries + 1,
        )
      }
      if (attempt >= maxRecoveries) {
        throw new CursorRetryExhaustedError(attempt + 1, failure)
      }
      trace(
        `Run interrupted: sessionId=${pumpedSession.sessionId} attempt=${attempt + 1}/${maxRecoveries} ` +
          `err=${failure.message} — ${checkpoint ? `resuming ${checkpoint.length}B checkpoint` : "rebasing fresh Run"}`,
      )
      sessionManager.close(pumpedSession, "remote-error", failure)
      const delayMs = retryDelayMs(failure, attempt + 1, retryPolicy)
      trace(`Run retry backoff: attempt=${attempt + 1}/${maxRecoveries} delayMs=${delayMs}`)
      await sleepForRetry(delayMs, input.abortSignal)
      session = await reopen(pumpedSession, failure)
    } finally {
      sessionManager.endPump(pumpedSession, pumpOwner)
      if (!pumpedSession.closed && pumpedSession.pending.size > 0) void watchHeldRun(pumpedSession)
    }
  }
}

export type CursorRunRecovery =
  /**
   * `steer`: the prompt ends with mid-turn user messages after the step's results.
   * `toolCallIds`: earlier results of this step that no checkpoint holds.
   */
  | { kind: "rebase"; reason?: "checkpoint-unusable"; steer?: boolean; toolCallIds?: ReadonlySet<string> }
  | { kind: "resume"; conversationId: string; checkpoint: Uint8Array; followUp?: string }

const heartbeatWritePendingBySession = new WeakMap<CursorSession, boolean>()
const heartbeatGenerationBySession = new WeakMap<CursorSession, number>()

function bumpHeartbeatGeneration(session: CursorSession): number {
  const generation = (heartbeatGenerationBySession.get(session) ?? 0) + 1
  heartbeatGenerationBySession.set(session, generation)
  heartbeatWritePendingBySession.set(session, false)
  return generation
}

function isCurrentHeartbeatGeneration(session: CursorSession, generation: number): boolean {
  return heartbeatGenerationBySession.get(session) === generation
}

const INTERACTION_RESULT_FIELDS: ReadonlySet<string> = new Set([
  ASK_QUESTION_RESULT_FIELD,
  SWITCH_MODE_RESULT_FIELD,
  CREATE_PLAN_RESULT_FIELD,
])

/** Execs Cursor sent that still wait on the host; interaction queries and display bridges are not execs. */
export function pendingExecIds(session: CursorSession): number[] {
  const ids: number[] = []
  for (const [execId, pending] of session.pending) {
    if (pending.bridged || pending.aborted || pending.state !== "pending" || INTERACTION_RESULT_FIELDS.has(pending.resultField)) continue
    ids.push(execId)
  }
  return ids
}

/** `ExecServerControlMessage`: Cursor withdrew an exec, e.g. when it stops the Run. */
export function applyExecControl(session: CursorSession, control: Record<string, unknown>, where: string): void {
  const id = (control.abort as Record<string, unknown> | undefined)?.id
  if (typeof id !== "number") {
    trace(`exec control: unknown message ${JSON.stringify(Object.keys(control))} (${where}) sessionId=${session.sessionId}`)
    return
  }
  const pending = session.pending.get(id)
  const owed = pending !== undefined && !INTERACTION_RESULT_FIELDS.has(pending.resultField)
  const marked = owed && sessionManager.markExecAborted(session, id)
  trace(
    `exec control: Cursor aborted execId=${id} (${where}) sessionId=${session.sessionId} ` +
      `${marked ? "— no result will be written for it" : "— not an exec the host still owes"}`,
  )
}

/** Start (or replace) the per-session heartbeat. In-flight writes from a prior attach are ignored. */
export function attachSessionHeartbeat(session: CursorSession): void {
  session.heartbeatCancel?.()
  if (session.heartbeat) {
    clearInterval(session.heartbeat)
    session.heartbeat = null
  }
  const generation = bumpHeartbeatGeneration(session)
  const interval = setInterval(() => {
    if (session.closed || !isCurrentHeartbeatGeneration(session, generation)) return
    if (heartbeatWritePendingBySession.get(session)) {
      trace(`heartbeat skipped: prior heartbeat write is still pending sessionId=${session.sessionId}`)
      return
    }
    heartbeatWritePendingBySession.set(session, true)
    const stream = session.stream
    const execIds = pendingExecIds(session)
    void writeWithBackpressure(stream, buildHeartbeat(), "heartbeat")
      .then(async () => {
        for (const execId of execIds) {
          if (session.closed || !isCurrentHeartbeatGeneration(session, generation)) return
          if (session.pending.get(execId)?.state !== "pending") continue
          await writeWithBackpressure(stream, buildExecHeartbeat(execId), `exec heartbeat id=${execId}`)
        }
      })
      .then(() => {
        if (!isCurrentHeartbeatGeneration(session, generation) || session.closed) return
        sessionManager.recordHeartbeatWrite(session)
      })
      .catch((cause) => {
        if (!isCurrentHeartbeatGeneration(session, generation) || session.closed) return
        sessionManager.close(
          session,
          "heartbeat-write-failed",
          toCursorProviderError(cause, {
            replaySafe: false,
            fallback: "Cursor heartbeat write failed",
          }),
        )
      })
      .finally(() => {
        if (isCurrentHeartbeatGeneration(session, generation)) {
          heartbeatWritePendingBySession.set(session, false)
        }
      })
  }, session.policy.heartbeatMs)
  interval.unref?.()
  session.heartbeat = interval
  session.heartbeatCancel = () => {
    if (session.heartbeat) clearInterval(session.heartbeat)
    session.heartbeat = null
    if (isCurrentHeartbeatGeneration(session, generation)) bumpHeartbeatGeneration(session)
  }
}

async function startSession(
  modelId: string,
  token: string,
  callOptions: LanguageModelV3CallOptions,
  options: CreateCursorOptions,
  startOptions?: { recovery?: CursorRunRecovery; isolate?: boolean; requestedAt?: number },
): Promise<CursorSession> {
  const continuationPolicy = resolveContinuationPolicy(options.continuation)
  const prompt = callOptions.prompt
  const incomingTools = extractTools(callOptions)
  const sessionKey = opencodeSessionKey(callOptions)
  const isolateHelper = startOptions?.isolate === true
  const cacheDir = opencodeGlobalCacheDir()
  if (sessionKey) {
    const restored = await hydrateConversationState(cacheDir, sessionKey).catch((error) => {
      trace(`conversation persistence: restore failed sessionKey=${sessionKey}: ${String(error)}`)
      return undefined
    })
    if (restored?.postCompactionRebase) rememberPostCompactionRebase(sessionKey)
    if (restored?.toolCatalog.length) restoreTurnToolCatalog(sessionKey, restored.toolCatalog)
    if (restored?.hostAgent || restored?.systemPromptHash) {
      rememberPromptIdentity(sessionKey, {
        ...(restored.hostAgent ? { hostAgent: restored.hostAgent } : {}),
        ...(restored.systemPromptHash ? { systemPromptHash: restored.systemPromptHash } : {}),
      })
    }
    // Provenance has its own LRU; refill it if only that entry was evicted.
    await hydrateTurnProvenance(cacheDir, sessionKey).catch((error) => {
      trace(`turn provenance: restore failed sessionKey=${sessionKey}: ${String(error)}`)
    })
  }
  const providerOptions = callOptions.providerOptions?.cursor as Record<string, unknown> | undefined
  const hostAgent = typeof providerOptions?.[CURSOR_HOST_AGENT_OPTION] === "string"
    ? String(providerOptions[CURSOR_HOST_AGENT_OPTION]).trim() || undefined
    : undefined
  // The classic plugin marks OpenCode's agent="compaction" through chat.params.
  // OpenCode 2.0 removed that hook, so its plugin writes the same request-local
  // option from session hooks. The session marker is a fallback only when a
  // host does not preserve mutable options; explicit false prevents concurrent
  // title/generate calls from inheriting a compaction marker.
  // Do not infer this from tools/toolChoice: standalone no-tool calls are valid.
  const compactionOption = providerOptions?.[CURSOR_COMPACTION_OPTION]
  const isCompaction = compactionOption === true || (
    compactionOption === undefined && isCompactionSession(sessionKey)
  )
  const toolState = await resolveTurnToolState({
    sessionKey,
    incomingTools,
    toolChoice: callOptions.toolChoice,
    isCompaction,
    abortSignal: callOptions.abortSignal,
  })
  const tools = toolState.advertisedTools
  const webToolAliases = buildCustomWebToolAliases(tools)
  const cursorTools = webToolAliases.advertisedTools
  for (const [alias, candidates] of webToolAliases.ambiguous) {
    trace(`web tool alias skipped: alias=${alias} ambiguous=[${candidates.join(",")}]`)
  }
  for (const [alias, original] of webToolAliases.aliases) {
    trace(`web tool alias: ${alias} -> ${original}`)
  }
  const allowTools = toolState.allowTools
  const discoveredSubagentCatalog = extractHostSubagentCatalog(cursorTools)
  let recovery = startOptions?.recovery
  let resumeRecovery = recovery?.kind === "resume" ? recovery : undefined
  let resuming = !!resumeRecovery
  const lifecycle = !allowTools && !isCompaction && !recovery
  // Isolated helpers must not share the parent's openCodeSessionId or sticky
  // conversation: registerSession would otherwise supersede the held parent Run.
  const ephemeralRun = lifecycle || isolateHelper
  // v1 sets `options.workspaceRoot` correctly per invocation (`input.directory`,
  // one plugin instance per project). OpenCode 2.0 runs one daemon across many
  // projects, so its static option is only a last-resort fallback. Prefer the
  // per-request `x-opencode-directory` header (set by the 2.0 plugin's
  // `session.hook("model.request")`), then the session mark recorded from the
  // session hooks via `getSessionDirectory`.
  const workspaceRoot = resolveSessionWorkspaceRoot({
    sessionKey,
    headers: callOptions.headers,
    workspaceRoot: options.workspaceRoot,
  })
  const baseSystemPrompt = extractSystemPrompt(prompt)
  // One merged-config load per Run: RequestContext names, session descriptors
  // (exec remap, exec #36) and guidance MCP ids must agree on server identity,
  // and warm turns must not pay for a second disk read.
  const mergedConfig = await loadMergedConfig(workspaceRoot)
  const knownMcpServers = Object.keys(mergedConfig.mcp ?? {})
  const interactionGuidance = buildOpenCodeInteractionGuidance(cursorTools, isCompaction, workspaceRoot, {
    knownMcpServers,
  })
  // Prompt-identity diagnostics are filled after Context Epoch admission below
  // (baseline hash is the epoch baseline, not a per-turn host hash).
  let frozenSystemPromptHash: string | undefined
  const resetState = resolveTurnConversationReset({
    sessionKey,
    isCompaction,
    historyRewrite: providerOptions?.[CURSOR_HISTORY_REWRITE_OPTION] === true,
  })
  // Cursor could not restore the stored checkpoint (missing blobs) before this
  // turn produced anything: reseed from the full host history as a new turn.
  const checkpointUnusable = recovery?.kind === "rebase" && recovery.reason === "checkpoint-unusable"
  // Another model (other provider or a local model) answered since this
  // conversation's last checkpoint: resuming it would hide that work from Cursor.
  // A Cursor-to-Cursor model switch resumes the same conversation, as in the CLI.
  const foreignHistory: ForeignHistoryReason | undefined =
    sessionKey && !resuming && !ephemeralRun && !resetState.reset && recovery?.kind !== "rebase"
      ? detectForeignHistory({
          sessionKey,
          conversationId: peekConversationId(sessionKey),
          prompt,
        })
      : undefined
  // Compaction must not reuse the prior conversation; its first normal turn
  // must also rebase so the summary-agent checkpoint cannot replace the normal
  // system prompt and OpenCode's newly compacted history.
  let bound = resuming
    ? { conversationId: resumeRecovery!.conversationId, reset: false, previousId: undefined }
    : bindConversationId(sessionKey, {
        reset: resetState.reset || recovery?.kind === "rebase" || !!foreignHistory,
        ephemeral: ephemeralRun,
      })
  if (sessionKey && !ephemeralRun) trackTurnProvenance(sessionKey, bound.conversationId)
  let conversationState = ephemeralRun
    ? undefined
    : resuming
      ? resumeRecovery!.checkpoint
      : (bound.reset ? undefined : getCheckpoint(bound.conversationId))
  let checkpointGraph: ConversationBlobGraphStats = conversationState
    ? inspectConversationBlobGraph(bound.conversationId, conversationState)
    : { count: 0, bytes: 0, complete: true }
  const forcedResetReason: string | undefined = foreignHistory
    ? `foreign-history:${foreignHistory}`
    : checkpointUnusable ? "checkpoint-unusable" : undefined
  // CLI soft-reuses incomplete / oversized graphs (100 MiB is export-only).
  // Never remint — warn and keep the sticky conversation + checkpoint.
  if (conversationState) {
    const concern = checkpointBlobGraphConcern(checkpointGraph)
    if (concern) {
      trace(
        `checkpoint state warning: reason=${concern} ` +
          `conversationId=${bound.conversationId} checkpointBytes=${conversationState.length} ` +
          `blobCount=${checkpointGraph.count} blobBytes=${checkpointGraph.bytes} ` +
          `limitBytes=${MAX_CHECKPOINT_BLOB_GRAPH_BYTES} ` +
          `detail=${checkpointGraph.fallbackReason ?? "-"} action=warm-reuse`,
      )
    }
  }
  const conversationId = bound.conversationId
  const conversationGroupId = resolveConversationGroupId(sessionKey, conversationId)
  if (bound.reset) {
    if (sessionKey) {
      await clearPersistedConversationState(cacheDir, sessionKey, bound.previousId).catch((error) => {
        trace(`conversation persistence: reset cleanup failed sessionKey=${sessionKey}: ${String(error)}`)
      })
    }
    trace(
      `conversation reset: reason=${forcedResetReason ?? (recovery?.kind === "rebase" ? "interrupted-run" : (resetState.reason ?? "unknown"))} ` +
        `sessionKey=${sessionKey ?? "(none)"} ` +
        `previousId=${bound.previousId ?? "-"} → conversationId=${conversationId}`,
    )
  }

  const lastUser = [...prompt].reverse().find((message) => message.role === "user")
  let userText = recovery?.kind === "rebase" && !checkpointUnusable
    ? "Continue the interrupted turn from the conversation history above. Do not repeat completed work."
    : (extractUserText(lastUser) || ".")
  // After an approved SwitchMode, inject the Cursor CLI-shaped mode reminder
  // (same <system_reminder> contract the CLI uses after flipping unifiedMode).
  const startedWithCheckpoint = !!conversationState
  if (startedWithCheckpoint) {
    userText = groundCheckpointTurnText(userText, true, workspaceRoot, cursorTools)
  }
  const activeMode = getActiveCursorMode(sessionKey)
  const nativePlanPromptOwnsMode = hostAgent === "plan"
    && (activeMode === "plan" || activeMode === "spec")
  // Mode/kickoff are chronological Mid-Conversation updates (V2), including on
  // checkpoint Turns — never folded into the frozen system baseline.
  const modeReminder = isCompaction || lifecycle || nativePlanPromptOwnsMode
    ? undefined
    : takeActiveCursorModeReminder(sessionKey, {
        advertisedTools: cursorTools.map((tool) => tool.name),
      })
  const kickoffWarning = isCompaction || lifecycle
    ? undefined
    : takePlanExecutionKickoffWarning(sessionKey)
  const oneShotReminders = [
    modeReminder,
    kickoffWarning ? `<system_reminder>${kickoffWarning}</system_reminder>` : undefined,
  ].filter((part): part is string => !!part)

  // `systemPrompt` is the host system context composed for a seed Run (kept for
  // diagnostics and size estimates). It reaches Cursor only as the frozen
  // system-instructions rule in RequestContext, never as a seeded `system`
  // message, which Cursor does not follow.
  let systemPrompt: string | undefined
  let systemInstructions: SystemInstructions | undefined
  if (isCompaction || lifecycle) {
    // Ephemeral summary/title Runs — do not initialize a sticky Context Epoch.
    systemPrompt = startedWithCheckpoint
      ? undefined
      : [baseSystemPrompt, interactionGuidance, ...oneShotReminders].filter(Boolean).join("\n\n")
    if (startedWithCheckpoint && oneShotReminders.length) {
      userText = appendMidConversationMessage(userText, oneShotReminders.join("\n\n"))
    }
    const ephemeralText = systemPrompt
      ?? [baseSystemPrompt, interactionGuidance].filter(Boolean).join("\n\n")
    if (ephemeralText) systemInstructions = { text: ephemeralText, authoritative: true }
  } else {
    const admitted = admitContextEpoch({
      conversationId,
      hasCheckpoint: startedWithCheckpoint,
      hostSystem: baseSystemPrompt,
      guidance: interactionGuidance,
      hostAgent,
      workspaceRoot,
      oneShotReminders,
      recoveredBaseline: systemInstructionsRuleText(getFrozenRequestContext(conversationId) ?? {}),
    })
    systemPrompt = startedWithCheckpoint ? undefined : admitted.seedSystemPrompt
    userText = appendMidConversationMessage(userText, admitted.midConversationMessage)
    // The epoch baseline is the rule for every Run of this conversation. A
    // recovered epoch keeps the persisted rule, and uses live context only if
    // a legacy checkpoint was persisted without baseline bytes.
    const frozenBaseline = admitted.epoch.baselineSystemPrompt
    const instructionText = frozenBaseline
      || [baseSystemPrompt, interactionGuidance].filter(Boolean).join("\n\n")
    if (instructionText) {
      systemInstructions = { text: instructionText, authoritative: !!frozenBaseline }
    }
    // A recovered epoch has no baseline bytes. Keep the hash restored from
    // the checkpoint snapshot so this turn's TurnEnded save does not drop it.
    const previousIdentity = sessionKey ? promptIdentityBySession.get(sessionKey) : undefined
    frozenSystemPromptHash = admitted.epoch.baselineHash.trim() || previousIdentity?.systemPromptHash
    if (sessionKey) {
      rememberPromptIdentity(sessionKey, {
        hostAgent: hostAgent || previousIdentity?.hostAgent,
        systemPromptHash: frozenSystemPromptHash,
      })
    }
  }
  const history = extractPromptHistory(prompt, {
    preserveTrailingUser: recovery?.kind === "rebase" && !checkpointUnusable,
    // A foreign-history rebase replays every tool result: the other model's work
    // exists only in OpenCode history, never in a Cursor checkpoint.
    toolResults: isCompaction || foreignHistory || checkpointUnusable ? "all" : (recovery?.kind === "rebase" ? "trailing" : "omit"),
    trailingSteer: recovery?.kind === "rebase" && recovery.steer === true,
    ...(recovery?.kind === "rebase" && recovery.toolCallIds ? { keepToolCallIds: recovery.toolCallIds } : {}),
  })

  await loadAvailableModels()

  // Resolve the region-specific Run stream origin once per process (memoized
  // in agent-url.ts). Explicit agent host overrides skip GetServerConfig but
  // still go through the Cursor agent-host allowlist.
  const agentBaseUrl =
    resolveExplicitAgentBaseURL(options) ??
    (await resolveAgentUrl(token, {
      apiBaseURL: resolveApiBaseURL(options),
      telemetryEnabled: resolveTelemetryEnabled(options),
    }))

  // OpenCode merges model, agent, and selected-variant options before placing
  // them under providerOptions.cursor. Read only the plugin's dedicated nested
  // payload so unrelated options never become requested_model.parameters.
  const picked = extractCursorVariantParameters(providerOptions)
  const cursorModelId = resolveCursorWireModelId(providerOptions, modelId)
  const reasoningEffort = typeof providerOptions?.reasoningEffort === "string"
    ? providerOptions.reasoningEffort
    : undefined
  const hintMaxMode = !!(providerOptions?.maxMode ?? false)

  const modelInfo = _availableModels?.find((m) => m.id === cursorModelId)
  const supportsImages = resolveCursorModelSupportsImages(cursorModelId, modelInfo?.supportsImages)
  if (!resuming) {
    assertCursorUserImageSupport(
      lastUser as unknown as Record<string, unknown> | undefined,
      supportsImages,
      cursorModelId,
    )
  }
  const imageExtraction = resuming
    ? { images: [], hashes: [], candidateCount: 0, duplicateCount: 0, userImageCount: 0 }
    : await extractCursorPromptImages(
        prompt as readonly unknown[],
        lastUser as unknown as Record<string, unknown> | undefined,
        {
          supportsImages,
          // Content hashes are retained for the OpenCode session so growing
          // history does not re-upload old screenshots. A recovery or
          // foreign-history rebase opens a new Cursor conversation, so it must
          // resend the same payload.
          seenHistoryHashes: recovery?.kind === "rebase" || foreignHistory
            ? undefined
            : sentHistoryImageHashes(sessionKey),
          signal: callOptions.abortSignal,
        },
      )
  if (!supportsImages && imageExtraction.candidateCount > 0) {
    trace(
      `image input: dropped ${imageExtraction.candidateCount} tool/assistant history image(s); ` +
      `model=${cursorModelId} does not support images`,
    )
  }
  if (imageExtraction.duplicateCount > 0) {
    trace(`image input: skipped ${imageExtraction.duplicateCount} previously sent history image(s)`)
  }
  const images = imageExtraction.images
  const parameterValues = resolveVariantParameters(modelInfo, {
    reasoningEffort,
    maxMode: hintMaxMode,
    picked,
  })
  // An explicit pick owns the context tier; otherwise honor the maxMode hint.
  // OpenCode's variant paramMap does not include maxMode when the user selects 1m.
  const maxMode = resolveVariantMaxMode(parameterValues, {
    picked,
    maxMode: hintMaxMode,
  })

  if (foreignHistory || checkpointUnusable) {
    assertForeignHistoryRebaseFits({
      modelInfo,
      cursorModelId,
      maxMode,
      history,
      systemPrompt,
      userText,
    })
  }

  // Do NOT pass callOptions.abortSignal into the h2 Run stream. OpenCode aborts
  // that signal when a turn ends with tool-calls; the Cursor stream must stay
  // open until we write the exec results on the next doStream.
  const stream = await bidiRunStream(token, {
    baseURL: agentBaseUrl,
    headers: options.headers,
  })
  // Freeze RequestContext per conversation_id (CLI parity). Rebuilding every
  // Run mutates volatile slices (git porcelain, layout) and breaks prompt cache.
  const { context: requestContext, reused: requestContextReused } = await getOrBuildRequestContext(
    conversationId,
    { workspaceRoot, tools: cursorTools, mergedConfig, systemInstructions },
  )
  // Skills live in the host system prompt and `skill` tool. Do not scan disk or
  // emit RequestContext `agent_skills` Mid-Conversation XML; host `<system-update>`
  // is the catalog-change channel.
  const contextSubagents = Array.isArray(requestContext.custom_subagents)
    ? requestContext.custom_subagents
        .map((agent) => agent && typeof agent === "object" && typeof (agent as Record<string, unknown>).name === "string"
          ? {
              name: (agent as Record<string, unknown>).name as string,
              description: typeof (agent as Record<string, unknown>).description === "string"
                ? (agent as Record<string, unknown>).description as string
                : undefined,
            }
          : undefined)
        .filter((agent): agent is { name: string; description: string | undefined } => !!agent)
    : []
  const subagentCatalog = {
    ...discoveredSubagentCatalog,
    agents: [...new Map(
      [...discoveredSubagentCatalog.agents, ...contextSubagents]
        .map((agent) => [agent.name, agent]),
    ).values()],
  }
  // Session exec remap / bridges need full McpToolDefinition identity. The wire
  // omits RequestContext.tools (#7); do not read descriptors from there.
  const toolDescriptors = toolsToDescriptors(cursorTools, "opencode", knownMcpServers)
  const runId = crypto.randomUUID()
  // CLI parity: echo the last conversation_checkpoint_update as conversation_state.
  // After compaction or an unsafe checkpoint reset there is no checkpoint —
  // seed a new Cursor conversation from OpenCode's authoritative history.
  const followUp = resuming ? resumeRecovery?.followUp : undefined
  const reqBytes = buildRunRequest({
    messageId: runId,
    text: followUp ?? userText,
    images,
    modelId: cursorModelId,
    conversationId,
    conversationGroupId,
    history: conversationState ? undefined : history,
    conversationState,
    parameterValues,
    maxMode,
    tools: cursorTools,
    toolDescriptors,
    requestContext,
    action: resuming && followUp === undefined ? "resume" : "user",
  })
  // Content hashes — Cursor content-addresses large payloads; logging these lets
  // us match a server get_blob_args.blob_id to what it wants served.
  const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex")
  const hooksCtx =
    typeof requestContext.hooks_additional_context === "string"
      ? requestContext.hooks_additional_context
      : ""
  const historyChars = history.reduce((n, m) => n + m.content.length, 0)
  const seedChars = conversationState
    ? 0
    : (systemPrompt?.length ?? 0) + userText.length + historyChars
  const seedEstimateIn = estimateTokens(seedChars)
  const checkpointEnvelopeEstimateIn = conversationState
    ? estimateTokens(userText.length + conversationState.length)
    : 0
  const runRequestWireEstimateIn = estimateTokens(reqBytes.length)
  const encodedRequestContext = encodeMessage("RequestContext", requestContext)
  const priorTokenDetails = decodeConversationTokenDetails(conversationState)
  const requestContextHash = sha(encodedRequestContext)
  const systemPromptHash = systemPrompt ? sha(systemPrompt) : undefined
  const usageEstimate = {
    // This is used only before Cursor supplies authoritative TurnEnded usage.
    // Estimate the actual protobuf request, not history/system text omitted by
    // checkpoint Runs. The opaque remote interpretation of KV blobs is logged
    // separately and deliberately is not mislabeled as a token count.
    inputTokens: runRequestWireEstimateIn,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningTokens: 0,
  }
  trace(
    `outbound Run: model=${cursorModelId} opencodeModel=${modelId} ` +
      `conversationId=${conversationId} conversationGroupId=${conversationGroupId} ` +
      `params=${JSON.stringify(parameterValues ?? [])} ` +
      `maxMode=${maxMode} systemPromptLen=${systemPrompt?.length ?? 0} ` +
      `tools=${tools.length} incomingTools=${incomingTools.length} compaction=${isCompaction} ` +
      `hooks=${hooksCtx ? hooksCtx.split("\n").length : 0} ` +
      `availableModels=${_availableModels?.length ?? 0} userTextLen=${userText.length} ` +
      `images=${images.length} imageBytes=${images.reduce((total, image) => total + image.data.length, 0)} ` +
      `historyMsgs=${history.length} historyChars=${historyChars} ` +
      `checkpointLen=${conversationState?.length ?? 0} checkpointBlobCount=${checkpointGraph.count} ` +
      `checkpointBlobBytes=${checkpointGraph.bytes} checkpointGraphComplete=${checkpointGraph.complete} ` +
      `seedChars=${seedChars} seedEstimateIn=${seedEstimateIn} ` +
      `checkpointEnvelopeEstimateIn=${checkpointEnvelopeEstimateIn} ` +
      `reset=${bound.reset} ` +
      `resume=${resuming} requestContextReused=${requestContextReused} ` +
      `usageEstimateMode=run-request-wire usageEstimateIn=${usageEstimate.inputTokens} ` +
      `runRequestBytes=${reqBytes.length} requestContextBytes=${encodedRequestContext.length}`,
  )
  if (hooksCtx) trace(`outbound Run hooks_additional_context: ${hooksCtx}`)
  trace(`hash run_request sha256=${sha(reqBytes)}`)
  if (systemPrompt) trace(`hash systemPrompt sha256=${sha(systemPrompt)}`)
  trace(`hash requestContext sha256=${requestContextHash}`)
  if (conversationState) trace(`hash checkpoint sha256=${sha(conversationState)}`)

  try {
    await writeWithBackpressure(stream, reqBytes, "initial Run request")
    rememberSentHistoryImageHashes(sessionKey, imageExtraction.hashes)
  } catch (error) {
    stream.destroy()
    throw error
  }

  const hostToolDialect = hostToolDialectFromTools(tools, options.defaultDialect)
  trace(
    `host tool dialect: filePathKey=${hostToolDialect.filePathKey} shellTool=${hostToolDialect.shellTool} ` +
      `skillArgKey=${hostToolDialect.skillArgKey} tools=[${tools.map((t) => t.name).join(",")}]`,
  )

  const session: CursorSession = {
    sessionId: crypto.randomUUID(),
    conversationId,
    cacheDir,
    resumeCheckpoint: undefined,
    tokenDetails: priorTokenDetails,
    tokenDetailsFresh: false,
    cacheDiagnostics: {
      sessionKey,
      conversationId,
      conversationGroupId,
      modelId: cursorModelId,
      priorTokenDetails,
      startedWithCheckpoint: !!conversationState,
      requestContextReused,
      requestContextHash,
      systemPromptHash,
      checkpointUpdates: 0,
      tokenDetailUpdates: 0,
      pumpPasses: 0,
      stepStarts: 0,
      stepCompletes: 0,
      displayToolCalls: 0,
      execRequests: 0,
      createPlanInTurn: false,
      switchModeInTurn: false,
    },
    openCodeSessionId: ephemeralRun ? undefined : sessionKey,
    stoppedWithSessionId: lifecycle ? undefined : sessionKey,
    checkpointRebaseEligible: !ephemeralRun && !resuming && !recovery && !!conversationState,
    hostAgent,
    stableSystemPromptHash: frozenSystemPromptHash,
    postCompactionRebase: isCompaction,
    toolCatalog: sessionKey ? snapshotToolCatalog(sessionKey) : structuredClone(tools),
    knownMcpServers,
    supportsImages,
    stream,
    runId,
    frames: stream.frames()[Symbol.asyncIterator](),
    pending: new Map(),
    displayToolCalls: new Map(),
    editToolCalls: new Map(),
    // Seed from the per-OpenCode-session copy: merges in this turn (and after
    // checkpoint resumes/rebases, which rebuild the session here) expand
    // against the last observed host list, not an empty one.
    mirroredTodos: snapshotMirroredTodosBySession(ephemeralRun ? undefined : sessionKey),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolDescriptors,
    toolAliases: webToolAliases.aliases,
    hostToolDialect,
    subagentCatalog,
    requestContext,
    allowTools,
    permittedToolNames: new Set(
      allowTools ? incomingTools.map((tool) => tool.name).filter((name): name is string => !!name) : [],
    ),
    usageEstimate,
    pumpActive: false,
    pumpOwner: null,
    heartbeat: null,
    heartbeatCancel: null,
    hardDeadlineTimer: null,
    semanticDeadlineCancel: null,
    terminalUnsubscribe: null,
    deferredTerminalReason: null,
    policy: continuationPolicy,
    createdAt: Date.now(),
    requestedAt: startOptions?.requestedAt ?? Date.now(),
    lastInboundAt: Date.now(),
    lastHeartbeatWriteAt: Date.now(),
    semanticDeadlineAt: Date.now() + continuationPolicy.semanticIdleMs,
    closeError: null,
    closed: false,
  }
  sessionManager.registerSession(session)

  attachSessionHeartbeat(session)

  session.reopenWithUserMessage = async (text: string, abortSignal = callOptions.abortSignal) => {
    const abortIfNeeded = (stream?: BidiStream): void => {
      if (!session.closed && !abortSignal?.aborted && !session.hostInterrupted) return
      try { stream?.destroy() } catch { /* already closed */ }
      if (abortSignal?.aborted || session.hostInterrupted) {
        throw new CursorLocalCancellationError("Cursor progress-only continuation cancelled")
      }
      throw new CursorProtocolError("Cannot reopen a closed Cursor session")
    }
    abortIfNeeded()
    const freshToken = await resolveRunBearerToken(options)
    abortIfNeeded()
    // Do not pass OpenCode's abortSignal into the h2 stream: a tool-calls abort
    // must not tear down a Run we still need to pump. Check abort around open.
    const next = await bidiRunStream(freshToken, { baseURL: agentBaseUrl, headers: options.headers })
    abortIfNeeded(next)
    const conversationState = session.resumeCheckpoint ?? getCheckpoint(session.conversationId)
    const nextRunId = crypto.randomUUID()
    const reqBytes = buildRunRequest({
      messageId: nextRunId,
      text,
      modelId: cursorModelId,
      conversationId: session.conversationId,
      conversationGroupId: session.cacheDiagnostics?.conversationGroupId ?? session.conversationId,
      conversationState,
      parameterValues,
      maxMode,
      toolDescriptors: session.toolDescriptors,
      requestContext: session.requestContext,
      action: "user",
    })
    try {
      await writeWithBackpressure(next, reqBytes, "progress-only continuation Run")
    } catch (error) {
      try { next.destroy() } catch {}
      throw error
    }
    abortIfNeeded(next)
    session.heartbeatCancel?.()
    await waitForStreamWrites(session.stream)
    abortIfNeeded(next)
    sessionManager.replaceStream(session, next)
    session.runId = nextRunId
    attachSessionHeartbeat(session)
  }

  callOptions.abortSignal?.addEventListener("abort", () => {
    // Abort after tool-calls is normal — preserve pending sessions.
    trace("abortSignal aborted → closeUnlessPending")
    sessionManager.closeUnlessPending(session)
  }, { once: true })
  return session
}

/**
 * OpenCode re-sends the full tool-result history on every continuation. Prefer
 * the newest result that still has a live pending exec on its tagged session.
 */
export function findContinuationSession(
  toolResults: Array<{ sessionId: string; execId: number }>,
): CursorSession | undefined {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i]
    const s = sessionManager.findByExecIds(r.sessionId, [r.execId])
    if (s) return s
  }
  return undefined
}

/**
 * True when `incoming` is a non-empty proper subset of `parent` by tool name.
 * Used to spot in-session helpers that reuse the parent OpenCode session id
 * with a reduced catalog (e.g. stripping `task` / `question` / `plan_exit`).
 */
export function isProperCatalogSubset(
  incoming: ReadonlyArray<{ name?: string }>,
  parent: ReadonlyArray<{ name?: string }>,
): boolean {
  if (incoming.length === 0 || parent.length === 0) return false
  if (incoming.length >= parent.length) return false
  const parentNames = new Set(
    parent.map((tool) => tool.name).filter((name): name is string => !!name),
  )
  if (parentNames.size === 0) return false
  let matched = 0
  for (const tool of incoming) {
    const name = tool.name
    if (!name || !parentNames.has(name)) return false
    matched++
  }
  return matched > 0 && matched < parentNames.size
}

/**
 * An open parent Run for this OpenCode session whose catalog strictly contains
 * the incoming tools is treated as an in-session helper. Those calls must not
 * cancel/supersede the parent (that remints on the trailing tool result).
 */
export function shouldIsolateInSessionHelper(
  openCodeSessionId: string | undefined,
  incomingTools: ReadonlyArray<{ name?: string }>,
): boolean {
  const prior = sessionManager.findOpenByOpenCodeSessionId(openCodeSessionId)
  if (!prior || prior.closed) return false
  return isProperCatalogSubset(incomingTools, prior.toolCatalog ?? [])
}

/** How long a fresh-turn drain may wait for Cursor `turn_ended` after bridged settle. */
export const FRESH_TURN_DRAIN_TIMEOUT_MS = 8_000

/**
 * Error text written onto Cursor execs that the host abandoned by starting a
 * new user turn before returning the tool result. Completing the held Run with
 * this cancel (then draining to `turn_ended`) keeps the same conversation
 * prefix instead of `superseded-by-new-run` mid-exec.
 */
export const FRESH_TURN_PENDING_CANCEL_REASON =
  "Host started a new user turn before this tool result was delivered"

/**
 * Before opening a new user-turn Run, finish the prior held-open Run cleanly:
 * settle display-only bridged pendings, cancel any real execs still waiting on
 * the host, then drain for `turn_ended`. That preserves the same
 * conversation_id / checkpoint prefix instead of aborting mid-tool.
 */
export async function preparePriorSessionForFreshTurn(
  openCodeSessionId: string | undefined,
  opts?: { timeoutMs?: number },
): Promise<"drained" | "settled-only" | "busy" | "none"> {
  const prior = sessionManager.findOpenByOpenCodeSessionId(openCodeSessionId)
  if (!prior) return "none"

  const settledBridged = sessionManager.settleBridgedPending(prior)
  if (settledBridged > 0) {
    trace(
      `fresh turn: settled ${settledBridged} bridged pending on prior session ${prior.sessionId} ` +
        `remainingPending=${prior.pending.size}`,
    )
  }

  if (sessionManager.isActivelyPumping(prior)) {
    // A live pull owns the stream; do not race cancel writes against it.
    // Wait briefly for the pump to finish, then cancel + drain.
    const waited = await waitUntilNotPumping(prior, {
      timeoutMs: opts?.timeoutMs ?? FRESH_TURN_DRAIN_TIMEOUT_MS,
    })
    if (!waited) {
      trace(
        `fresh turn: prior session ${prior.sessionId} is still pumping after wait — ` +
          `leaving that Run held; registerSession will not close it`,
      )
      return "busy"
    }
  }

  if (prior.closed) return "none"

  const cancelled = cancelPendingExecsForFreshTurn(prior)
  if (cancelled > 0) {
    trace(
      `fresh turn: cancelled ${cancelled} pending exec(s) on prior session ${prior.sessionId} ` +
        `remainingPending=${prior.pending.size}`,
    )
  }

  if (prior.closed) {
    // Cancel path closed the session (encode/write failure). Caller opens a
    // fresh Run on the same conversation_id — better than mid-exec supersede
    // with stranded pending, but turn_ended may be missing.
    return cancelled > 0 || settledBridged > 0 ? "settled-only" : "none"
  }

  if (prior.pending.size > 0) {
    trace(
      `fresh turn: prior session ${prior.sessionId} still has ${prior.pending.size} ` +
        `pending after cancel — leaving that Run held; registerSession will not close it`,
    )
    return "busy"
  }

  const outcome = await drainSessionUntilTurnEnded(prior, {
    timeoutMs: opts?.timeoutMs ?? FRESH_TURN_DRAIN_TIMEOUT_MS,
  })
  trace(`fresh turn: prior session ${prior.sessionId} drain outcome=${outcome}`)
  if (outcome === "turn-ended") return "drained"
  if (cancelled > 0 || settledBridged > 0) return "settled-only"
  return outcome === "timeout" || outcome === "interrupted" ? "settled-only" : "busy"
}

/**
 * Write error/reject results for every still-open non-bridged pending on the
 * held Run so Cursor can finish the agent turn instead of being superseded.
 *
 * @returns number of pendings successfully cancelled
 */
export function cancelPendingExecsForFreshTurn(session: CursorSession): number {
  if (session.closed || session.pending.size === 0) return 0
  const synthetic: ExtractedToolResult[] = []
  for (const [execId, pending] of session.pending.entries()) {
    if (pending.bridged || pending.aborted) continue
    if (pending.state !== "pending") continue
    synthetic.push({
      toolCallId: `cursor_${session.sessionId}_${execId}`,
      sessionId: session.sessionId,
      execId,
      toolName: pending.toolName ?? "unknown",
      output: FRESH_TURN_PENDING_CANCEL_REASON,
      error: FRESH_TURN_PENDING_CANCEL_REASON,
    })
  }
  if (synthetic.length === 0) return 0
  const before = session.pending.size
  const delivered = deliverContinuationResults(session, synthetic)
  if (!delivered || delivered.closed) {
    // deliverContinuationResults closes on encode/write failure after some
    // claims may already have succeeded.
    return Math.max(0, before - session.pending.size)
  }
  return Math.max(0, before - session.pending.size)
}

/** Cursor CLI's cancel reason for a user Stop. */
const HOST_INTERRUPT_CANCEL_REASON = "user_cancelled"
/** How long a cancelled Run may take to end by itself before its stream is closed. */
export const HOST_INTERRUPT_GRACE_MS = 3_000

/**
 * The host stopped the turn. OpenCode 2 never aborts `doStream` for that, so
 * the Run would keep generating, and a held one would wait on results that
 * never come. Cancel it as Cursor CLI's Stop does: forget what the host owed,
 * send `cancel_action`, give Cursor a moment to end the Run, then close it.
 */
export async function cancelRunForHostInterrupt(
  session: CursorSession,
  reason: string,
  opts?: { graceMs?: number },
): Promise<void> {
  if (session.closed || session.hostInterrupted) return
  session.hostInterrupted = reason
  const graceMs = opts?.graceMs ?? HOST_INTERRUPT_GRACE_MS
  const dropped = sessionManager.abandonPending(session)
  session.heartbeatCancel?.()
  trace(
    `host interrupt: cancelling Run sessionId=${session.sessionId} reason=${reason} ` +
      `pumping=${sessionManager.isActivelyPumping(session)} droppedPending=${dropped}`,
  )
  const startedAt = Date.now()
  try {
    await writeWithBackpressure(session.stream, buildCancelAction(HOST_INTERRUPT_CANCEL_REASON), "cancel action")
  } catch (error) {
    trace(`host interrupt: cancel write failed sessionId=${session.sessionId} err=${(error as Error).message}`)
    sessionManager.close(session, "host-interrupted")
    return
  }
  const remainingMs = () => Math.max(1, graceMs - (Date.now() - startedAt))
  // A pump stops at its next frame and leaves it queued for the drain.
  if (!(await waitUntilNotPumping(session, { timeoutMs: remainingMs() }))) {
    trace(`host interrupt: Run sessionId=${session.sessionId} still pumping after ${Date.now() - startedAt}ms`)
    sessionManager.close(session, "host-interrupted")
    return
  }
  // The pump may have taken an exec it was already handling.
  sessionManager.abandonPending(session)
  const outcome = await drainSessionUntilTurnEnded(session, { timeoutMs: remainingMs(), cancelled: true })
  trace(`host interrupt: Run sessionId=${session.sessionId} drain outcome=${outcome} afterMs=${Date.now() - startedAt}`)
  sessionManager.close(session, "host-interrupted")
}

const HOST_INTERRUPT_MEMORY_MS = 10 * 60_000
/** The latest stop per OpenCode session, for a Run whose model call started before it but opened after it. */
const hostInterrupts = new Map<string, { at: number; reason: string }>()

function cancelForHostInterrupt(session: CursorSession, reason: string): void {
  void cancelRunForHostInterrupt(session, reason).catch((error) => {
    trace(`host interrupt: cancel failed sessionId=${session.sessionId} err=${(error as Error).message}`)
  })
}

/** Runs of the stopped call were requested before the stop; the next turn's after it. */
function requestedBefore(session: CursorSession, at: number): boolean {
  return (session.requestedAt ?? session.createdAt) < at
}

export function cancelIfHostStoppedSince(session: CursorSession): void {
  const sessionId = stoppedWith(session)
  const stop = sessionId ? hostInterrupts.get(sessionId) : undefined
  if (stop && requestedBefore(session, stop.at)) cancelForHostInterrupt(session, stop.reason)
}

onHostInterrupt((openCodeSessionId, reason, at) => {
  for (const [id, stop] of hostInterrupts) {
    if (stop.at < at - HOST_INTERRUPT_MEMORY_MS) hostInterrupts.delete(id)
  }
  hostInterrupts.set(openCodeSessionId, { at, reason })
  for (const session of sessionManager.openSessionsStoppedWith(openCodeSessionId)) {
    if (requestedBefore(session, at)) cancelForHostInterrupt(session, reason)
  }
})

const heldRunWatchers = new WeakSet<CursorSession>()

/**
 * While the host runs a step's tools nobody reads the held Run, yet Cursor
 * keeps sending: KV writes, heartbeats, an exec abort. Answer those as they
 * come and leave any other frame queued for the pump that delivers the results.
 */
async function watchHeldRun(session: CursorSession): Promise<void> {
  if (heldRunWatchers.has(session)) return
  heldRunWatchers.add(session)
  try {
    while (!session.closed && session.pending.size > 0 && !sessionManager.isActivelyPumping(session)) {
      const read = takeFrame(session)
      session.queuedFrame = read
      let next: IteratorResult<Frame>
      try {
        next = await read
      } catch {
        return
      }
      if (session.queuedFrame !== read || session.closed || sessionManager.isActivelyPumping(session)) return
      if (next.done || next.value.flags & 0x02) return
      const frame = heldRunControlFrame(session, next.value)
      if (!frame) return
      // Taken before any await, so a pump starting meanwhile reads the next frame instead.
      session.queuedFrame = undefined
      sessionManager.recordSemanticProgress(session)
      if (frame.kind === "exec-control") {
        applyExecControl(session, frame.control, "held")
      } else if (frame.kind === "kv") {
        try {
          await writeWithBackpressure(session.stream, frame.handled.reply, `held KV ${frame.handled.kind}_blob reply id=${frame.handled.id}`)
          trace(`held Run: answered KV ${frame.handled.kind} id=${frame.handled.id} sessionId=${session.sessionId}`)
        } catch (error) {
          trace(`held Run: KV reply failed sessionId=${session.sessionId} err=${(error as Error).message}`)
          sessionManager.close(session, "reply-write-failed")
          return
        }
      }
    }
  } finally {
    heldRunWatchers.delete(session)
  }
}

type HeldRunControlFrame =
  | { kind: "heartbeat" }
  | { kind: "exec-control"; control: Record<string, unknown> }
  | { kind: "kv"; handled: NonNullable<ReturnType<typeof handleKvServerMessage>> }

/** A frame the held-Run watcher answers itself; anything else is the pump's. */
function heldRunControlFrame(session: CursorSession, frame: Frame): HeldRunControlFrame | undefined {
  let payload: Uint8Array
  let asm: Record<string, unknown>
  try {
    payload = decodeFramePayload(frame)
    asm = decodeMessage<Record<string, unknown>>("AgentServerMessage", payload)
  } catch {
    return undefined
  }
  const fields = readAllFieldsStrict(payload)
  if (!fields || fields.length !== 1) return undefined
  const control = asm.exec_server_control_message as Record<string, unknown> | undefined
  if (control) return { kind: "exec-control", control }
  if (!isSoleControlFrame(payload)) return undefined
  const iu = asm.interaction_update as Record<string, unknown> | undefined
  if (iu?.heartbeat) return { kind: "heartbeat" }
  // A get can miss, which only the pump knows how to recover from.
  const kv = asm.kv_server_message as Record<string, unknown> | undefined
  const handled = kv?.set_blob_args ? handleKvServerMessage(kv, session) : undefined
  return handled ? { kind: "kv", handled } : undefined
}

async function waitUntilNotPumping(
  session: CursorSession,
  opts: { timeoutMs: number },
): Promise<boolean> {
  if (!sessionManager.isActivelyPumping(session)) return true
  const deadlineAt = Date.now() + Math.max(1, opts.timeoutMs)
  while (Date.now() < deadlineAt) {
    if (session.closed) return false
    if (!sessionManager.isActivelyPumping(session)) return true
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 25)
      timer.unref?.()
    })
  }
  return !sessionManager.isActivelyPumping(session)
}

// Cursor sends `tool_requests_listed` once the model has generated a step's tool
// calls; until it has in this process, every host call ends its own AI SDK step.
let cursorListsToolRequests = false
// Liveness only: closes a held step whose listed calls never all arrive.
const HELD_TOOL_STEP_QUIET_MS = 1_500

/** The queued frame read, if any, else a new one. */
function takeFrame(session: CursorSession): Promise<IteratorResult<Frame>> {
  const queued = session.queuedFrame
  session.queuedFrame = undefined
  return queued ?? session.frames.next()
}

/**
 * The next frame, or undefined when none arrives within `timeoutMs`. A read
 * that times out stays queued on the session, so the next reader gets its frame.
 */
async function nextFrameWithin(
  session: CursorSession,
  timeoutMs: number,
): Promise<IteratorResult<Frame> | undefined> {
  const read = takeFrame(session)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs)
    timer.unref?.()
  })
  try {
    const result = await Promise.race([read, timedOut])
    if (result === undefined) {
      session.queuedFrame = read
      // The eventual reader observes a failure; do not report it unhandled here.
      read.catch(() => {})
    }
    return result
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read remaining frames on an idle held-open Run until `turn_ended`, a
 * response-requiring request we cannot answer without the host, or timeout.
 * Used only to settle a Run the host left (a fresh turn, a host interrupt) —
 * not a general pump substitute. `cancelled`: the Run was sent `cancel_action`,
 * so nothing it still sends (display updates, an exec already in flight) needs
 * the host, and Cursor's closing frames (the final checkpoint) are worth reading.
 */
export async function drainSessionUntilTurnEnded(
  session: CursorSession,
  opts?: { timeoutMs?: number; cancelled?: boolean },
): Promise<"turn-ended" | "busy" | "timeout" | "interrupted" | "skipped"> {
  if (session.closed) return "skipped"
  if (session.pending.size > 0 || sessionManager.isActivelyPumping(session)) return "busy"

  const timeoutMs = Math.max(1, opts?.timeoutMs ?? FRESH_TURN_DRAIN_TIMEOUT_MS)
  const owner = Symbol(`fresh-turn-drain:${session.sessionId}`)
  sessionManager.beginPump(session, owner)
  const deadlineAt = Date.now() + timeoutMs
  let outcome: "turn-ended" | "busy" | "timeout" | "interrupted" = "timeout"

  try {
    while (Date.now() < deadlineAt) {
      if (session.closed) {
        outcome = "interrupted"
        break
      }
      const remainingMs = Math.max(1, deadlineAt - Date.now())
      let next: IteratorResult<Frame> | undefined
      try {
        next = await nextFrameWithin(session, remainingMs)
      } catch (error) {
        trace(
          `fresh turn drain: frame wait failed sessionId=${session.sessionId} ` +
            `err=${(error as Error).message}`,
        )
        outcome = "interrupted"
        break
      }
      if (!next) {
        outcome = "timeout"
        break
      }
      if (next.done) {
        outcome = "interrupted"
        break
      }

      const frame = next.value as Frame
      if (frame.flags & 0x02) {
        outcome = "interrupted"
        break
      }

      let payload: Uint8Array
      try {
        payload = decodeFramePayload(frame)
      } catch {
        continue
      }
      let asm: Record<string, unknown>
      try {
        asm = decodeMessage<Record<string, unknown>>("AgentServerMessage", payload)
      } catch {
        continue
      }

      const iu = asm.interaction_update as Record<string, unknown> | undefined
      const kv = asm.kv_server_message as Record<string, unknown> | undefined
      const esm = asm.exec_server_message as Record<string, unknown> | undefined
      const interactionQuery = asm.interaction_query as Record<string, unknown> | undefined
      const checkpointRaw = asm.conversation_checkpoint_update
      const requiredChannel = responseRequiredChannel(payload)
      const execControl = asm.exec_server_control_message as Record<string, unknown> | undefined
      if (execControl) {
        applyExecControl(session, execControl, "drain")
        continue
      }

      if (checkpointRaw != null) {
        const bytes = normalizeCheckpointBytes(checkpointRaw)
        if (bytes && bytes.length > 0) {
          if (session.cacheDiagnostics) session.cacheDiagnostics.checkpointUpdates++
          setCheckpoint(session.conversationId, bytes)
          session.resumeCheckpoint = Uint8Array.from(bytes)
          const tokenDetails = decodeConversationTokenDetails(bytes)
          if (tokenDetails) {
            if (session.cacheDiagnostics) session.cacheDiagnostics.tokenDetailUpdates++
            session.tokenDetails = tokenDetails
            session.tokenDetailsFresh = true
          }
        }
      }

      if (iu?.turn_ended) {
        trace(`fresh turn drain: turn_ended raw wire fields: ${debugWalkTurnEnded(payload)}`)
        if (session.openCodeSessionId) {
          await persistConversationState(
            session.cacheDir ?? opencodeGlobalCacheDir(),
            {
              sessionKey: session.openCodeSessionId,
              conversationId: session.conversationId,
              requestContext: session.requestContext,
              toolCatalog: session.toolCatalog ?? [],
              postCompactionRebase: session.postCompactionRebase,
              hostAgent: session.hostAgent,
              systemPromptHash: session.stableSystemPromptHash,
            },
          ).catch((error) => {
            trace(
              `fresh turn drain: TurnEnded save failed ` +
                `sessionKey=${session.openCodeSessionId}: ${String(error)}`,
            )
          })
        }
        // Record TurnEnded cache counters on diagnostics for the abandoned Run
        // even though no OpenCode stream consumer will see this finish.
        const turnEnded = iu.turn_ended as Record<string, unknown>
        const counters = cursorUsageCountersFromTurnEnded(turnEnded)
        if (session.cacheDiagnostics) {
          trace(formatCursorCacheDiagnostics(
            counters,
            session.tokenDetails,
            session.cacheDiagnostics.priorTokenDetails,
            {
              ...session.cacheDiagnostics,
              conversationGroupId: session.cacheDiagnostics.conversationGroupId
                ?? resolveConversationGroupId(session.openCodeSessionId, session.conversationId),
              modelId: session.cacheDiagnostics.modelId,
            },
          ))
        } else {
          trace(
            `fresh turn drain: turn_ended input=${counters.inputTokens} ` +
              `cacheRead=${counters.cacheRead} output=${counters.outputTokens}`,
          )
        }
        sessionManager.close(session, "turn-ended")
        outcome = "turn-ended"
        break
      }

      if (kv) {
        const handled = handleKvServerMessage(kv, session)
        if (!handled) {
          outcome = "busy"
          break
        }
        try {
          await writeWithBackpressure(
            session.stream,
            handled.reply,
            `fresh-turn-drain KV ${handled.kind}_blob reply id=${handled.id}`,
          )
        } catch (error) {
          trace(
            `fresh turn drain: KV reply failed sessionId=${session.sessionId} ` +
              `err=${(error as Error).message}`,
          )
          outcome = "interrupted"
          break
        }
        sessionManager.recordSemanticProgress(session)
        continue
      }

      // Text/thinking/heartbeat/partial display updates can be ignored while draining.
      if (iu?.text_delta || iu?.thinking_delta || iu?.heartbeat || iu?.partial_tool_call || iu?.step_started || iu?.step_completed) {
        sessionManager.recordSemanticProgress(session)
        continue
      }
      if (opts?.cancelled) {
        sessionManager.recordSemanticProgress(session)
        continue
      }
      if (iu?.tool_call_started || iu?.tool_call_completed) {
        // A new display tool needs host mediation — stop draining.
        outcome = "busy"
        break
      }

      if (esm || interactionQuery || requiredChannel === "exec" || requiredChannel === "interaction") {
        outcome = "busy"
        break
      }
    }
  } finally {
    sessionManager.endPump(session, owner)
  }
  return outcome
}

/**
 * Turn an OpenCode `question` tool result into the frame Cursor is waiting for.
 *
 * A synchronous AskQuestion still has its InteractionQuery open, so the answer
 * goes back as the InteractionResponse for that query id. A `run_async` one was
 * already released with `async{}`, so — exactly as Cursor CLI does — the answer
 * travels as a ConversationAction keyed by the originating tool call id, with
 * the server's own AskQuestionArgs bytes echoed back untouched.
 */
function buildAskQuestionContinuationFrame(
  pending: PendingExec,
  result: ExtractedToolResult,
): Uint8Array {
  const metadata = pending.resultMetadata ?? {}
  const args = metadata.askQuestionArgs as CursorAskQuestionArgs | undefined
  if (!args) throw new CursorProtocolError("Bridged AskQuestion lost its decoded arguments")
  const answer = askQuestionResultFromToolOutput(args, result.output, result.error !== undefined)
  if (!args.runAsync) {
    const interactionId = metadata.interactionId
    if (typeof interactionId !== "number") {
      throw new CursorProtocolError("Bridged AskQuestion lost its interaction id")
    }
    return buildAskQuestionInteractionReply(interactionId, answer)
  }
  const rawArgs = metadata.askQuestionRawArgs
  if (!(rawArgs instanceof Uint8Array)) {
    throw new CursorProtocolError("Bridged async AskQuestion lost its original arguments")
  }
  const toolCallId = metadata.askQuestionToolCallId
  return buildAsyncAskQuestionCompletion(
    typeof toolCallId === "string" ? toolCallId : "",
    rawArgs,
    answer,
  )
}

/**
 * Turn the host's plan-approval outcome into the CreatePlan reply Cursor is
 * still blocking on. One contract across every channel: `success` means the
 * user approved execution, `error` means the plan was written but not accepted,
 * so the model keeps planning instead of starting work.
 *
 * A host plan-stage tool reports that outcome as tool success/failure. The
 * emulated path asks through `question`, so only an explicit "Yes" approves.
 * On approval the session leaves plan mode, which arms the agent-mode
 * `<system_reminder>` for the next Run.
 */
function buildCreatePlanContinuationFrame(
  pending: PendingExec,
  result: ExtractedToolResult,
  sessionKey: string | undefined,
  cursorSessionID: string,
): Uint8Array {
  const metadata = pending.resultMetadata ?? {}
  const interactionId = metadata.interactionId
  if (typeof interactionId !== "number") {
    throw new CursorProtocolError("Bridged CreatePlan lost its interaction id")
  }
  const planUri = metadata.planUri
  if (typeof planUri !== "string" || !planUri.trim()) {
    throw new CursorProtocolError("Bridged CreatePlan lost its plan URI")
  }

  const approved = metadata.createPlanBridgeKind === "approve"
    ? createPlanApproved(
        result.output,
        result.error !== undefined,
        typeof metadata.createPlanQuestion === "string" ? metadata.createPlanQuestion : "",
      )
    : result.error === undefined
  if (!approved) {
    const reason = result.error?.trim()
    return buildCreatePlanInteractionReply(interactionId, {
      error: { error: reason || CREATE_PLAN_NOT_APPROVED_REASON },
      plan_uri: "",
    })
  }

  // The question-emulated path can report execution approval only when a host
  // kickoff exists. Otherwise keep planning mode active and return an error.
  if (metadata.createPlanBridgeKind === "approve" && !hasPlanExecutionKickoff()) {
    return buildCreatePlanInteractionReply(interactionId, {
      error: { error: "The plan was approved, but this host cannot start its execution turn." },
      plan_uri: planUri,
    })
  }

  // Approved: planning is over for this plan, so drop the plan-mode reminder
  // and hand the next Run the agent-mode contract, exactly as an approved
  // plan_exit does.
  setActiveCursorMode(sessionKey, "agent")

  // Only the question-emulated path needs the provider's synthetic build turn.
  // A host stage tool owns both approval and execution handoff itself.
  if (metadata.createPlanBridgeKind === "approve" && sessionKey) {
    const absolute =
      typeof metadata.planPath === "string" && metadata.planPath.trim()
        ? metadata.planPath.trim()
        : planPathFromUri(planUri)
    const workspaceRoot =
      typeof metadata.workspaceRoot === "string" ? metadata.workspaceRoot : undefined
    if (!queuePlanExecutionKickoff({
      sessionID: sessionKey,
      planPath: formatPlanKickoffPath(absolute, workspaceRoot),
      cursorSessionID,
    })) {
      return buildCreatePlanInteractionReply(interactionId, {
        error: { error: "The plan was approved, but this host cannot start its execution turn." },
        plan_uri: planUri,
      })
    }
  }

  return buildCreatePlanInteractionReply(interactionId, {
    success: {},
    plan_uri: planUri,
  })
}

function buildSwitchModeContinuationFrame(
  pending: PendingExec,
  result: ExtractedToolResult,
): {
  frame: Uint8Array
  approvedTarget?: string
  bridgeKind?: unknown
} {
  const metadata = pending.resultMetadata ?? {}
  const interactionId = metadata.interactionId
  if (typeof interactionId !== "number") {
    throw new CursorProtocolError("Bridged SwitchMode lost its interaction id")
  }
  // A question-emulated exit carries the user's Yes/No as prose, not a plan
  // tool's success/failure, so it needs the answer parser rather than the
  // error-shaped mapping.
  const answer = metadata.switchModeBridgeKind === "question"
    ? switchModeResultFromQuestionOutput(result.output, result.error !== undefined)
    : switchModeResultFromToolOutput(result.output, result.error !== undefined)
  const target = "approved" in answer && typeof metadata.switchModeTarget === "string"
    ? metadata.switchModeTarget.trim()
    : ""
  return {
    frame: buildSwitchModeInteractionReply(interactionId, answer),
    ...(target ? { approvedTarget: target, bridgeKind: metadata.switchModeBridgeKind } : {}),
  }
}

/**
 * Deliver trailing tool results onto a live continuation session.
 * Returns the same session when writes succeed (or only bridged results were
 * cleared). Returns undefined after closing the session when a write fails, so
 * the caller can rebase onto a fresh Run instead of pumping a dead stream.
 */
export function deliverContinuationResults(
  session: CursorSession,
  trailingToolResults: ExtractedToolResult[],
): CursorSession | undefined {
  const pendingResults = trailingToolResults.filter(
    (r) => r.sessionId === session.sessionId && session.pending.has(r.execId),
  )
  trace(
    `continuation: ${trailingToolResults.length} trailing tool result(s), ` +
      `${pendingResults.length} pending for sessionId=${session.sessionId} ` +
      `pending={${[...session.pending.keys()].join(",")}}`,
  )
  // Built once, so the note's carrier is chosen against the frames actually sent.
  const completeEditReads = new Map<number, Uint8Array[]>()
  for (const r of pendingResults) {
    const pending = session.pending.get(r.execId)
    const editRead = pending && !pending.bridged && !pending.aborted ? correlatedEditRead(session, pending, r) : undefined
    const frames = editRead && buildCompleteEditReadMessages(r.execId, editRead.absolutePath, editRead.requestedPath)
    if (frames) completeEditReads.set(r.execId, frames)
  }
  let note = joinNotes([session.deferredNote, ...trailingToolResults.map((r) => r.note)])
  session.deferredNote = undefined
  const noteCarrier = note === undefined ? undefined : findNoteCarrier(session, pendingResults, completeEditReads)
  for (const r of pendingResults) {
    const claim = sessionManager.claim(session.sessionId, r.execId)
    if ("kind" in claim) {
      if (claim.kind === "deliverable") {
        throw new CursorProtocolError("Cursor continuation claim remained unclaimed")
      }
      if (claim.kind === "duplicate") {
        trace(`continuation: skipped duplicate execId=${r.execId} reason=${claim.reason}`)
        continue
      }
      trace(`continuation: unavailable execId=${r.execId} reason=${claim.reason}`)
      return undefined
    }
    const pending = claim.pending
    let frames: Uint8Array[] = []
    let framesCarryNote = false
    let deliveredSwitchMode: { target: string; bridgeKind?: unknown } | undefined
    let deliveredImageHashes: string[] = []
    if (pending.resultField === ASK_QUESTION_RESULT_FIELD) {
      // A bridged Cursor AskQuestion. The host tool result carries the user's
      // choices; translate them back into the Cursor result the interaction is
      // waiting for (or into the deferred completion, when Cursor was already
      // released with `async`).
      try {
        frames = [buildAskQuestionContinuationFrame(pending, r)]
      } catch (error) {
        trace(`continuation: ask_question encode FAILED execId=${r.execId} err=${(error as Error).message}`)
        sessionManager.close(session, "result-write-failed")
        return undefined
      }
    } else if (pending.resultField === SWITCH_MODE_RESULT_FIELD) {
      // Bridged SwitchMode: host plan_enter / plan_exit outcome becomes
      // approved{} or rejected{reason} on the still-open InteractionQuery.
      // Approval also arms the CLI-shaped mode reminder for the next Run.
      try {
        const built = buildSwitchModeContinuationFrame(pending, r)
        frames = [built.frame]
        if (built.approvedTarget) {
          deliveredSwitchMode = {
            target: built.approvedTarget,
            bridgeKind: built.bridgeKind,
          }
        }
      } catch (error) {
        trace(`continuation: switch_mode encode FAILED execId=${r.execId} err=${(error as Error).message}`)
        sessionManager.close(session, "result-write-failed")
        return undefined
      }
    } else if (pending.resultField === CREATE_PLAN_RESULT_FIELD) {
      try {
        frames = [buildCreatePlanContinuationFrame(
          pending,
          r,
          session.openCodeSessionId,
          session.sessionId,
        )]
      } catch (error) {
        trace(`continuation: create_plan encode FAILED execId=${r.execId} err=${(error as Error).message}`)
        sessionManager.close(session, "result-write-failed")
        return undefined
      }
    } else if (pending.aborted) {
      if (isShellResultField(pending.resultField)) consumeCursorShellResult(r.toolCallId, r.output)
      trace(`continuation: dropped the result of execId=${r.execId}, which Cursor aborted`)
    } else if (!pending.bridged) {
      try {
        const shellResult = isShellResultField(pending.resultField)
          ? consumeCursorShellResult(r.toolCallId, r.output)
          : undefined
        const editRead = correlatedEditRead(session, pending, r)
        if (editRead) {
          frames = completeEditReads.get(r.execId) ?? []
          if (frames.length > 0) {
            editRead.edit.completeRead = true
            trace(
              `continuation: upgraded authorized correlated edit read execId=${r.execId} ` +
                `path=${JSON.stringify(editRead.requestedPath)}`,
            )
          }
        }
        // A refused image commit is Cursor's own `permission_denied` variant,
        // not a generic write error: its agent branches on that case. The
        // marker is set by this provider's own tool, so matching it is a
        // contract rather than a guess at someone else's message text.
        if (
          pending.toolName === CURSOR_IMAGE_SAVE_TOOL
          && pending.resultField === "write_result"
          && r.error?.includes(IMAGE_PERMISSION_DENIED_PREFIX)
        ) {
          const deniedPath = typeof pending.resultMetadata?.path === "string"
            ? pending.resultMetadata.path
            : ""
          frames = [encodeMessage("AgentClientMessage", {
            exec_client_message: {
              id: r.execId,
              write_result: {
                permission_denied: {
                  path: deniedPath,
                  directory: deniedPath ? path.dirname(deniedPath) : "",
                  operation: "write",
                  error: r.error.replace(`${IMAGE_PERMISSION_DENIED_PREFIX} `, ""),
                  is_readonly: false,
                },
              },
            },
          })]
        }
        // A committed image reports the file Cursor asked about, not the tool's
        // prose. `buildExecClientMessages` would otherwise put the message's
        // character count in `WriteSuccess.file_size`.
        if (
          frames.length === 0
          && !r.error
          && pending.toolName === CURSOR_IMAGE_SAVE_TOOL
          && pending.resultField === "write_result"
        ) {
          frames = [encodeMessage("AgentClientMessage", {
            exec_client_message: {
              id: r.execId,
              write_result: {
                success: {
                  path: typeof pending.resultMetadata?.path === "string"
                    ? pending.resultMetadata.path
                    : "",
                  lines_created: 0,
                  file_size: typeof pending.resultMetadata?.imageByteLength === "number"
                    ? pending.resultMetadata.imageByteLength
                    : 0,
                },
              },
            },
          })]
        }
        if (frames.length === 0) {
          const input = continuationResultInput(session, pending, r, shellResult)
          const images = input.images ?? []
          if (r === noteCarrier && note !== undefined) {
            const built = buildExecClientMessagesWithNote(input, note)
            frames = built.frames
            framesCarryNote = built.noteCarried
          } else {
            frames = buildExecClientMessages(input)
          }
          if (images.length > 0) {
            deliveredImageHashes = r.imageHashes?.slice(0, images.length) ?? []
            trace(`continuation: ${images.length} tool-result image(s) on ${pending.resultField} execId=${r.execId}`)
          }
        }
      } catch (error) {
        trace(`continuation: result encode FAILED execId=${r.execId} err=${(error as Error).message}`)
        sessionManager.close(session, "result-write-failed")
        return undefined
      }
    }
    const outcome = sessionManager.deliverClaim(claim, frames)
    if (outcome.kind !== "delivered") {
      trace(`continuation: delivery stopped execId=${r.execId} reason=${outcome.reason}`)
      if (outcome.kind === "duplicate") continue
      return undefined
    }
    // Cursor now holds these in the exec result; the next fresh Run must not
    // attach them again as history images.
    rememberSentHistoryImageHashes(session.openCodeSessionId, deliveredImageHashes)
    if (framesCarryNote) {
      trace(`continuation: host note rode on execId=${r.execId} field=${pending.resultField}`)
      note = undefined
    }
    if (deliveredSwitchMode) {
      const normalized = deliveredSwitchMode.target.toLowerCase()
      setActiveCursorMode(session.openCodeSessionId, deliveredSwitchMode.target, {
        bridgedPlanEntered: normalized === "plan" || normalized === "spec",
      })
      // A question-emulated exit has no native host plan tool to perform the
      // actual primary-agent switch. Queue only after Cursor received the
      // approved response; a failed write must not mutate host mode.
      if (deliveredSwitchMode.bridgeKind === "question" && session.openCodeSessionId) {
        queueHostAgentModeSwitch({
          sessionID: session.openCodeSessionId,
          targetModeID: deliveredSwitchMode.target,
          cursorSessionID: session.sessionId,
        })
      }
    }
    // A directly called advertised plan-stage tool can own the same review
    // gate as a bridged CreatePlan. Its successful result means execution was
    // approved, so the next Run must carry agent-mode guidance.
    if (
      !pending.bridged
      && pending.toolName === CURSOR_PLAN_STAGE_TOOL
      && r.error === undefined
    ) {
      setActiveCursorMode(session.openCodeSessionId, "agent")
    }
    // A host `todoread` result is the authoritative list. Refresh the mirrored
    // snapshot (direct reads and bridged native reads alike) so later merges
    // apply onto host truth, not a stale write.
    if (pending.toolName === "todoread" && r.error === undefined) {
      const snapshot = snapshotMirroredTodosFromReadOutput(r.output)
      if (snapshot !== undefined) {
        storeMirroredTodos(session, snapshot)
        trace(`continuation: mirrored todoread snapshot items=${snapshot.length}`)
      }
    }
    session.usageEstimate.inputTokens += estimateTokens(r.output.length)
    if (pending.bridged) {
      trace(
        `continuation: completed bridged result execId=${r.execId} toolName=${pending.toolName ?? r.toolName} outLen=${r.output.length}`,
      )
      continue
    }
    const resultKind =
      pending.resultField === ASK_QUESTION_RESULT_FIELD
        ? "ask_question answer"
        : pending.resultField === SWITCH_MODE_RESULT_FIELD
          ? "switch_mode answer"
          : pending.resultField === CREATE_PLAN_RESULT_FIELD
            ? "create_plan answer"
            : "exec result"
    trace(
      `continuation: wrote ${resultKind} execId=${r.execId} field=${pending.resultField} ` +
        `frames=${outcome.framesWritten} outLen=${r.output.length}`,
    )
  }
  if (note !== undefined) {
    session.deferredNote = note
    trace(`continuation: no result could carry the host note; deferred to the next exec result noteLen=${note.length}`)
  }
  return session
}

function isShellResultField(resultField: string): boolean {
  return resultField === "shell_stream" || resultField === "shell_result" || resultField === "background_shell_spawn_result"
}

/** The authorized read inside Cursor's edit transaction, answered with the complete file. */
function correlatedEditRead(
  session: CursorSession,
  pending: PendingExec,
  r: ExtractedToolResult,
): { edit: { path: string; completeRead?: boolean }; absolutePath: string; requestedPath: string } | undefined {
  const callId = pending.resultMetadata?.correlatedEditCallId
  const requestedPath = pending.resultMetadata?.path
  if (r.error || pending.resultField !== "read_result" || pending.toolName !== "read") return undefined
  if (typeof callId !== "string" || typeof requestedPath !== "string") return undefined
  const edit = session.editToolCalls?.get(callId)
  if (!edit) return undefined
  const workspaceRoot = workspaceRootFromRequestContext(session.requestContext)
  const absolutePath = path.resolve(workspaceRoot, requestedPath)
  return absolutePath === path.resolve(workspaceRoot, edit.path) ? { edit, absolutePath, requestedPath } : undefined
}

function continuationResultInput(
  session: CursorSession,
  pending: PendingExec,
  r: ExtractedToolResult,
  shellResult: { output: string; outcome?: CursorShellOutcome } | undefined,
): ToolResultInput {
  return {
    execId: r.execId,
    resultField: pending.resultField,
    output: shellResult?.output ?? r.output,
    error: r.error,
    toolName: pending.toolName ?? r.toolName,
    resultMetadata: pending.resultMetadata,
    shellOutcome: shellResult?.outcome,
    workspaceRoot: workspaceRootFromRequestContext(session.requestContext),
    images: r.error ? [] : execResultImages(pending.resultField, r.images),
  }
}

/** The last result whose encoded shape will hold a host note. */
function findNoteCarrier(
  session: CursorSession,
  results: readonly ExtractedToolResult[],
  completeEditReads: ReadonlyMap<number, Uint8Array[]>,
): ExtractedToolResult | undefined {
  return [...results].reverse().find((r) => {
    const pending = session.pending.get(r.execId)
    if (!pending || !isExecResultPending(pending)) return false
    // Cursor rewrites the complete-file read of an edit as the new file, and
    // image saves have their own encoders.
    if (completeEditReads.has(r.execId)) return false
    if (
      pending.toolName === CURSOR_IMAGE_SAVE_TOOL
      && pending.resultField === "write_result"
      && (!r.error || r.error.includes(IMAGE_PERMISSION_DENIED_PREFIX))
    ) return false
    const shellResult = isShellResultField(pending.resultField) ? peekCursorShellResult(r.toolCallId, r.output) : undefined
    return resultCanCarryNote(continuationResultInput(session, pending, r, shellResult))
  })
}

function isExecResultPending(pending: PendingExec): boolean {
  return !pending.bridged
    && !pending.aborted
    && pending.resultField !== ASK_QUESTION_RESULT_FIELD
    && pending.resultField !== SWITCH_MODE_RESULT_FIELD
    && pending.resultField !== CREATE_PLAN_RESULT_FIELD
}

function joinNotes(notes: ReadonlyArray<string | undefined>): string | undefined {
  const present = notes.filter((note): note is string => !!note)
  return present.length > 0 ? present.join("\n\n") : undefined
}

async function loadAvailableModels(): Promise<void> {
  const cacheDir = opencodeGlobalCacheDir()
  try {
    const filePath = cacheFilePath(cacheDir)
    let mtime = 0
    try {
      const stat = await fs.promises.stat(filePath)
      mtime = stat.mtimeMs
    } catch {
      // file missing — fall through with mtime=0
    }
    // Re-read when the file changed (discoverModels background refresh).
    if (mtime !== _availableModelsMtimeMs) {
      const cached = await readCache(cacheDir)
      _availableModels = cached?.models
      _availableModelsMtimeMs = mtime
    }
  } catch { /* ignore */ }
}

function resolveApiBaseURL(options: CreateCursorOptions): string {
  return options.apiBaseURL ?? process.env.CURSOR_API_BASE_URL ?? `https://${CURSOR_API_HOST}`
}

function resolveTelemetryEnabled(options: CreateCursorOptions): boolean {
  return options.telemetryEnabled ?? isTruthyEnv(process.env.CURSOR_GET_SERVER_CONFIG_TELEMETRY)
}

function resolveExplicitAgentBaseURL(options: CreateCursorOptions): string | undefined {
  const raw = options.agentBaseURL ?? options.baseURL
  if (!raw) return undefined
  const normalized = normalizeAgentRunOrigin(raw)
  if (!normalized) {
    throw new CursorProtocolError(
      "Invalid Cursor agent base URL override: expected https://*.cursor.sh",
    )
  }
  return normalized
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value === "true"
}

const streamWriteChains = new WeakMap<BidiStream, Promise<void>>()

async function waitForStreamWrites(stream: BidiStream): Promise<void> {
  const pending = streamWriteChains.get(stream)
  if (pending) await pending.catch(() => undefined)
}

/**
 * Keep awaited protocol writes ordered per Run stream. In particular, a large
 * KV get_blob reply must drain before another KV reply or heartbeat is queued;
 * otherwise one heartbeat observes the backlog created by dozens of ignored
 * false write() results and reports the wrong operation as the failure.
 */
async function writeWithBackpressure(
  stream: BidiStream,
  message: Uint8Array,
  operation: string,
): Promise<void> {
  const previous = streamWriteChains.get(stream)
  const current = (previous ? previous.catch(() => undefined) : Promise.resolve())
    .then(() => writeWithBackpressureNow(stream, message, operation))
  streamWriteChains.set(stream, current)
  try {
    await current
  } finally {
    if (streamWriteChains.get(stream) === current) streamWriteChains.delete(stream)
  }
}

async function writeWithBackpressureNow(
  stream: BidiStream,
  message: Uint8Array,
  operation: string,
): Promise<void> {
  let accepted: boolean | void
  try {
    accepted = stream.write(message)
  } catch (cause) {
    throw toCursorProviderError(cause, {
      replaySafe: false,
      fallback: `Cursor ${operation} write failed`,
    })
  }
  if (accepted !== false) return
  trace(`stream write backpressured: operation=${operation} bytes=${message.length}`)
  if (!stream.waitForDrain) {
    throw new CursorTransportError(`Cursor ${operation} write was backpressured`, {
      transient: false,
      replaySafe: false,
      code: "CURSOR_WRITE_BACKPRESSURE",
    })
  }
  try {
    await stream.waitForDrain(5_000)
    trace(`stream write drained: operation=${operation} bytes=${message.length}`)
  } catch (cause) {
    throw toCursorProviderError(cause, {
      replaySafe: false,
      fallback: `Cursor ${operation} backpressure drain failed`,
    })
  }
}

async function nextFrameWithSemanticDeadline(
  session: CursorSession,
): Promise<IteratorResult<Frame>> {
  const remainingMs = session.semanticDeadlineAt - Date.now()
  if (remainingMs <= 0) {
    throw new CursorTransportError(
      `Cursor semantic-progress timeout after ${session.policy.semanticIdleMs}ms`,
      { transient: true, replaySafe: true, code: "CURSOR_SEMANTIC_IDLE_TIMEOUT" },
    )
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectCancelled: ((error: CursorProviderError) => void) | undefined
  const deadline = new Promise<never>((_, reject) => {
    rejectCancelled = reject
    timer = setTimeout(() => {
      reject(
        new CursorTransportError(
          `Cursor semantic-progress timeout after ${session.policy.semanticIdleMs}ms`,
          { transient: true, replaySafe: true, code: "CURSOR_SEMANTIC_IDLE_TIMEOUT" },
        ),
      )
    }, remainingMs)
    timer.unref?.()
  })
  session.semanticDeadlineCancel = () => {
    rejectCancelled?.(
      session.closeError ?? new CursorTransportError("Cursor semantic wait cancelled locally", {
        transient: false,
        replaySafe: false,
      }),
    )
  }
  try {
    return await Promise.race([takeFrame(session), deadline])
  } finally {
    if (timer) clearTimeout(timer)
    session.semanticDeadlineCancel = null
  }
}

/**
 * Read the held-open stream, emitting stream parts, until the turn boundary:
 *  - a tool call (exec_server_message) → emit tool-call, finish "tool-calls",
 *    and KEEP the session open for the result on the next doStream call;
 *  - turn_ended → finish "stop" and close the session;
 *  - transport EOF before turn_ended → throw for one fresh-Run recovery.
 */
export async function pump(
  session: CursorSession,
  controller: ReadableStreamDefaultController<V3Part>,
  ids: {
    textId: string
    reasoningId: string
  },
  abortSignal?: AbortSignal,
): Promise<void> {
  sessionManager.registerSession(session)
  const cacheDiagnostics = session.cacheDiagnostics ??= {
    sessionKey: session.openCodeSessionId,
    conversationId: session.conversationId,
    priorTokenDetails: session.tokenDetails,
    startedWithCheckpoint: !!session.tokenDetails,
    requestContextReused: false,
    requestContextHash: "unavailable",
    checkpointUpdates: 0,
    tokenDetailUpdates: 0,
    pumpPasses: 0,
    stepStarts: 0,
    stepCompletes: 0,
    displayToolCalls: 0,
    execRequests: 0,
    createPlanInTurn: false,
    switchModeInTurn: false,
  }
  cacheDiagnostics.pumpPasses++
  // Only the first pass of a fresh Run resumed from a stored checkpoint, before
  // anything but control frames (KV, heartbeat, checkpoint) arrived, may be
  // reseeded after Cursor asked for blobs this client does not hold.
  const checkpointRebaseCandidate = session.checkpointRebaseEligible === true
    && cacheDiagnostics.pumpPasses === 1
  let blobMiss = false
  let onlyControlFrames = true
  const finalizeFailure = (failure: CursorProviderError): CursorProviderError => {
    if (checkpointRebaseCandidate && blobMiss && onlyControlFrames && failure.transient) {
      trace(
        `checkpoint unusable: Run failed after missing KV blobs before any output ` +
          `sessionId=${session.sessionId} conversationId=${session.conversationId} err=${failure.message}`,
      )
      failure.replaySafe = true
      failure.checkpointUnusable = true
      return failure
    }
    return replaySafety.applyTo(failure)
  }
  let { textId, reasoningId } = ids
  const advertisedToolNames = advertisedToolNamesFromDescriptors(session.toolDescriptors)
  const advertisedToolNameSet = new Set(
    advertisedToolNames.map((name) => resolveCustomWebToolAlias(name, session.toolAliases)),
  )
  let textStarted = false
  let reasoningStarted = false
  let assistantText = ""
  let textSeparator = ""
  let progressContinuationAttempts = 0
  let emittedHostTools = 0
  // The current model step's tool calls: Cursor's listed count, the call ids that
  // reached us (exec request or display completion), and those sent to the host.
  let toolStep = { listed: undefined as number | undefined, resolved: new Set<string>(), hostCalls: 0 }
  const toolStepComplete = () => toolStep.listed !== undefined && toolStep.resolved.size >= toolStep.listed
  /** Count a host tool call; true when it must end the AI SDK step now. */
  const endsToolStep = (): boolean => {
    toolStep.hostCalls++
    return !cursorListsToolRequests || toolStepComplete()
  }
  /** End a held step; `requeue` is a frame read that belongs to the next pump pass. */
  const closeHeldToolStep = (reason: string, requeue?: Promise<IteratorResult<Frame>>): void => {
    if (requeue) {
      requeue.catch(() => {})
      session.queuedFrame = requeue
    }
    trace(
      `exec: tool step closed (${reason}) hostCalls=${toolStep.hostCalls} ` +
        `listed=${toolStep.listed ?? "-"} resolved=${toolStep.resolved.size}`,
    )
    emitFinish(undefined, { unified: "tool-calls", raw: undefined })
  }
  const replaySafety = new AttemptReplaySafety(session.sessionId)
  const failRunProtocol = (message: string, code: string): never => {
    replaySafety.markBarrier("unknown-or-malformed-frame")
    const error = new CursorProtocolError(message, { code })
    sessionManager.close(session, "remote-error", error)
    throw error
  }
  const rethrowTransportWriteFailure = (error: unknown): void => {
    if (error instanceof CursorProviderError && error.origin !== "protocol") throw error
  }
  const writeExecFrames = async (
    frames: Uint8Array[],
    operation: string,
  ): Promise<boolean> => {
    try {
      for (const frame of frames) {
        await writeWithBackpressure(session.stream, frame, operation)
      }
      return true
    } catch (error) {
      rethrowTransportWriteFailure(error)
      const wrapped = new Error(
        `Failed to ${operation}: ${(error as Error).message}`,
      )
      trace(`exec: reply FAILED ${wrapped.message}`)
      safeError(wrapped)
      sessionManager.close(session)
      return false
    }
  }
  // OpenCode cancels the ReadableStream between turns (see the cancel handler
  // in doStreamImpl). The frames iterator can still yield a final `done` after
  // the cancel lands — controller.enqueue on a cancelled controller throws.
  // safeEnqueue swallows that throw and tracks the close so we stop pumping.
  let streamClosed = false
  const safeEnqueue = (part: V3Part): boolean => {
    if (streamClosed) return false
    try {
      controller.enqueue(part)
      if (session.openCodeSessionId) {
        recordEmittedPart(
          session.openCodeSessionId,
          session.conversationId,
          part as { type: string; delta?: unknown; toolCallId?: unknown },
        )
      }
      return true
    } catch (e) {
      streamClosed = true
      trace(`pump: enqueue on closed controller (suppressing) err=${(e as Error).message}`)
      return false
    }
  }
  const safeError = (err: Error): void => {
    if (streamClosed) return
    try {
      controller.error(err)
    } catch (e) {
      trace(`pump: controller.error failed (suppressing) err=${(e as Error).message}`)
    }
    streamClosed = true
  }

  /** Reply on Cursor's correlated exec channel without exposing a host tool call. */
  const rejectExec = async (
    parsed: ParsedExecRequest,
    reason: string,
    label: string,
  ): Promise<boolean> => {
    const groundedReason = appendWorkspaceRootGrounding(
      reason,
      workspaceRootFromRequestContext(session.requestContext),
    )
    const ok = await writeExecFrames(
      buildExecClientMessages({
        execId: parsed.id,
        resultField: parsed.resultField,
        output: "",
        error: groundedReason,
        toolName: parsed.toolName,
        resultMetadata: parsed.resultMetadata,
        workspaceRoot: workspaceRootFromRequestContext(session.requestContext),
      }),
      `reject ${label} id=${parsed.id}`,
    )
    if (ok) trace(`exec: REFUSED ${label} toolName=${parsed.toolName} id=${parsed.id}`)
    return ok
  }

  /**
   * Cursor's streamed edit handshake needs the complete target before it sends
   * the replacement through write_args. OpenCode's ordinary read tool caps at
   * 50 KB, so forwarding this private prerequisite read teaches Cursor's editor
   * that a large file ends at the cap and produces a destructive replacement.
   *
   * Answer a correlated workspace-file read directly up to Cursor's own 50 MB
   * edit limit. Missing targets remain empty-file successes so creation can
   * continue. External and otherwise ineligible reads retain OpenCode's normal
   * permission-aware path.
   */
  const recoverCorrelatedEditRead = (
    parsed: ParsedExecRequest,
    displayCallId: string | undefined,
  ): boolean => {
    if (
      !displayCallId ||
      parsed.resultField !== "read_result" ||
      parsed.toolName !== "read" ||
      // `apply_patch` is the substitute this host offers when it withholds
      // `write` — the follow-up write_args is remapped onto it either way.
      !(advertisedToolNameSet.has("write") || advertisedToolNameSet.has("apply_patch"))
    ) return false

    const stored = session.displayToolCalls.get(displayCallId)
    const display = parseDisplayToolCall(displayCallId, stored)
    if (display?.variant !== "edit_tool_call" || display.bridgeable === false) return false

    const requestedPath = opencodePathArg(parsed.args) ?? ""
    const editPath = typeof display.args.path === "string" ? display.args.path : ""
    if (!requestedPath || !editPath) return false

    // Prefer env.workspace_paths — project_folder / workspace_project_dir are
    // Cursor metadata roots under <host-cache>/projects/, not the git tree.
    const workspaceRoot = workspaceRootFromRequestContext(session.requestContext)
    const resolvePath = (value: string) => path.resolve(workspaceRoot, value)
    const absolutePath = resolvePath(requestedPath)
    if (absolutePath !== resolvePath(editPath)) return false

    let exists = true
    try {
      fs.lstatSync(absolutePath)
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined
      if (code !== "ENOENT") return false
      exists = false
    }

    if (exists) {
      // Do not bypass OpenCode's external-directory permission boundary, even
      // through a symlink rooted in the workspace.
      try {
        const realRoot = fs.realpathSync(workspaceRoot)
        const realTarget = fs.realpathSync(absolutePath)
        const relative = path.relative(realRoot, realTarget)
        if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          parsed.resultMetadata = {
            ...parsed.resultMetadata,
            correlatedEditCallId: displayCallId,
          }
          return false
        }

        const frames = buildCompleteEditReadMessages(parsed.id, absolutePath, requestedPath)
        if (!frames) return false
        for (const frame of frames) session.stream.write(frame)
        const editCall = session.editToolCalls?.get(displayCallId)
        if (editCall) editCall.completeRead = true
        trace(
          `exec: correlated edit read completed directly id=${parsed.id} ` +
            `path=${JSON.stringify(requestedPath)}; awaiting write_args`,
        )
        return true
      } catch {
        parsed.resultMetadata = {
          ...parsed.resultMetadata,
          correlatedEditCallId: displayCallId,
        }
        return false
      }
    }

    try {
      for (const frame of buildExecClientMessages({
        execId: parsed.id,
        resultField: parsed.resultField,
        output: "",
        toolName: parsed.toolName,
        resultMetadata: { path: requestedPath },
        workspaceRoot,
      })) {
        session.stream.write(frame)
      }
      trace(
        `exec: missing edit target treated as empty file id=${parsed.id} ` +
          `path=${JSON.stringify(requestedPath)}; awaiting write_args`,
      )
      return true
    } catch (e) {
      const error = new Error(
        `Failed to recover Cursor edit read: ${(e as Error).message}`,
      )
      trace(`exec: edit read recovery FAILED ${error.message}`)
      safeError(error)
      sessionManager.close(session)
      return true
    }
  }

  /**
   * A read of a path that does not exist would otherwise reach OpenCode as a
   * real tool call and raise a permission prompt for a file the user never had.
   * Cursor's own LocalReadExecutor instead resolves the target against the
   * workspace, stats it, and returns a typed ReadResult (file_not_found /
   * invalid_file) before execution. Mirror that here: reply on the held-open
   * exec channel with the exact typed case so the model receives a structured
   * observation and the host surfaces no prompt.
   *
   * Read-only by construction — write/edit targets are never checked, so
   * legitimate file creation (path resolves, file absent) is never denied. Runs
   * after recoverCorrelatedEditRead, which has already converted the edit
   * handshake read into an empty-file success. EACCES/EPERM and other stat
   * errors fall through to OpenCode so a genuine permission decision stands.
   */
  /**
   * Backgrounded shells write Cursor terminal files under the advertised
   * `terminals_folder`, outside the workspace. Through OpenCode's read tool,
   * every AwaitShell poll of one would ask for external-directory permission.
   * An agent without a shell this turn has no terminals, and reads them through OpenCode.
   */
  const serveTerminalFileRead = async (parsed: ParsedExecRequest): Promise<"served" | "failed" | undefined> => {
    if (parsed.toolName !== "read" || parsed.resultField !== "read_result") return undefined
    const hasShell = (names: ReadonlySet<string>) => names.has("bash") || names.has("shell")
    if (!hasShell(advertisedToolNameSet)) return undefined
    // The advertised catalog can keep tools the host filtered this turn.
    const permitted = session.permittedToolNames
    if (permitted && permitted.size > 0 && !hasShell(permitted)) return undefined
    const terminals = terminalsFolderFromRequestContext(session.requestContext)
    const requested = opencodePathArg(parsed.args) ?? ""
    if (!terminals || !requested || isUriReadTarget(requested)) return undefined
    const absolutePath = resolveReadTargetPath(requested, workspaceRootFromRequestContext(session.requestContext))
    if (path.dirname(absolutePath) !== terminals || !/^\d+\.txt$/.test(path.basename(absolutePath))) return undefined
    const frames = await buildTerminalFileReadMessages(parsed.id, absolutePath, absolutePath, {
      offset: typeof parsed.args.offset === "number" ? parsed.args.offset : undefined,
      limit: typeof parsed.args.limit === "number" ? parsed.args.limit : undefined,
    })
    if (!frames) return undefined
    if (!await writeExecFrames(frames, "answer a Cursor terminal file read")) return "failed"
    trace(`exec: served terminal file read id=${parsed.id} path=${JSON.stringify(absolutePath)}`)
    return "served"
  }

  const rejectMissingReadTarget = (parsed: ParsedExecRequest): boolean => {
    if (parsed.toolName !== "read") return false
    const requested = opencodePathArg(parsed.args) ?? ""
    if (!requested) return false
    // A scheme-addressed target is the advertised host executor's to resolve,
    // not a local file to stat. Rejecting it here would make any URI-backed
    // capability permanently unreachable through this provider.
    if (isUriReadTarget(requested)) {
      trace(`exec: forwarding URI read target id=${parsed.id} target=${JSON.stringify(requested)}`)
      return false
    }
    const workspaceRoot = workspaceRootFromRequestContext(session.requestContext)
    const absolutePath = resolveReadTargetPath(requested, workspaceRoot)
    const readResult = classifyMissingReadTarget(absolutePath)
    if (!readResult) return false
    try {
      for (const frame of buildReadRejectionMessages(parsed.id, readResult)) {
        session.stream.write(frame)
      }
      const kind = Object.keys(readResult)[0]
      trace(
        `exec: rejected missing read target id=${parsed.id} kind=${kind} ` +
          `path=${JSON.stringify(absolutePath)}`,
      )
      return true
    } catch (e) {
      const error = new Error(
        `Failed to reject Cursor read of a missing path: ${(e as Error).message}`,
      )
      trace(`exec: missing read rejection FAILED ${error.message}`)
      safeError(error)
      sessionManager.close(session)
      return true
    }
  }

  /** AI SDK V3 requires text-end / reasoning-end before finish or tool-call. */
  const closeOpenSpans = () => {
    for (const part of spanEndParts({ textStarted, reasoningStarted, textId, reasoningId })) {
      safeEnqueue(part as V3Part)
    }
    reasoningStarted = false
    textStarted = false
  }

  const emitText = (delta: string) => {
    if (!delta) return
    const text = textSeparator + delta
    textSeparator = ""
    assistantText += text
    replaySafety.markBarrier("visible-text")
    // Close reasoning before text (hosts expect reasoning-end before text-start).
    if (reasoningStarted && !textStarted) {
      safeEnqueue({ type: "reasoning-end", id: reasoningId } as V3Part)
      reasoningStarted = false
    }
    if (!textStarted) {
      safeEnqueue({ type: "text-start", id: textId } as V3Part)
      textStarted = true
    }
    session.usageEstimate.outputTokens += estimateTokens(text.length)
    safeEnqueue({ type: "text-delta", id: textId, delta: text } as V3Part)
  }
  const emitReasoning = (text: string) => {
    if (!text) return
    replaySafety.markBarrier("visible-reasoning")
    if (!reasoningStarted) {
      safeEnqueue({ type: "reasoning-start", id: reasoningId } as V3Part)
      reasoningStarted = true
    }
    session.usageEstimate.outputTokens += estimateTokens(text.length)
    safeEnqueue({ type: "reasoning-delta", id: reasoningId, delta: text } as V3Part)
  }
  const emitFinish = (
    te: Record<string, unknown> | undefined,
    reason: LanguageModelV3FinishReason,
    settledUsage?: LanguageModelV3Usage,
    settledSource?: string,
  ) => {
    closeOpenSpans()
    const est = session.usageEstimate
    // OpenCode TUI/GUI replace each assistant message's tokens (they do not
    // sum occupancy) and the TUI footer requires tokens.output > 0. Cost is
    // added per step-finish. Emit checkpoint occupancy snapshots at tool-call
    // boundaries with a $0 Copilot cost override, then one more occupancy
    // snapshot at TurnEnded/stop. Held-Run TurnEnded counters are cumulative
    // across every tool step, but this finish only spans the last generation
    // slice — putting output_tokens/reasoning there makes host tok/s
    // (generated/stepElapsed) absurd. Keep exact request counters under
    // providerMetadata.cursor.*Raw. Char/4 usageEstimate stays traces-only.
    const tokenDetails = session.tokenDetails
    const occupancyDetails =
      tokenDetails && tokenDetails.usedTokens > 0 ? tokenDetails : undefined
    const contextSource: CursorContextUsageSource | undefined = tokenDetails
      ? session.tokenDetailsFresh
        ? "checkpoint-current-run"
        : "checkpoint-previous-turn"
      : undefined
    const usage = settledUsage ?? (
      occupancyDetails
        ? occupancyUsageFromTokenDetails(
            occupancyDetails,
            session.cacheDiagnostics?.priorTokenDetails,
          )
        : emptyLanguageModelV3Usage()
    )
    const counters = te ? cursorUsageCountersFromTurnEnded(te) : undefined
    // TurnEnded stays a real (non-occupancyOnly) finish so hosts that collapse
    // tool-boundary occupancy still keep one context snapshot for the sidebar.
    // Copilot $0 avoids billing the occupancy-shaped counters as a new prompt.
    const providerMetadata = te
      ? {
          ...OPENCODE_DISPLAY_ONLY_COST_METADATA,
          ...cursorTurnEndedProviderMetadata(te, tokenDetails, contextSource),
        }
      : {
          ...OPENCODE_DISPLAY_ONLY_COST_METADATA,
          cursor: {
            usageVersion: 3,
            occupancyOnly: true,
            ...(occupancyDetails && contextSource
              ? { context: cursorContextUsageMetadata(occupancyDetails, contextSource) }
              : {}),
          },
        }
    const reasonLabel = typeof reason === "object" && reason && "unified" in reason
      ? String((reason as { unified?: string }).unified ?? "unknown")
      : String(reason)
    const inTotal = usage.inputTokens?.total ?? 0
    const outTotal = usage.outputTokens?.total ?? 0
    const occupancySource = occupancyDetails
      ? `occupancy-${contextSource ?? "unavailable"}`
      : "intermediate-zero"
    // Occupancy finishes never see Cursor TurnEnded cache_read. usageEstimate.cacheRead
    // stays 0 for the whole Run, so logging it as rawCacheRead falsely reports 0% on
    // every tool-call step. Prefer the V3 occupancy partition (prior prefix → cacheRead)
    // and label the estimate separately from billed TurnEnded counters.
    const occupancyPrefixCache = occupancyDetails
      ? (session.cacheDiagnostics?.priorTokenDetails?.usedTokens ?? 0)
      : undefined
    const rawIn = te
      ? turnEndedCounter(te, "input_tokens")
      : occupancyDetails
        ? occupancyDetails.usedTokens
        : est.inputTokens
    const rawOut = te
      ? turnEndedCounter(te, "output_tokens")
      : occupancyDetails
        ? 1
        : est.outputTokens
    const rawCacheRead = te
      ? turnEndedCounter(te, "cache_read")
      : occupancyPrefixCache ?? est.cacheRead
    const rawCacheWrite = te ? turnEndedCounter(te, "cache_write") : est.cacheWrite
    trace(
      `finish: reason=${reasonLabel} ` +
        `v3In=${inTotal} v3Out=${outTotal} ` +
        `v3CacheRead=${usage.inputTokens?.cacheRead ?? 0} v3CacheWrite=${usage.inputTokens?.cacheWrite ?? 0} ` +
        `v3Reasoning=${usage.outputTokens?.reasoning ?? 0} ` +
        `rawIn=${rawIn} rawOut=${rawOut} rawCacheRead=${rawCacheRead} rawCacheWrite=${rawCacheWrite} ` +
        `${occupancyPrefixCache !== undefined ? `occupancyPrefixCache=${occupancyPrefixCache} ` : ""}` +
        `source=${te
          ? settledSource ?? (contextSource ?? "unavailable")
          : occupancySource}`,
    )
    // Validate the usage we actually send. Occupancy finishes (tool-call and
    // TurnEnded/stop) use prior-prefix cacheRead — never compare that against
    // aggregate TurnEnded request cache ratios (false mismatch). Raw request
    // counters stay on `finish:` and cache diagnosis only.
    if (occupancyDetails) {
      trace(formatTurnUsageValidation(
        occupancyValidationCounters(
          occupancyDetails,
          session.cacheDiagnostics?.priorTokenDetails,
        ),
        usage,
        occupancyDetails,
        contextSource,
      ))
    } else if (counters) {
      trace(formatTurnUsageValidation(counters, usage, tokenDetails, contextSource))
    }
    if (counters) {
      trace(formatCursorCacheDiagnostics(
        counters,
        tokenDetails,
        cacheDiagnostics.priorTokenDetails,
        cacheDiagnostics,
      ))
    }
    safeEnqueue({
      type: "finish",
      usage,
      finishReason: reason,
      ...(providerMetadata ? { providerMetadata } : {}),
    } as V3Part)
  }

  // The cancel path drains and closes the Run; a frame read here goes back to it.
  const stopForHostInterrupt = (read?: IteratorResult<Frame>): never => {
    if (read) session.queuedFrame = Promise.resolve(read)
    closeOpenSpans()
    trace(`pump: host interrupted the turn sessionId=${session.sessionId} — leaving the cancelled Run to its drain`)
    throw new CursorLocalCancellationError("Cursor Run cancelled: the host stopped the turn")
  }

  while (true) {
    if (session.hostInterrupted) stopForHostInterrupt()
    // Consumer cancelled / closed the ReadableStream. Stop reading Cursor
    // frames so a continuation doStream can resume the same iterator —
    // keeping the loop alive would discard frames the next pump needs.
    if (streamClosed) {
      trace(`pump: stream closed (consumer cancelled) pending=${session.pending.size}`)
      sessionManager.closeUnlessPending(session)
      return
    }
    if (abortSignal?.aborted) {
      // Stop feeding this ReadableStream, but keep the Run session if we still
      // owe Cursor an exec result (OpenCode aborts between tool-call turns).
      trace(`pump: abortSignal aborted pending=${session.pending.size}`)
      sessionManager.closeUnlessPending(session)
      return
    }

    if (toolStepComplete()) {
      if (toolStep.hostCalls > 0) {
        closeHeldToolStep("all listed calls received")
        return
      }
      // A step whose calls Cursor answered itself; the next calls belong to a new step.
      toolStep = { listed: undefined, resolved: new Set(), hostCalls: 0 }
    }

    let next: IteratorResult<Frame>
    try {
      if (toolStep.hostCalls > 0) {
        const held = await nextFrameWithin(session, HELD_TOOL_STEP_QUIET_MS)
        if (!held) {
          closeHeldToolStep(`quiet ${HELD_TOOL_STEP_QUIET_MS}ms`)
          return
        }
        next = held
      } else {
        next = session.pending.size === 0
          ? await nextFrameWithSemanticDeadline(session)
          : await takeFrame(session)
      }
    } catch (error) {
      if (toolStep.hostCalls > 0) {
        // Surface the failure on the next pass, after the step's calls ran, as before.
        closeHeldToolStep("frame read failed", Promise.reject(error))
        return
      }
      closeOpenSpans()
      const failure = error instanceof CursorProviderError
        ? error
        : new CursorRunInterruptedError(
            `Cursor Run frame stream interrupted: ${(error as Error).message}`,
            { cause: error },
          )
      throw finalizeFailure(failure)
    }
    if (session.hostInterrupted) stopForHostInterrupt(next)
    if (toolStep.hostCalls > 0 && (next.done || next.value.flags & 0x02)) {
      closeHeldToolStep("Run ended", Promise.resolve(next))
      return
    }
    if (next.done) {
      closeOpenSpans()
      trace("pump: frames iterator ended before turn_ended")
      const failure = new CursorRunInterruptedError()
      throw finalizeFailure(failure)
    }
    const frame = next.value as Frame

    if (frame.flags & 0x02) {
      // A successful agent turn has an explicit turn_ended update before the
      // Connect envelope closes. Reaching end-stream here means the Run was
      // interrupted, even if the HTTP status itself was 200.
      let payload = ""
      if (frame.payload.length > 0) {
        try {
          payload = new TextDecoder().decode(decodeFramePayload(frame))
        } catch {
          replaySafety.markBarrier("unknown-or-malformed-frame")
        }
      }
      closeOpenSpans()
      const failure = payload
        ? connectFrameError(payload)
        : new CursorRunInterruptedError()
      throw finalizeFailure(failure)
    }

    // decodeFramePayload can throw on a corrupt gzip payload (gunzipSync).
    // Skip the frame rather than abort the whole turn.
    let payload: Uint8Array
    try {
      payload = decodeFramePayload(frame)
    } catch (e) {
      replaySafety.markBarrier("unknown-or-malformed-frame")
      onlyControlFrames = false
      trace(`gunzip FAILED (skipping frame): flags=0x${frame.flags.toString(16)} len=${frame.payload.length} err=${(e as Error).message}`)
      continue
    }
    let asm: Record<string, unknown>
    try {
      asm = decodeMessage<Record<string, unknown>>("AgentServerMessage", payload)
    } catch {
      // A single malformed/truncated frame must not abort the whole turn
      // (protobufjs throws "index out of range: …" on length overruns). Log it
      // and keep pumping.
      replaySafety.markBarrier("unknown-or-malformed-frame")
      onlyControlFrames = false
      const channel = responseRequiredChannel(payload)
      if (channel) {
        failRunProtocol(`Cursor ${channel} request could not be decoded`, RUN_REQUEST_DECODE_FAILED)
      }
      trace(`decode FAILED (skipping non-request frame): flags=0x${frame.flags.toString(16)} len=${payload.length}`)
      continue
    }
    const iu = asm.interaction_update as Record<string, unknown> | undefined
    // Output after a step's tool calls belongs to the next step.
    if (toolStep.hostCalls > 0 && (iu?.text_delta || iu?.thinking_delta || iu?.turn_ended)) {
      closeHeldToolStep("model output", Promise.resolve(next))
      return
    }
    const esm = asm.exec_server_message as Record<string, unknown> | undefined
    const kv = asm.kv_server_message as Record<string, unknown> | undefined
    const execControl = asm.exec_server_control_message as Record<string, unknown> | undefined
    const interactionQuery = asm.interaction_query as Record<string, unknown> | undefined
    const checkpointRaw = asm.conversation_checkpoint_update
    const topField = payload.length > 0 ? payload[0] >> 3 : 0
    const checkpointProgress = normalizeCheckpointBytes(checkpointRaw)
    const requiredChannel = responseRequiredChannel(payload)
    if (
      requiredChannel === "multiple" ||
      (requiredChannel === "exec" && !esm) ||
      (requiredChannel === "kv" && !kv) ||
      (requiredChannel === "interaction" && !interactionQuery)
    ) {
      failRunProtocol("Cursor response-requiring request could not be decoded", RUN_REQUEST_DECODE_FAILED)
    }
    const replayFrame = analyzeReplayFrame(payload, {
      interactionUpdate: iu,
      exec: esm,
      kv,
      execControl,
      interactionQuery,
      checkpointBytes: checkpointProgress,
    })
    if (replayFrame.semanticProgress) {
      sessionManager.recordSemanticProgress(session)
    }
    if (replayFrame.barrier) replaySafety.markBarrier(replayFrame.barrier)
    // Reseeding is allowed only while every frame so far was positively a
    // control frame. Anything else, including unknown top-level fields, may have
    // carried output or stateful activity.
    if (!isSoleControlFrame(payload)) onlyControlFrames = false

    {
      const iuKind = iu ? Object.keys(iu).find((k) => iu[k]) : undefined
      trace(
        `pump frame: topField=${topField} interaction_update=${iuKind ?? "-"} ` +
          `exec=${esm ? "yes" : "no"} kv=${kv ? "yes" : "no"} ` +
          `interaction_query=${interactionQuery ? "yes" : "no"} ` +
          `checkpoint=${checkpointRaw ? "yes" : "no"}`,
      )
    }

    try {
    // CLI: conversationCheckpointUpdate → replace agentStore conversation state.
    // Store opaque bytes keyed by conversation_id; next Run echoes them.
    if (checkpointRaw != null) {
      const bytes = normalizeCheckpointBytes(checkpointRaw)
      if (bytes && bytes.length > 0) {
        cacheDiagnostics.checkpointUpdates++
        setCheckpoint(session.conversationId, bytes)
        session.resumeCheckpoint = Uint8Array.from(bytes)
        session.pendingFollowUp = undefined
        const results = session.resultsAfterCheckpoint
        if (results && !results.unconfirmed && results.awaiting.size === 0) session.resultsAfterCheckpoint = undefined
        // Cursor answers an injection before checkpointing past it; one read earlier may predate it.
        for (const injection of session.steerInjections ?? []) {
          if (injection.state !== "sent") injection.checkpointed = true
        }
        const tokenDetails = decodeConversationTokenDetails(bytes)
        if (tokenDetails) {
          cacheDiagnostics.tokenDetailUpdates++
          session.tokenDetails = tokenDetails
          session.tokenDetailsFresh = true
        }
        const context = tokenDetails
          ? ` context=${tokenDetails.usedTokens}/${tokenDetails.maxTokens} ` +
            `categories=${formatCursorTokenCategories(tokenDetails)}`
          : " context=unavailable"
        trace(
          `checkpoint: stored ${bytes.length}B for conversationId=${session.conversationId}${context}`,
        )
      }
    }

    if (iu?.text_delta) {
      emitText(((iu.text_delta as Record<string, unknown>).text as string) ?? "")
    } else if (iu?.thinking_delta) {
      emitReasoning(((iu.thinking_delta as Record<string, unknown>).text as string) ?? "")
    } else if (iu?.turn_ended) {
      trace(`turn_ended raw wire fields: ${debugWalkTurnEnded(payload)}`)
      if (session.deferredNote !== undefined) {
        trace(`continuation: turn ended before an exec result could carry the host note noteLen=${session.deferredNote.length}`)
      }
      const turnEnded = iu.turn_ended as Record<string, unknown>
      const undelivered = (session.steerInjections ?? []).filter((injection) => injection.state !== "delivered")
      // A checkpoint from before the step's results (or from an earlier Run) would drop the step
      // from any turn that resumed it, so it is neither kept nor saved.
      const checkpointPredatesStep = !!session.resultsAfterCheckpoint || (
        undelivered.length > 0
        && (!session.resumeCheckpoint?.length || undelivered.some((injection) => !injection.checkpointed))
      )
      if (checkpointPredatesStep) {
        trace(`checkpoint: dropped for conversationId=${session.conversationId} — it predates this step's results`)
        clearCheckpoint(session.conversationId)
        session.resumeCheckpoint = undefined
      }
      if (session.openCodeSessionId) {
        await persistConversationState(
          session.cacheDir ?? opencodeGlobalCacheDir(),
          {
            sessionKey: session.openCodeSessionId,
            conversationId: session.conversationId,
            requestContext: session.requestContext,
            toolCatalog: session.toolCatalog ?? [],
            postCompactionRebase: session.postCompactionRebase,
            hostAgent: session.hostAgent,
            systemPromptHash: session.stableSystemPromptHash,
          },
        ).catch((error) => {
          trace(
            `conversation persistence: TurnEnded save failed ` +
              `sessionKey=${session.openCodeSessionId}: ${String(error)}`,
          )
        })
      }
      const checkpoint = session.resumeCheckpoint ?? getCheckpoint(session.conversationId)
      session.steerInjections = undefined
      session.pendingFollowUp = undefined
      if (undelivered.length > 0) {
        trace(
          `steer: ${undelivered.length} injection(s) not delivered before turn_ended ` +
            `states=${undelivered.map((i) => i.state).join(",")}`,
        )
        if (typeof session.reopenWithUserMessage !== "function" || checkpointPredatesStep) {
          throw new CursorProtocolError(
            "Cursor did not take a message sent during this turn, and there is no checkpoint to send it as a follow-up",
          )
        }
        // Cursor CLI resends an injection the Run did not take as a follow-up
        // message. If opening it fails, Run recovery resends it.
        const followUp = undelivered.map((i) => i.text).join("\n\n")
        session.pendingFollowUp = followUp
        // The follow-up Run starts with its own reasoning, which must not open inside this Run's text.
        closeOpenSpans()
        textId = crypto.randomUUID()
        reasoningId = crypto.randomUUID()
        await session.reopenWithUserMessage(followUp, abortSignal)
        trace("steer: sent undelivered message(s) as a follow-up Run")
        assistantText = ""
        continue
      }
      if (
        typeof session.reopenWithUserMessage === "function"
        && checkpoint
        && checkpoint.length > 0
        && !session.resultsAfterCheckpoint
        && shouldContinueProgressOnlyTurn({
             allowTools: session.allowTools,
             advertisedToolCount: advertisedToolNames.length,
             assistantText,
             emittedHostTools,
             continuationAttempts: progressContinuationAttempts,
             pendingExecs: session.pending.size,
           })
      ) {
        progressContinuationAttempts += 1
        trace("progress-only: continuing attempt=1")
        try {
          await session.reopenWithUserMessage(
            progressOnlyContinuationPrompt(
              workspaceRootFromRequestContext(session.requestContext),
            ),
          )
          assistantText = ""
          continue
        } catch (error) {
          // Cursor already completed this turn. A failed nudge must not discard
          // the valid turn_ended the user already received as assistant text.
          trace(`progress-only: continuation failed, finishing original turn: ${(error as Error).message}`)
        }
      }
      emitFinish(
        turnEnded,
        { unified: "stop", raw: undefined },
      )
      sessionManager.close(session)
      return
    } else if (iu?.context_injection_state) {
      const update = iu.context_injection_state as Record<string, unknown>
      const stateVariants = (update.state ?? {}) as Record<string, unknown>
      const state = Object.keys(stateVariants).find((key) => stateVariants[key])
      const reason = (stateVariants.rejected as Record<string, unknown> | undefined)?.reason
      trace(
        `steer: injection id=${String(update.injection_id)} state=${state ?? "-"}` +
          (typeof reason === "string" && reason ? ` reason=${JSON.stringify(reason)}` : ""),
      )
      const injection = session.steerInjections?.find((i) => i.id === update.injection_id)
      if (injection && state && injection.state !== "delivered") injection.state = state as SteerInjection["state"]
    } else if (iu?.user_message_appended) {
      trace("steer: Cursor appended a user message to the Run")
    } else if (iu?.tool_call_started) {
      cacheDiagnostics.displayToolCalls++
      // Stash Cursor display ToolCall until exec claims it, or completed bridges it.
      const started = iu.tool_call_started as Record<string, unknown>
      const callId = typeof started.call_id === "string" ? started.call_id : ""
      const toolCall = started.tool_call as Record<string, unknown> | undefined
      if (callId && toolCall) {
        session.displayToolCalls.set(callId, toolCall)
        const variant = Object.keys(toolCall).find((k) => k.endsWith("_tool_call")) ?? "?"
        const display = parseDisplayToolCall(callId, toolCall)
        const editPath = display?.variant === "edit_tool_call"
          && typeof display.args.path === "string"
          ? display.args.path
          : undefined
        if (editPath) {
          const editToolCalls = session.editToolCalls ?? (session.editToolCalls = new Map())
          editToolCalls.set(callId, { path: editPath })
        }
        const callIdLog = callId.replace(/\r?\n/g, "\\n")
        let wireFields = ""
        if (variant === "?") {
          const toolBytes = extractProtobufSubmessage(payload, [1, 2, 2])
          if (toolBytes) {
            wireFields = ` wireFields=[${listProtobufFieldNumbers(toolBytes).join(",")}]`
          }
        }
        trace(`display tool_call_started: callId=${callIdLog} variant=${variant}${wireFields}`)
      }
    } else if (iu?.tool_requests_listed) {
      cursorListsToolRequests = true
      const listed = iu.tool_requests_listed as Record<string, unknown>
      toolStep.listed = Number(listed.call_count ?? 0)
      trace(
        `tool_requests_listed: count=${toolStep.listed} resolved=${toolStep.resolved.size} ` +
          `hostCalls=${toolStep.hostCalls}`,
      )
    } else if (iu?.tool_call_completed) {
      const completed = iu.tool_call_completed as Record<string, unknown>
      const callId = typeof completed.call_id === "string" ? completed.call_id : ""
      // Only a call no exec has claimed completes here; Cursor also closes the
      // calls of the previous step once their results arrive.
      if (callId && session.displayToolCalls.has(callId)) toolStep.resolved.add(callId)
      if (callId) session.editToolCalls?.delete(callId)
      if (callId) session.resultsAfterCheckpoint?.awaiting.delete(callId)
      // If exec already claimed this call_id, display map entry is gone — skip.
      if (!callId || !session.displayToolCalls.has(callId)) {
        if (callId) {
          trace(`display tool_call_completed: ignore (exec-handled or unknown) callId=${callId}`)
        }
      } else {
        const stored = session.displayToolCalls.get(callId)!
        session.displayToolCalls.delete(callId)
        const toolCall =
          (completed.tool_call as Record<string, unknown> | undefined) ?? stored
        if (!session.allowTools) {
          trace(`display tool_call_completed: SKIPPED (allowTools=false) callId=${callId}`)
        } else {
          const display = parseDisplayToolCall(callId, toolCall, session.mirroredTodos)
          const advertised = advertisedToolNamesFromDescriptors(session.toolDescriptors)
          const bridged = display
            ? resolveBridgedOpenCodeToolCall(display, advertised, session.hostToolDialect)
            : undefined
          if (!display) {
            const callIdLog = callId.replace(/\r?\n/g, "\\n")
            // AgentServerMessage.interaction_update(1).tool_call_completed(3).tool_call(2)
            const toolBytes = extractProtobufSubmessage(payload, [1, 3, 2])
            const wire = toolBytes
              ? ` wireFields=[${listProtobufFieldNumbers(toolBytes).join(",")}]`
              : ""
            trace(
              `display tool_call_completed: unparsed callId=${callIdLog} ` +
                `keys=[${Object.keys(toolCall).join(",")}]${wire}`,
            )
          } else if (!bridged) {
            // GetMcpTools / GetDynamicTools is executed by Cursor after mcp_state;
            // large catalogs then spill through write_args. Not a missing host tool.
            if (isNativeDisplayToolCall(display.variant)) {
              trace(
                `display tool_call_completed: native ${display.preferredToolName} callId=${callId} ` +
                  `(server-side catalog; spill uses write_args)`,
              )
            } else {
              trace(
                `display tool_call_completed: no advertised OpenCode tool ` +
                  `callId=${callId} variant=${display.variant} preferred=${display.preferredToolName} ` +
                  `advertised=[${advertised.join(",")}]`,
              )
            }
          } else {
            // Snapshot only Cursor todo writes (not create_plan's synthetic
            // "plan" prepend) so later merge patches apply onto a real list.
            if (bridged.toolName === "todowrite" && bridged.variant === "update_todos_tool_call") {
              const snapshot = snapshotMirroredTodos(bridged.args.todos)
              if (snapshot !== undefined) storeMirroredTodos(session, snapshot)
            }
            const execId = session.nextBridgedExecId++
            sessionManager.registerPending(
              execId,
              session,
              "bridged",
              bridged.toolName,
              true,
            )
            const toolCallId = `cursor_${session.sessionId}_${execId}`
            const input = JSON.stringify(bridged.args ?? {})
            trace(
              `display BRIDGED tool-call toolCallId=${toolCallId} toolName=${bridged.toolName} ` +
                `variant=${bridged.variant} callId=${callId} inputLen=${input.length}`,
            )
            emittedHostTools++
            closeOpenSpans()
            safeEnqueue({
              type: "tool-call",
              toolCallId,
              toolName: bridged.toolName,
              input,
            } as V3Part)
            if (endsToolStep()) {
              emitFinish(undefined, { unified: "tool-calls", raw: undefined })
              return
            }
            continue
          }
        }
      }
    } else if (iu?.step_started) {
      cacheDiagnostics.stepStarts++
    } else if (iu?.step_completed) {
      cacheDiagnostics.stepCompletes++
    } else if (esm) {
      cacheDiagnostics.execRequests++
      const esmId = (esm.id as number) ?? 0
      if (esm.request_context_args) {
        // Server turn-setup probe (#10). Reply with the same RequestContext the Run sent.
        {
          const rc = session.requestContext
          const hooks =
            typeof rc.hooks_additional_context === "string" ? rc.hooks_additional_context : ""
          trace(
            `exec request_context: id=${esmId} — replying context ` +
              `tools=${session.toolDescriptors.length} ` +
              `hooks=${hooks ? hooks.split("\n").length : 0}`,
          )
          if (hooks) trace(`exec request_context hooks_additional_context: ${hooks}`)
        }
        try {
          traceRequestContextPaths(
            `exec request_context reply id=${esmId}`,
            session.requestContext,
          )
          await writeWithBackpressure(
            session.stream,
            buildRequestContextResult(esmId, session.requestContext),
            `request-context reply id=${esmId}`,
          )
          trace(`exec request_context: replied`)
        } catch (error) {
          rethrowTransportWriteFailure(error)
          failRunProtocol("Cursor request-context reply failed", RUN_REPLY_FAILED)
        }
      } else if (esm.mcp_state_exec_args) {
        // MCP-backed writes/reads can be preceded by this control-plane probe.
        // Confirm servers from the live host catalog (refreshed on each
        // doStream, including continuation), then keep pumping until Cursor
        // emits the actual mcp_args tool request.
        const stateArgs = esm.mcp_state_exec_args as Record<string, unknown>
        const requested = Array.isArray(stateArgs.server_identifiers)
          ? stateArgs.server_identifiers.join(",")
          : ""
        try {
          await writeWithBackpressure(
            session.stream,
            buildMcpStateResult(esmId, stateArgs, session.toolDescriptors),
            `MCP-state reply id=${esmId}`,
          )
          trace(`exec mcp_state: replied id=${esmId} requested=[${requested}]`)
        } catch (error) {
          rethrowTransportWriteFailure(error)
          failRunProtocol("Cursor MCP-state reply failed", RUN_REPLY_FAILED)
        }
      } else if (esm.list_mcp_resources_exec_args) {
        // Native Cursor exec (agent.v1 field 17), no OpenCode route under
        // Option B — see tasks/plans/fix-cursor-mcp-resource-exec.md. Answer
        // with Cursor's own no-client-qualifies shape and keep pumping.
        const args = esm.list_mcp_resources_exec_args as Record<string, unknown>
        const server = typeof args.server === "string" ? args.server : ""
        try {
          await writeWithBackpressure(
            session.stream,
            buildListMcpResourcesFallback(esmId),
            `list-MCP-resources reply id=${esmId}`,
          )
          trace(`exec list_mcp_resources: replied id=${esmId} server=${server || "(all)"} success{resources:[]}`)
        } catch (error) {
          rethrowTransportWriteFailure(error)
          failRunProtocol("Cursor list_mcp_resources reply failed", RUN_REPLY_FAILED)
        }
      } else if (esm.read_mcp_resource_exec_args) {
        // Native Cursor exec (agent.v1 field 18) — same rationale as above.
        const args = esm.read_mcp_resource_exec_args as Record<string, unknown>
        const server = typeof args.server === "string" ? args.server : ""
        const uri = typeof args.uri === "string" ? args.uri : ""
        try {
          await writeWithBackpressure(
            session.stream,
            buildReadMcpResourceFallback(esmId, server, uri),
            `read-MCP-resource reply id=${esmId}`,
          )
          trace(`exec read_mcp_resource: replied id=${esmId} server=${server} uri=${uri} error{server not found}`)
        } catch (error) {
          rethrowTransportWriteFailure(error)
          failRunProtocol("Cursor read_mcp_resource reply failed", RUN_REPLY_FAILED)
        }
      } else if (esm.git_diff_request) {
        const request = (esm.git_diff_request ?? {}) as Record<string, unknown>
        try {
          const frames = await buildGitDiffExecMessages({
            execId: esmId,
            request,
            workspaceRoot: workspaceRootFromRequestContext(session.requestContext),
          })
          for (const frame of frames) {
            await writeWithBackpressure(session.stream, frame, `git_diff reply id=${esmId}`)
          }
          trace(`exec git_diff: replied id=${esmId}`)
        } catch (error) {
          rethrowTransportWriteFailure(error)
          failRunProtocol("Cursor git_diff reply failed", RUN_REPLY_FAILED)
        }
      } else {
        replaySafety.markBarrier("non-control-exec")
        const displayCallId = extractExecDisplayCallId(esm)
        const parsed = parseExecServerMessage(esm, session.hostToolDialect, {
          terminalsFolder: terminalsFolderFromRequestContext(session.requestContext),
          workspaceRoot: workspaceRootFromRequestContext(session.requestContext),
        })
        // An edit's private prerequisite read is not the call's own request; its write is.
        if (displayCallId && !(parsed?.resultField === "read_result" && session.editToolCalls?.has(displayCallId))) {
          toolStep.resolved.add(displayCallId)
        }
        if (parsed) {
          const executableToolName = resolveCustomWebToolAlias(parsed.toolName, session.toolAliases)
          if (executableToolName !== parsed.toolName) {
            trace(`web tool alias resolved: ${parsed.toolName} -> ${executableToolName}`)
            parsed.toolName = executableToolName
          }
          remapNativeSubagentForCatalog(parsed, advertisedToolNameSet, session.subagentCatalog)
          // SubagentArgs has no description; Cursor's real title lives on the
          // correlated display TaskToolCall. Prefer that over the 5-word prompt slice.
          if (displayCallId && (parsed.toolName === "task" || parsed.toolName === "subagent")) {
            const stored = session.displayToolCalls.get(displayCallId)
            const display = parseDisplayToolCall(displayCallId, stored)
            if (display?.variant === "task_tool_call") {
              const description =
                typeof display.args.description === "string" ? display.args.description : undefined
              preferCorrelatedTaskDescription(parsed, description)
              if (description?.trim()) {
                trace(
                  `exec: preferred TaskToolCall description callId=${displayCallId} ` +
                    `description=${JSON.stringify(description.trim())}`,
                )
              }
            }
          }
          const editCall = displayCallId
            ? session.editToolCalls?.get(displayCallId)
            : undefined
          // A complete correlated edit read is trusted provenance: unlike an
          // ordinary capped read it cannot have appended our warning marker,
          // and the source itself may legitimately contain the marker text.
          if (!editCall?.completeRead) rejectPartialReadMutation(parsed)
          if (editCall) {
            const remapped = remapCorrelatedEditWriteForCatalog(
              parsed,
              advertisedToolNameSet,
              editCall.path,
              workspaceRootFromRequestContext(session.requestContext),
            )
            if (parsed.resultField === "write_result" && displayCallId) {
              session.editToolCalls?.delete(displayCallId)
            }
            if (remapped) {
              trace(
                `exec: preserved edit intent callId=${displayCallId} ` +
                  `path=${JSON.stringify(editCall.path)}`,
              )
            }
          }
          // Hosts that advertise `apply_patch` in place of `edit`/`write` (see
          // protocol/apply-patch.ts) still receive Cursor's native write/edit
          // exec requests. Translate before the unavailable-tool check below.
          remapEditToolsForCatalog(
            parsed,
            advertisedToolNameSet,
            workspaceRootFromRequestContext(session.requestContext),
          )
        }
        trace(`exec: id=${parsed?.id} variant=${parsed ? Object.keys(parsed).join(",") : "none"} toolName=${parsed?.toolName} resultField=${parsed?.resultField}`)
        if (parsed) {
          if (parsed.localError) {
            if (!await rejectExec(parsed, parsed.localError, "invalid mapping")) return
            continue
          }
          // OpenCode throws "Tool call not allowed while generating summary"
          // when assistantMessage.summary is set. Compaction/summary turns
          // advertise no tools — refuse on the Cursor channel and keep
          // pumping for text / turn_ended instead of emitting tool-call.
          if (!session.allowTools) {
            const reason = "Tool calls are not available during this turn (summary/compaction)."
            if (!await rejectExec(parsed, reason, "allowTools=false")) return
            continue
          }
          // Ahead of the catalog checks: an agent with a shell but no read tool polls these too.
          const terminalRead = await serveTerminalFileRead(parsed)
          if (terminalRead === "failed") return
          if (terminalRead === "served") {
            if (displayCallId) session.displayToolCalls.delete(displayCallId)
            continue
          }
          // Cursor writes a generated image with an ordinary write exec whose
          // `file_bytes` are binary (Cursor CLI's agent does exactly this, then
          // reads the client's WriteResult back). OpenCode's `write` takes a
          // string, so those bytes are staged and committed by the host tool
          // that can raise the `edit` permission before anything hits disk.
          const binaryWrite = binaryWritePayload(parsed)
          if (binaryWrite) {
            if (!advertisedToolNameSet.has(CURSOR_IMAGE_SAVE_TOOL)) {
              const reason =
                "This OpenCode agent cannot write binary file content. "
                + "Do not retry this write with the same bytes."
              if (!await rejectExec(parsed, reason, "binary write unsupported")) return
              continue
            }
            const workspaceRoot = workspaceRootFromRequestContext(session.requestContext)
            const projectDir = ensureOpencodeProjectDir(workspaceRoot)
            const target = remapCursorImageWritePath(binaryWrite.path, {
              workspaceRoot,
              projectDir,
            })
            let imageId: string
            try {
              imageId = stageCursorImage({
                path: target,
                projectDir,
                mime: imageMimeForPath(target, binaryWrite.data),
                data: binaryWrite.data,
                sessionId: session.openCodeSessionId,
              })
            } catch (error) {
              if (!await rejectExec(parsed, (error as Error).message, "binary write too large")) return
              continue
            }
            if (displayCallId) session.displayToolCalls.delete(displayCallId)
            sessionManager.registerPending(
              parsed.id,
              session,
              parsed.resultField,
              CURSOR_IMAGE_SAVE_TOOL,
              false,
              {
                ...parsed.resultMetadata,
                path: target,
                binaryWriteBytes: undefined,
                imageByteLength: binaryWrite.data.length,
              },
              displayCallId,
            )
            const toolCallId = `cursor_${session.sessionId}_${parsed.id}`
            trace(
              `exec: binary write STAGED toolCallId=${toolCallId} ` +
                `requested=${JSON.stringify(binaryWrite.path)} target=${JSON.stringify(target)} ` +
                `bytes=${binaryWrite.data.length}`,
            )
            emittedHostTools++
            closeOpenSpans()
            safeEnqueue({
              type: "tool-call",
              toolCallId,
              toolName: CURSOR_IMAGE_SAVE_TOOL,
              input: JSON.stringify({ image_id: imageId }),
            } as V3Part)
            if (endsToolStep()) {
              emitFinish(undefined, { unified: "tool-calls", raw: undefined })
              return
            }
            continue
          }
          // Cursor has native capabilities (Task, filesystem, shell, etc.) in
          // addition to the MCP descriptors sent by this provider. The model
          // can request one even when the current OpenCode agent omitted its
          // corresponding host tool. Emitting that request makes OpenCode
          // manufacture an `invalid` tool result. Refuse it on the held-open
          // Cursor exec channel instead, using the request's exact typed result.
          if (!advertisedToolNameSet.has(parsed.toolName)) {
            const available = advertisedToolNames.length > 0
              ? advertisedToolNames.join(", ")
              : "none"
            const reason =
              `OpenCode tool '${parsed.toolName}' is unavailable for the current agent. ` +
              `Available tools: ${available}. Continue using only available tools; do not retry ` +
              `'${parsed.toolName}'.`
            trace(
              `exec: unavailable catalog target toolName=${parsed.toolName} ` +
                `advertised=[${advertisedToolNames.join(",")}]`,
            )
            if (!await rejectExec(parsed, reason, "unavailable tool")) return
            continue
          }
          // Epoch advertisement may keep tools the host filtered this turn
          // (plan denies edit). Refuse those here — do not emit to OpenCode.
          const permittedToolNames = session.permittedToolNames
          if (
            permittedToolNames
            && permittedToolNames.size > 0
            && !permittedToolNames.has(parsed.toolName)
          ) {
            const permitted = [...permittedToolNames].sort().join(", ")
            const reason =
              `OpenCode tool '${parsed.toolName}' is not permitted for the current agent this turn. ` +
              `Permitted tools: ${permitted || "none"}. Continue using only permitted tools; do not retry ` +
              `'${parsed.toolName}'.`
            trace(
              `exec: not permitted this turn toolName=${parsed.toolName} ` +
                `permitted=[${[...permittedToolNames].sort().join(",")}]`,
            )
            if (!await rejectExec(parsed, reason, "not permitted this turn")) return
            continue
          }
          if (recoverCorrelatedEditRead(parsed, displayCallId)) continue
          if (rejectMissingReadTarget(parsed)) {
            if (displayCallId) session.displayToolCalls.delete(displayCallId)
            continue
          }
          if (displayCallId) {
            session.displayToolCalls.delete(displayCallId)
            trace(`exec: claimed display callId=${displayCallId}`)
          }
          const tc = buildToolCallPart(parsed, session.sessionId)
          if (
            parsed.resultField === "shell_stream"
            || parsed.resultField === "shell_result"
            || parsed.resultField === "background_shell_spawn_result"
          ) {
            registerCursorShellCall(tc.toolCallId, parsed.resultMetadata)
            const terminalsFolder = parsed.resultMetadata?.terminals_folder
            if (typeof terminalsFolder === "string") sweepStaleTerminalFiles(terminalsFolder)
          }
          // Keep the stream open; the result arrives on the next doStream call.
          sessionManager.registerPending(
            parsed.id,
            session,
            parsed.resultField,
            parsed.toolName,
            false,
            parsed.resultMetadata,
            displayCallId,
          )
          // A direct host `todowrite` is a replace-all snapshot: it is the new
          // truth for later Cursor merge patches, which otherwise apply onto a
          // stale (or empty) mirrored list.
          if (parsed.toolName === "todowrite") {
            const snapshot = snapshotMirroredTodos(parsed.args.todos)
            if (snapshot !== undefined) {
              storeMirroredTodos(session, snapshot)
              trace(`exec: mirrored todowrite snapshot items=${snapshot.length}`)
            }
          }
          // tc.input is already a JSON string (LanguageModelV3ToolCall.input).
          trace(`exec: EMITTED tool-call toolCallId=${tc.toolCallId} toolName=${tc.toolName} inputLen=${tc.input.length}`)
          emittedHostTools++
          // Close open text/reasoning spans before tool-call (required by AI SDK V3).
          closeOpenSpans()
          safeEnqueue({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
          } as V3Part)
          if (endsToolStep()) {
            emitFinish(undefined, { unified: "tool-calls", raw: undefined })
            return
          }
          continue
        }
        // Known Cursor-native exec variants with no safe OpenCode bridge are
        // soft-denied with a populated typed result or throw, so the turn
        // continues with remaining tools. Unknown fields still hard-fail.
        const variantField = detectExecVariantField(payload)
        const variant = variantField !== undefined
          ? cursorExecVariantByRequestField(variantField)
          : undefined
        if (variant?.handling === "unsupported") {
          const advertised = advertisedToolNames.length > 0 ? advertisedToolNames.join(", ") : "none"
          const rawReason =
            `Cursor-native '${variant.requestName}' is not available on this host. Continue with listed tools: ${advertised}; do not retry '${variant.requestName}'.`
          const grounded = appendWorkspaceRootGrounding(
            rawReason,
            workspaceRootFromRequestContext(session.requestContext),
          )
          // Allowlist/status denies have no string channel; buildUnsupportedExecDeny
          // ignores `reason` for those shapes and still selects the typed oneof.
          const frames = buildUnsupportedExecDeny({ execId: esmId, variant, reason: grounded })
          try {
            for (const frame of frames) {
              await writeWithBackpressure(session.stream, frame, `unsupported deny ${variant.requestName} id=${esmId}`)
            }
          } catch (error) {
            rethrowTransportWriteFailure(error)
            failRunProtocol("Cursor unsupported exec deny reply failed", RUN_REPLY_FAILED)
          }
          trace(`exec: SOFT-DENIED ${variant.requestName} id=${esmId}`)
          continue
        }
        // Never guess a response type for an unknown exec variant. Request and
        // result field numbers are not universally identical; a structurally
        // wrong reply recreates the heartbeat-only deadlock. Fail promptly so
        // schema drift is actionable.
        const variantDescription = describeCursorExecVariant(variantField)
        const hex = Array.from(payload.subarray(0, 48))
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("")
        trace(
          `exec UNMAPPED: id=${esmId} variant=${variantDescription} keys=[${Object.keys(esm).join(",")}] hex=${hex}`,
        )
        failRunProtocol(
          `Unsupported Cursor exec variant ${variantDescription} (id=${esmId})`,
          RUN_REQUEST_UNSUPPORTED,
        )
      }
    } else if (interactionQuery) {
      // InteractionQuery is a must-reply channel, just like exec and KV. AI
      // SDK has no Cursor-specific UI callback, so answer immediately with the
      // policy from protocol/interactions.ts (AskQuestion bridge, CreatePlan
      // write under OpenCode defaults, GenerateImage approve when saveable).
      const handled = (() => {
        try {
          return handleInteractionQuery(interactionQuery, payload, {
            canBridgeAskQuestion: session.allowTools && advertisedToolNameSet.has("question"),
            allowTools: session.allowTools,
            advertisedTools: advertisedToolNameSet,
            canSaveGeneratedImage:
              session.allowTools && advertisedToolNameSet.has(CURSOR_IMAGE_SAVE_TOOL),
            canBridgeCreatePlan:
              session.allowTools
              && isBridgedCursorPlanModeActive(session.openCodeSessionId)
              && advertisedToolNameSet.has(CURSOR_PLAN_STAGE_TOOL)
              && advertisedToolNameSet.has("write"),
            planModeActive: isCursorPlanModeActive(session.openCodeSessionId),
            ...(getActiveCursorMode(session.openCodeSessionId)
              ? { activeCursorModeId: getActiveCursorMode(session.openCodeSessionId)! }
              : {}),
            workspaceRoot: workspaceRootFromRequestContext(session.requestContext),
          })
        } catch {
          return failRunProtocol("Cursor interaction request could not be handled", RUN_REQUEST_UNSUPPORTED)
        }
      })()
      try {
        if (handled.outcome === "acknowledged") {
          replaySafety.markBarrier("stateful-interaction")
        }
        if (handled.reply) {
          await writeWithBackpressure(
            session.stream,
            handled.reply,
            `interaction reply id=${handled.id}`,
          )
        }
        trace(
          `interaction_query: replied id=${handled.id} variant=${handled.variantName} ` +
            `field=${handled.variantField} outcome=${handled.outcome}` +
            (handled.reply ? "" : " (deferred to host tool result)"),
        )
        // Tag the Run for cache diagnosis: a first CreatePlan/SwitchMode can
        // coincide with a one-time upstream tools-category expansion. Set on
        // any outcome (acknowledged/approved/bridged) via presence, not kind.
        if (handled.createPlan && session.cacheDiagnostics) {
          session.cacheDiagnostics.createPlanInTurn = true
        }
        if (handled.switchMode && session.cacheDiagnostics) {
          session.cacheDiagnostics.switchModeInTurn = true
        }
        if (handled.generateImage) {
          trace(
            `interaction_query: approved generate_image target=` +
              `${JSON.stringify(handled.generateImage.filePath || "(unspecified)")} ` +
              `refs=${handled.generateImage.referenceImagePaths.length} ` +
              `cursorToolCallId=${handled.generateImage.toolCallId || "(none)"}`,
          )
        }
      } catch (error) {
        rethrowTransportWriteFailure(error)
        failRunProtocol("Cursor interaction reply failed", RUN_REPLY_FAILED)
      }
      if (handled.outcome === "bridged" && handled.askQuestion) {
        // Cursor raised AskQuestion; OpenCode owns the tool loop, so the prompt
        // leaves as a `question` tool call and this doStream ends. The Run stays
        // open on the pending entry, and the answer is written back on the next
        // continuation (InteractionResponse when Cursor is blocking on it,
        // ConversationAction when it was already acknowledged with `async`).
        const ask = handled.askQuestion
        const execId = session.nextBridgedExecId++
        sessionManager.registerPending(
          execId,
          session,
          ASK_QUESTION_RESULT_FIELD,
          "question",
          false,
          {
            interactionId: handled.id,
            askQuestionArgs: ask.args,
            askQuestionRawArgs: ask.rawArgs,
            askQuestionToolCallId: ask.toolCallId,
          },
        )
        const toolCallId = `cursor_${session.sessionId}_${execId}`
        const input = JSON.stringify(askQuestionToolInput(ask.args))
        trace(
          `interaction_query: BRIDGED ask_question id=${handled.id} toolCallId=${toolCallId} ` +
            `questions=${ask.args.questions.length} runAsync=${ask.args.runAsync} ` +
            `cursorToolCallId=${ask.toolCallId || "(none)"}`,
        )
        emittedHostTools++
        closeOpenSpans()
        safeEnqueue({
          type: "tool-call",
          toolCallId,
          toolName: "question",
          input,
        } as V3Part)
        emitFinish(undefined, { unified: "tool-calls", raw: undefined })
        return
      }
      if (handled.outcome === "approved" && handled.switchMode) {
        // Entering plan mode without a host plan tool: Cursor was already
        // released with approved{} above, and the behavioural contract travels
        // as the <system_reminder> injected on subsequent Runs. Nothing is
        // pending, so keep pumping this Run rather than ending doStream.
        const sw = handled.switchMode
        setActiveCursorMode(session.openCodeSessionId, sw.args.targetModeId, {
          bridgedPlanEntered: false,
        })
        const hostAgentSwitchQueued = session.openCodeSessionId
          ? queueHostAgentModeSwitch({
            sessionID: session.openCodeSessionId,
            targetModeID: sw.args.targetModeId,
            cursorSessionID: session.sessionId,
          })
          : false
        trace(
          `interaction_query: APPROVED switch_mode id=${handled.id} ` +
            `target=${JSON.stringify(sw.args.targetModeId)} (no host plan tool; ` +
            `${hostAgentSwitchQueued ? "native host-agent switch queued" : "provider-owned fallback"}) ` +
            `cursorToolCallId=${sw.toolCallId || "(none)"}`,
        )
        continue
      }
      if (handled.outcome === "bridged" && handled.switchMode) {
        // Cursor raised SwitchMode; the host owns the outcome, so the switch
        // leaves as a tool call (native plan_enter / plan_exit, or the emulated
        // `question` approval prompt) and this doStream ends. The Run stays open
        // on the pending entry; approved/rejected is written back on the next
        // continuation while Cursor is still blocking on the query.
        const sw = handled.switchMode
        const bridgeKind = sw.bridge.kind
        const toolName = sw.toolName ?? "plan_exit"
        const execId = session.nextBridgedExecId++
        sessionManager.registerPending(
          execId,
          session,
          SWITCH_MODE_RESULT_FIELD,
          toolName,
          false,
          {
            interactionId: handled.id,
            switchModeTarget: sw.args.targetModeId,
            switchModeToolCallId: sw.toolCallId,
            switchModeBridgeKind: bridgeKind,
          },
        )
        const toolCallId = `cursor_${session.sessionId}_${execId}`
        const input = JSON.stringify(
          sw.bridge.kind === "question" ? sw.bridge.input : switchModeToolInput(),
        )
        trace(
          `interaction_query: BRIDGED switch_mode id=${handled.id} toolCallId=${toolCallId} ` +
            `bridge=${bridgeKind} hostTool=${toolName} ` +
            `target=${JSON.stringify(sw.args.targetModeId)} ` +
            `cursorToolCallId=${sw.toolCallId || "(none)"}`,
        )
        emittedHostTools++
        closeOpenSpans()
        safeEnqueue({
          type: "tool-call",
          toolCallId,
          toolName,
          input,
        } as V3Part)
        emitFinish(undefined, { unified: "tool-calls", raw: undefined })
        return
      }
      if (handled.outcome === "bridged" && handled.createPlan) {
        // Either a host plan-stage tool (writes the plan and runs its own
        // approval UI) or the emulated prompt after the provider already wrote
        // the plan. Both hold Cursor's query open until the user decides.
        const plan = handled.createPlan
        const staged = plan.bridge.kind === "stage" ? createPlanStageInput(plan.args) : undefined
        const planUri = staged?.plan_uri ?? plan.planUri ?? ""
        const input = staged ?? plan.questionInput ?? {}
        const stageExecId = session.nextBridgedExecId++
        sessionManager.registerPending(
          stageExecId,
          session,
          CREATE_PLAN_RESULT_FIELD,
          plan.toolName,
          false,
          {
            interactionId: handled.id,
            createPlanToolCallId: plan.toolCallId,
            createPlanBridgeKind: plan.bridge.kind,
            // The host echoes the prompt verbatim; it anchors the answer parse.
            createPlanQuestion: plan.questionInput?.questions[0]?.question ?? "",
            planUri,
            // Absolute path for the post-Yes OpenCode kickoff (plan_exit shape).
            ...(typeof plan.planPath === "string" && plan.planPath.trim()
              ? { planPath: plan.planPath.trim() }
              : {}),
            workspaceRoot: workspaceRootFromRequestContext(session.requestContext),
          },
        )
        const stageToolCallId = `cursor_${session.sessionId}_${stageExecId}`
        trace(
          `interaction_query: BRIDGED create_plan id=${handled.id} bridge=${plan.bridge.kind} ` +
            `hostTool=${plan.toolName} stageToolCallId=${stageToolCallId} ` +
            `planUri=${planUri || "(none)"} cursorToolCallId=${plan.toolCallId || "(none)"}`,
        )
        // Cursor sends the plan body through the interaction query, not the
        // text stream, so nothing has shown it yet. Put it in the transcript
        // before asking — approving a plan you cannot read is not approval.
        if (plan.planReview) emitText(plan.planReview)
        emittedHostTools++
        closeOpenSpans()
        safeEnqueue({
          type: "tool-call",
          toolCallId: stageToolCallId,
          toolName: plan.toolName,
          input: JSON.stringify(input),
        } as V3Part)
        emitFinish(undefined, { unified: "tool-calls", raw: undefined })
        return
      }
    } else if (execControl) {
      applyExecControl(session, execControl, "pump")
    } else if (kv) {
      // KV blob channel: ack set_blob / answer get_blob, then keep pumping.
      // Not replying hangs the turn — see protocol/kv.ts.
      trace(
        `kv frame raw: gunzippedLen=${payload.length} id=${kv.id ?? "?"} ` +
          `get=${!!kv.get_blob_args} set=${!!kv.set_blob_args} ` +
          `getBlobIdLen=${(kv.get_blob_args as any)?.blob_id?.length ?? "-"} ` +
          `setBlobIdLen=${(kv.set_blob_args as any)?.blob_id?.length ?? "-"} ` +
          `setDataLen=${(kv.set_blob_args as any)?.blob_data?.length ?? "-"}`,
      )
      const handled = handleKvServerMessage(kv, session)
      // Content-as-id reads are answered by echoing the id back (`echoed`); only a
      // hash we cannot serve means the checkpoint references state we lost.
      if (handled?.kind === "get" && !handled.found && !handled.echoed) blobMiss = true
      if (handled) {
        try {
          await writeWithBackpressure(
            session.stream,
            handled.reply,
            `KV ${handled.kind}_blob reply id=${handled.id}`,
          )
          trace(
            `kv replied: kind=${handled.kind} id=${handled.id} blobId=${handled.blobIdHex.slice(0, 16)}… ` +
              `found=${handled.found} echoed=${!!handled.echoed} ` +
              `replyBytes=${handled.reply.length} replyBlobBytes=${handled.replyBlobBytes} ` +
              `sessionBlobs=${session.blobs.size} convBlobs=${conversationBlobCount(session.conversationId)}`,
          )
        } catch (error) {
          rethrowTransportWriteFailure(error)
          failRunProtocol("Cursor KV reply failed", RUN_REPLY_FAILED)
        }
      } else {
        failRunProtocol("Cursor KV request could not be handled", RUN_REQUEST_UNSUPPORTED)
      }
    }
    } catch (e) {
      if (e instanceof CursorProviderError) throw e
      if (requiredChannel) {
        failRunProtocol(`Cursor ${requiredChannel} request could not be handled`, RUN_REQUEST_UNSUPPORTED)
      }
      // Any per-frame dispatch throw (e.g. protobufjs length overrun in
      // exec/args decode) must not abort the whole turn — log and skip.
      trace(`frame dispatch FAILED (skipping): topField=${topField}`)
    }
    // heartbeat / step / partial_tool_call → ignore (partial args are
    // display-only; the exec channel is authoritative. Checkpoints and
    // interaction queries are handled above.)
  }
}

/** Normalize protobufjs bytes / Buffer / number[] into a Uint8Array. */
function normalizeCheckpointBytes(raw: unknown): Uint8Array | undefined {
  if (raw instanceof Uint8Array) return raw
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw)
  if (Array.isArray(raw)) return Uint8Array.from(raw)
  if (raw && typeof raw === "object" && "type" in (raw as object) && "data" in (raw as object)) {
    // protobufjs sometimes yields { type: "Buffer", data: number[] }
    const data = (raw as { data: unknown }).data
    if (Array.isArray(data)) return Uint8Array.from(data)
  }
  return undefined
}

// ── Prompt extraction ──

type ExtractedToolResult = {
  toolCallId: string
  sessionId: string
  execId: number
  toolName: string
  output: string
  error?: string
  /** Host media parts of this result (own content, or the trailing media message). */
  media?: unknown[]
  /** `media` decoded for the exec result, with content hashes in the same order. */
  images?: CursorImageInput[]
  imageHashes?: string[]
  /** Host notes that trailed the step's results, applied after the result is parsed. */
  note?: string
}

function extractToolResults(prompt: LanguageModelV3CallOptions["prompt"]): ExtractedToolResult[] {
  const out: ExtractedToolResult[] = []
  for (const msg of prompt) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      const p = part as unknown as Record<string, unknown>
      if (p.type !== "tool-result") continue
      const toolCallId = (p.toolCallId as string) ?? ""
      const parsed = parseExecIdFromToolCallId(toolCallId)
      if (!parsed) continue
      const { text, isError } = toolResultOutputToText(p.output)
      const media = toolResultOutputMedia(p.output)
      out.push({
        toolCallId,
        sessionId: parsed.sessionId,
        execId: parsed.execId,
        toolName: (p.toolName as string) ?? "mcp",
        output: text,
        error: isError ? text : undefined,
        ...(media.length > 0 ? { media } : {}),
      })
    }
  }
  return out
}

/**
 * Tool results that form a live continuation: only the trailing run of `tool`
 * messages after the last non-tool message. Mid-prompt historical tool results
 * are ignored — they are conversation history, not replies for a held-open Run.
 */
// OpenCode 2.x appends these host notes after the tool results of a step:
// mid-turn system updates (skill / MCP availability changes) are lowered to a
// user message wrapping `<system-update>`, and tool-result media is re-sent as
// a user message starting with this caption.
const SYSTEM_UPDATE_OPEN = "<system-update>"
const SYSTEM_UPDATE_CLOSE = "</system-update>"
const TOOL_MEDIA_CAPTION = "Attached media from tool result:"

type HostTailNote = { text?: string; media?: unknown[] }

function hostTailNote(message: LanguageModelV3CallOptions["prompt"][number]): HostTailNote | undefined {
  if (message.role === "system") return { text: message.content }
  if (message.role !== "user" || !Array.isArray(message.content) || message.content.length === 0) return undefined
  const [first, ...media] = message.content
  if (first?.type === "text" && first.text === TOOL_MEDIA_CAPTION) return { media }
  const texts: string[] = []
  for (const part of message.content) {
    if (part.type !== "text") return undefined
    const text = part.text.trim()
    if (!text.startsWith(SYSTEM_UPDATE_OPEN) || !text.endsWith(SYSTEM_UPDATE_CLOSE)) return undefined
    texts.push(text)
  }
  return { text: texts.join("\n") }
}

/**
 * Split off host notes that trail the live tool results. They are not a new
 * user turn: the held Run must still receive its tool results.
 */
function liveTail(prompt: LanguageModelV3CallOptions["prompt"]): { end: number; notes: string[]; media: unknown[] } {
  let end = prompt.length
  const notes: string[] = []
  const media: unknown[] = []
  while (end > 0) {
    const note = hostTailNote(prompt[end - 1])
    if (!note) break
    if (note.text) notes.unshift(note.text)
    if (note.media) media.unshift(...note.media)
    end--
  }
  return { end, notes, media }
}

export function extractTrailingToolResults(
  prompt: LanguageModelV3CallOptions["prompt"],
): ExtractedToolResult[] {
  const { end, notes, media } = liveTail(prompt)
  let i = end - 1
  while (i >= 0 && prompt[i].role === "tool") i--
  // Continuations end with tool messages. Anything else (user/assistant)
  // means this is a fresh model call that merely carries tools in history.
  if (i === end - 1) return []
  const results = extractToolResults(prompt.slice(i + 1, end))
  if (media.length > 0) attributeTrailingMedia(results, media)
  // A Run continuation only carries exec results, so the host notes ride on one
  // of them; otherwise Cursor would never see e.g. a removed skill. Delivery
  // picks the result whose typed shape can hold them.
  const last = results.at(-1)
  if (last && notes.length > 0) {
    results[results.length - 1] = { ...last, note: notes.join("\n\n") }
  }
  return results
}

// OpenCode 2 replaces a tool result that was only media with this text, and
// its read tool answers an image or PDF with one of the others plus one file.
const TOOL_MEDIA_PLACEHOLDER = "Media attached in the following user message."
const MEDIA_READ_OUTPUTS = new Set(["Image read successfully", "PDF read successfully"])

/**
 * OpenCode moves the media of every result in a step into one trailing
 * message, in result order. One result takes all of it. With several, each
 * media read takes its one part and the rest goes to the placeholder results;
 * when no placeholder settles it (results with text and media), the rest rides
 * on the last result, as host notes do, so Cursor still sees it this turn.
 */
function attributeTrailingMedia(results: ExtractedToolResult[], media: unknown[]): void {
  const shares = results.map(() => 0)
  if (results.length === 1) shares[0] = media.length
  else {
    let rest = media.length
    results.forEach((r, index) => {
      if (rest > 0 && MEDIA_READ_OUTPUTS.has(r.output)) { shares[index] = 1; rest-- }
    })
    const placeholders = results.flatMap((r, index) => r.output === TOOL_MEDIA_PLACEHOLDER ? [index] : [])
    if (rest > 0 && placeholders.length === rest) for (const index of placeholders) shares[index] = 1
    else if (rest > 0 && placeholders.length === 1) shares[placeholders[0]!] = rest
    else if (rest > 0) {
      let target = results.length - 1
      while (target > 0 && MEDIA_READ_OUTPUTS.has(results[target]!.output)) target--
      shares[target] = shares[target]! + rest
      trace(`continuation: ${rest} tool-result media part(s) without a known owner ride on execId=${results[target]!.execId}`)
    }
  }
  let next = 0
  results.forEach((result, index) => {
    const share = shares[index]!
    if (share === 0) return
    results[index] = { ...result, media: [...(result.media ?? []), ...media.slice(next, next + share)] }
    next += share
  })
}

/** Decode tool-result images for the exec results of a held-Run continuation. */
async function decodeTrailingToolImages(
  results: ExtractedToolResult[],
  signal?: AbortSignal,
): Promise<ExtractedToolResult[]> {
  return Promise.all(results.map(async (result) => {
    if (!result.media?.length) return result
    const { images, hashes } = await extractCursorToolResultImages(result.media, { signal })
    return images.length > 0 ? { ...result, images, imageHashes: hashes } : result
  }))
}

// A tool OpenCode interrupted (user stop, declined permission). OpenCode 2 and 1.x's newer session
// engine (`type: "unknown"`) replay a failed tool as plain text holding exactly `{ error, content }`,
// the same output type as a completed tool's; 1.x's classic loop sends plain error text.
const OPENCODE_INTERRUPTED_TEXT = new Set(["Tool execution aborted", "[Tool execution was interrupted]"])

function isOpenCodeInterruptedEnvelope(output: string): boolean {
  if (!output.startsWith('{"error":{')) return false
  let envelope: unknown
  try {
    envelope = JSON.parse(output)
  } catch {
    return false
  }
  const { error, content, ...rest } = envelope as Record<string, unknown>
  if (Object.keys(rest).length > 0 || !Array.isArray(content) || JSON.stringify(envelope) !== output) return false
  const { type, message } = error as Record<string, unknown>
  if (typeof type !== "string" || typeof message !== "string") return false
  return type === "aborted" || message === "Tool execution interrupted" || message.startsWith("Tool execution interrupted: ")
}

function isInterruptedToolResult(result: ExtractedToolResult): boolean {
  return isOpenCodeInterruptedEnvelope(result.output)
    || (result.error !== undefined && OPENCODE_INTERRUPTED_TEXT.has(result.error.trim()))
}

function plainUserText(message: LanguageModelV3CallOptions["prompt"][number]): string | undefined {
  if (message.role !== "user" || !Array.isArray(message.content) || message.content.length === 0) return undefined
  const texts: string[] = []
  for (const part of message.content) {
    if (part.type !== "text") return undefined
    texts.push(part.text)
  }
  return texts.join("\n")
}

/**
 * Plain-text user messages that arrived during a step, from the first one to
 * the end of the prompt, and the host notes among them. Host notes before the
 * first stay with the tool results. A message with an attachment is no steer.
 */
function trailingSteer(
  prompt: LanguageModelV3CallOptions["prompt"],
): { start: number; messages: string[]; hostNote?: string } | undefined {
  let start: number | undefined
  for (let i = prompt.length - 1; i >= 0; i--) {
    if (hostTailNote(prompt[i])) continue
    if (plainUserText(prompt[i]) === undefined) break
    start = i
  }
  if (start === undefined) return undefined
  const messages: string[] = []
  const hostNotes: string[] = []
  for (const message of prompt.slice(start)) {
    const hostNote = hostTailNote(message)
    if (hostNote) {
      if (hostNote.text) hostNotes.push(hostNote.text)
    } else {
      messages.push(plainUserText(message)!)
    }
  }
  return { start, messages, hostNote: joinNotes(hostNotes) }
}

/**
 * OpenCode promotes a mid-turn user message after the step's tool results, so
 * the prompt ends with a user message instead of the results. When a held Run
 * waits on exactly those results, they are still a live continuation and the
 * messages are injected into that Run. Otherwise the call stays a fresh turn.
 * An in-session helper replaying the history under a reduced catalog is no steer.
 */
export function extractLiveSteerResults(
  prompt: LanguageModelV3CallOptions["prompt"],
  sessionKey: string | undefined,
  wireModelId: string,
  incomingTools: ReadonlyArray<{ name?: string }> = [],
): { results: ExtractedToolResult[]; messages: string[] } | undefined {
  if (!sessionKey) return undefined
  const steer = trailingSteer(prompt)
  if (!steer) return undefined
  const results = extractTrailingToolResults(prompt.slice(0, steer.start))
  const held = findContinuationSession(results)
  if (
    !held
    || held.closed
    || !held.runId
    || held.openCodeSessionId !== sessionKey
    || sessionManager.isActivelyPumping(held)
    || isProperCatalogSubset(incomingTools, held.toolCatalog ?? [])
  ) {
    return undefined
  }
  const heldModel = held.cacheDiagnostics?.modelId
  if (heldModel !== undefined && heldModel !== wireModelId) return undefined
  if (results.some((r) => r.sessionId !== held.sessionId || held.pending.get(r.execId)?.state !== "pending")) {
    return undefined
  }
  const answered = new Set(results.map((r) => r.execId))
  for (const execId of held.pending.keys()) if (!answered.has(execId)) return undefined
  if (results.some(isInterruptedToolResult)) return undefined
  if (steer.hostNote) {
    const last = results[results.length - 1]
    results[results.length - 1] = { ...last, note: joinNotes([last.note, steer.hostNote]) }
  }
  return { results, messages: steer.messages }
}

/**
 * Title, summary and compaction calls replay the history with their own prompt last, which can
 * look like a steer; they carry no tools (or `toolChoice: none`) or are marked as compaction.
 */
export function mayBeUserStep(callOptions: LanguageModelV3CallOptions): boolean {
  if (extractTools(callOptions).length === 0 || callOptions.toolChoice?.type === "none") return false
  const compaction = (callOptions.providerOptions?.cursor as Record<string, unknown> | undefined)?.[CURSOR_COMPACTION_OPTION]
  if (compaction !== undefined) return compaction !== true
  const sessionKey = opencodeSessionKey(callOptions)
  return !sessionKey || !isCompactionSession(sessionKey)
}

/** Cursor completes an exec's tool call once it has the result; other replies have no such signal. */
function resultsAwaitingCheckpoint(
  session: CursorSession,
  results: readonly ExtractedToolResult[],
): NonNullable<CursorSession["resultsAfterCheckpoint"]> {
  const awaiting = new Set(session.resultsAfterCheckpoint?.awaiting)
  let unconfirmed = session.resultsAfterCheckpoint?.unconfirmed ?? false
  const toolCallIds = new Set(session.resultsAfterCheckpoint?.toolCallIds)
  for (const result of results) {
    toolCallIds.add(result.toolCallId)
    const pending = result.sessionId === session.sessionId ? session.pending.get(result.execId) : undefined
    if (!pending || pending.bridged) continue
    if (pending.displayCallId) awaiting.add(pending.displayCallId)
    else unconfirmed = true
  }
  return { awaiting, unconfirmed, toolCallIds }
}

/** Queue mid-turn user messages on the held Run before its results, as Cursor CLI steers. */
function injectSteerMessages(session: CursorSession, messages: readonly string[]): CursorSession | undefined {
  const injections: SteerInjection[] = messages.map((text) => ({ id: crypto.randomUUID(), text, state: "sent" }))
  try {
    for (const injection of injections) {
      session.stream.write(buildInjectUserMessage({
        injectionId: injection.id,
        expectedRunId: session.runId!,
        text: injection.text,
      }))
    }
  } catch (error) {
    trace(`steer: inject write FAILED sessionId=${session.sessionId} err=${(error as Error).message}`)
    sessionManager.close(session, "result-write-failed")
    return undefined
  }
  ;(session.steerInjections ??= []).push(...injections)
  trace(
    `steer: injected ${injections.length} message(s) runId=${session.runId} ` +
      `ids=${injections.map((i) => i.id).join(",")}`,
  )
  return session
}

/** Detect a host-owned canonical plan review, excluding Cursor exec replies. */
export function hasApprovedUncorrelatedPlanStageResult(
  prompt: LanguageModelV3CallOptions["prompt"],
): boolean {
  const { end } = liveTail(prompt)
  if (end === 0 || prompt[end - 1].role !== "tool") return false
  for (let i = end - 1; i >= 0 && prompt[i].role === "tool"; i--) {
    const message = prompt[i]
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolName !== CURSOR_PLAN_STAGE_TOOL) continue
      if (parseExecIdFromToolCallId(part.toolCallId)) continue
      const result = toolResultOutputToText(part.output)
      return !result.isError
    }
  }
  return false
}

function toolResultOutputToText(output: unknown): { text: string; isError: boolean } {
  if (output == null) return { text: "", isError: false }
  if (typeof output === "string") return { text: output, isError: false }
  const o = output as Record<string, unknown>
  // LanguageModelV3 tool-result output: { type: "text"|"json"|"error-text"|..., value }
  const isError = typeof o.type === "string" && (o.type as string).startsWith("error")
  if (o.type === "text" || o.type === "error-text") {
    return { text: String(o.value ?? ""), isError }
  }
  if (o.type === "json" || o.type === "error-json") {
    return { text: JSON.stringify(o.value ?? null), isError }
  }
  if (o.type === "content" && Array.isArray(o.value)) {
    // Media is returned separately by toolResultOutputMedia.
    const text = o.value
      .map((c) => {
        const cp = c as Record<string, unknown>
        return cp.type === "text" ? String(cp.text ?? "") : ""
      })
      .join("")
    return { text, isError }
  }
  return { text: JSON.stringify(output), isError }
}

function toolResultOutputMedia(output: unknown): unknown[] {
  if (!output || typeof output !== "object") return []
  const o = output as Record<string, unknown>
  if (o.type !== "content" || !Array.isArray(o.value)) return []
  return o.value.filter((part) => !!part && typeof part === "object" && (part as Record<string, unknown>).type !== "text")
}

function extractSystemPrompt(prompt: LanguageModelV3CallOptions["prompt"]): string | undefined {
  const parts: string[] = []
  for (const m of prompt) {
    if (m.role === "system" && typeof m.content === "string") parts.push(m.content)
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined
}

/**
 * Keep the workspace root on a checkpointed turn's live user message too, and
 * require absolute `path` arguments when that is the host's file-tool dialect.
 */
export function groundCheckpointTurnText(
  userText: string,
  checkpoint: boolean,
  workspaceRoot: string,
  tools: readonly { name?: string; inputSchema?: unknown }[],
): string {
  if (!checkpoint) return userText
  return appendCheckpointUserGrounding(userText, workspaceRoot, {
    requireAbsolutePathArg: hostToolDialectFromTools(tools).filePathKey === "path",
  })
}

/**
 * Cursor's native UI interactions cannot be surfaced through the AI SDK.
 * Redirect only to OpenCode tools that are genuinely advertised this turn;
 * compaction keeps its dedicated summary prompt unchanged.
 */
export function buildOpenCodeInteractionGuidance(
  tools: OpencodeToolDef[],
  isCompaction: boolean,
  workspaceRoot: string,
  options: { knownMcpServers?: Iterable<string> } = {},
): string | undefined {
  if (isCompaction) return undefined
  const names = new Set(tools.map((tool) => tool.name))
  if (names.size === 0) return undefined
  const instructions: string[] = []
  const subagents = extractHostSubagentCatalog(tools)

  if (names.has("question")) {
    // Cursor-native AskQuestion is translated into this tool (see
    // protocol/ask-question.ts), so both routes reach the user. Saying so stops
    // the model from treating a question as impossible when it reaches for its
    // native interaction first.
    instructions.push(
      "- When user input is required, call the OpenCode `question` tool. Cursor-native AskQuestion requests are also accepted and answered through it.",
    )
  }
  // CreatePlan is a Cursor InteractionQuery (#7), not an OpenCode/MCP catalog
  // tool. Always say so when we advertise any tools — otherwise the model sees
  // CreatePlan in Cursor's function definitions, notices it is absent from the
  // OpenCode list, and narrates "No CreatePlan MCP tool is available" even
  // though the provider bridges the native interaction.
  instructions.push(
    names.has("cursor_plan_stage")
      ? "- Cursor-native CreatePlan is accepted as a Cursor interaction (not an OpenCode or MCP catalog tool). Raise it normally. The host stage tool waits for the host plan review and does not return until the user accepts or declines. Do not call `plan_exit` to submit or skip that review, and do not implement until that tool returns success. Do not narrate that CreatePlan is missing, unavailable, or not an MCP tool. When the task will need a user-approved plan, record the first version as soon as its shape is clear, then keep investigating: refining afterward is expected and follow-up plans cost nothing extra. Do not defer the first plan until investigation is complete."
      : "- Cursor-native CreatePlan is accepted as a Cursor interaction (not an OpenCode or MCP catalog tool). Raise it normally; the provider writes the plan under the host's calculated plans directory and handles execution approval. Do not narrate that CreatePlan is missing, unavailable, or not an MCP tool. When the task will need a user-approved plan, record the first version as soon as its shape is clear, then keep investigating: refining afterward is expected and follow-up plans cost nothing extra. Do not defer the first plan until investigation is complete.",
  )
  if (names.has("plan_enter")) {
    instructions.push(
      "- To enter plan mode, call the OpenCode `plan_enter` tool. Cursor-native SwitchMode requests for plan/spec are also accepted and answered through it.",
    )
  }
  if (names.has("plan_exit")) {
    instructions.push(
      "- To leave plan mode, call the OpenCode `plan_exit` tool. Cursor-native SwitchMode for any non-plan target (agent, build, chat, debug, edit, background, multitask, triage, project, …) is also accepted and answered through it; the provider then injects the Cursor CLI-shaped mode reminder for that target.",
    )
  }
  // Prefer host todos whenever advertised. Keep guidance terse — spelling out
  // Cursor TodoWrite vs TodoRead / MCP alias collisions teaches the model to
  // inventory catalogs instead of just calling the host tools.
  if (names.has("todowrite") || names.has("todoread")) {
    const write = names.has("todowrite") ? "`todowrite`" : undefined
    const read = names.has("todoread") ? "`todoread`" : undefined
    const tools =
      write && read ? `${write} / ${read}` : (write ?? read)!
    instructions.push(
      `- For task-list create/update/complete/cancel${read ? "/read" : ""}, call OpenCode ${tools}; do not use Cursor TodoWrite, and do not narrate Cursor-vs-OpenCode todo-tool differences.`,
    )
  }
  if (names.has(CUSTOM_WEBSEARCH_TOOL)) {
    instructions.push(
      `- For web searches, call \`${CUSTOM_WEBSEARCH_TOOL}\`; do not use Cursor's native WebSearch interaction.`,
    )
  }
  if (names.has(CUSTOM_WEBFETCH_TOOL)) {
    instructions.push(
      `- To fetch a known URL, call \`${CUSTOM_WEBFETCH_TOOL}\`; do not use Cursor's native WebFetch interaction.`,
    )
  }
  if (names.has(CUSTOM_LIST_MCP_RESOURCES_TOOL)) {
    instructions.push(
      `- To list MCP resources, call \`${CUSTOM_LIST_MCP_RESOURCES_TOOL}\`; do not use Cursor's native resource-listing interaction.`,
    )
  }
  if (names.has(CUSTOM_READ_MCP_RESOURCE_TOOL)) {
    instructions.push(
      `- To read an MCP resource, call \`${CUSTOM_READ_MCP_RESOURCE_TOOL}\`; do not use Cursor's native resource-reading interaction.`,
    )
  }
  if (names.has("execute")) {
    const shell = names.has("shell") ? "`shell`" : names.has("bash") ? "`bash`" : undefined
    instructions.push(
      shell
        ? `- OpenCode \`execute\` is Code Mode JavaScript (\`code\`); it is not a shell. For OS commands, call OpenCode ${shell}. Do not pass \`command\` to \`execute\`.`
        : "- OpenCode `execute` is Code Mode JavaScript (`code`); it is not a shell. Do not pass `command` to `execute`.",
    )
    instructions.push(
      "- Call tools named in the direct list by their own names, even when a server instruction says to reach them through `execute`. Use `execute` only for tools that appear in the host Code Mode catalog and are absent from that list. Use the exact paths and signatures from that catalog or its `search` function, and call `execute` with `{ code }`.",
    )
  }
  if (names.has("task") || names.has("subagent")) {
    const target = names.has("task") ? "`task`" : "`subagent`"
    const available = subagents.agents.map((agent) => `\`${agent.name}\``).join(", ")
    instructions.push(
      `- Native Cursor Task/subagent requests are executed through OpenCode ${target}. ` +
        "Advertised custom subagent names are used exactly; otherwise `unspecified` and `generalPurpose` select host `general`, " +
        "`bugbot`, `security-review`, and `explore` select host `explore` (then `general`), and other specialized Cursor types fall back to `general`." +
        (available ? ` Spawnable host agents this turn: ${available}.` : ""),
    )
    if (subagents.agents.some((agent) => agent.name === "scout")) {
      instructions.push(
        "- Host `scout` is available for external documentation and dependency-source research. Use Cursor `cursor-guide` for that use case; local repository discovery still uses `bugbot`/`explore`.",
      )
    }
  }
  // Issue #29: skill/MCP stay off Cursor's native top-level list on both
  // OpenCode 1.x and 2.0 — route them through the dynamic catalog instead.
  {
    const dynamicCatalog = buildDynamicCatalogRoutingInstruction({
      toolNames: tools.map((tool) => tool.sourceName ?? tool.name),
      knownMcpServers: options.knownMcpServers,
    })
    if (dynamicCatalog) instructions.push(dynamicCatalog)
  }
  if (names.has("write")) {
    instructions.push(
      names.has("edit")
        ? "- For file changes, use OpenCode `edit` for targeted changes to existing files and `write` to create files or intentionally replace complete contents; do not use shell, Python, or heredocs to change file content while these tools are available."
        : "- Use OpenCode `write` for file-content changes; do not use shell, Python, or heredocs to change file content while it is available.",
    )
  } else if (names.has("apply_patch")) {
    // This host withheld `edit`/`write` and offers `apply_patch` instead. Native
    // Cursor write/edit requests are translated into it, so say so rather than
    // leaving the turn with no file-editing guidance at all.
    instructions.push(
      "- Use OpenCode `apply_patch` for file-content changes; do not use shell, Python, or heredocs to change file content while it is available. Cursor-native write and edit requests are accepted and converted to `apply_patch` automatically.",
    )
  }
  if (hostToolDialectFromTools(tools).filePathKey === "path") {
    instructions.push(
      "- OpenCode file tools take `path` as an absolute path under the workspace root above. Do not pass a project-relative path, and do not invent a different absolute prefix.",
    )
  }
  if (names.has("edit") || names.has("write") || names.has("apply_patch")) {
    instructions.push(
      "- Never use a read result as complete file content when it says the output is capped, partial, or requires another offset. Read the remaining ranges first, or make a targeted edit/patch from complete context; do not pass a partial read back as a whole-file replacement.",
    )
  }
  return [
    `OpenCode exposes these direct tools for this turn: ${[...names].map((name) => `\`${name}\``).join(", ")}.`,
    `Workspace root: ${JSON.stringify(workspaceRoot)}. Resolve workspace paths against exactly this root; never invent an absolute prefix, and verify uncertain paths with an available tool before using them.`,
    subagents.executor
      ? "Call only tools in that direct OpenCode list for ordinary host execution. Cursor-native Task/subagent requests are permitted because a compatible host executor is listed. Bridged Cursor interactions named below (AskQuestion, SwitchMode, CreatePlan, …) are not OpenCode/MCP catalog tools — raise them normally and do not narrate that they are missing."
      : "Call only tools in that direct OpenCode list for ordinary host execution. Bridged Cursor interactions named below (AskQuestion, SwitchMode, CreatePlan, …) are not OpenCode/MCP catalog tools — raise them normally and do not narrate that they are missing. Other unlisted Cursor-native tools are not bridged; complete the work with the listed tools or explain the limitation without claiming a missing MCP tool.",
    ...(instructions.length > 0
      ? ["Use these OpenCode tools instead of equivalent Cursor-native UI interactions:"]
      : []),
    ...instructions,
    "Emit the actual tool call and wait for its result; never merely claim or summarize that a tool was used.",
    "A progress update such as \"Checking…\", \"Inspecting…\", or \"Let me look…\" is not a final answer.",
    "After progress narration, call a listed tool in the same turn; if no tool is needed, provide the complete user-facing answer before finishing.",
    "Never end a turn with progress narration alone.",
  ].join("\n")
}

/** Rough char→token estimate for mid-turn usage before TurnEnded arrives. */
export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0
  return Math.ceil(chars / 4)
}

/** Preserve exact request-local Cursor counters as diagnostics. */
export function cursorTurnEndedProviderMetadata(
  te: Record<string, unknown>,
  tokenDetails?: CursorConversationTokenDetails,
  contextSource?: CursorContextUsageSource,
): {
  cursor: {
    usageVersion: number
    inputTokensRaw: number
    outputTokensRaw: number
    cacheReadRaw: number
    cacheWriteRaw: number
    reasoningTokensRaw: number
    context?: ReturnType<typeof cursorContextUsageMetadata>
  }
} {
  return {
    cursor: {
      usageVersion: 3,
      inputTokensRaw: turnEndedCounter(te, "input_tokens"),
      outputTokensRaw: turnEndedCounter(te, "output_tokens"),
      cacheReadRaw: turnEndedCounter(te, "cache_read"),
      cacheWriteRaw: turnEndedCounter(te, "cache_write"),
      reasoningTokensRaw: turnEndedCounter(te, "reasoning_tokens"),
      ...(tokenDetails
        ? { context: cursorContextUsageMetadata(tokenDetails, contextSource) }
        : {}),
    },
  }
}

/**
 * Prior prompt turns for a seed ConversationStateStructure. Tool results must
 * never be replayed as assistant-authored prose: that teaches the model to
 * counterfeit `Tool result (...)` text instead of emitting a real tool call.
 * Normal rebases omit old results; compaction can retain all results and
 * interrupted continuations retain only the trailing live result suffix as
 * explicit OpenCode-host observations.
 */
export function extractPromptHistory(
  prompt: LanguageModelV3CallOptions["prompt"],
  options?: {
    preserveTrailingUser?: boolean
    toolResults?: "omit" | "all" | "trailing"
    /** The step's results are followed by mid-turn user messages as well as host notes. */
    trailingSteer?: boolean
    /** With `trailing`, earlier results of the step that must be replayed too. */
    keepToolCallIds?: ReadonlySet<string>
  },
): SeedHistoryMessage[] {
  const out: SeedHistoryMessage[] = []
  const toolResults = options?.toolResults ?? "omit"
  let trailingToolStart = prompt.length
  if (toolResults === "trailing") {
    // A rebased continuation may end with host notes (or a steer's messages) after the step's results.
    let notesStart = prompt.length
    while (
      notesStart > 0
      && (
        hostTailNote(prompt[notesStart - 1]!)
        || (options?.trailingSteer === true && plainUserText(prompt[notesStart - 1]!) !== undefined)
      )
    ) {
      notesStart--
    }
    trailingToolStart = notesStart
    while (trailingToolStart > 0 && prompt[trailingToolStart - 1]?.role === "tool") {
      trailingToolStart--
    }
    if (trailingToolStart === notesStart) trailingToolStart = prompt.length
  }
  for (let messageIndex = 0; messageIndex < prompt.length; messageIndex++) {
    const m = prompt[messageIndex]!
    if (m.role === "system") {
      if (typeof m.content === "string" && m.content.length > 0) {
        out.push({ role: "system", content: m.content })
      }
      continue
    }
    if (m.role === "user") {
      const text = extractUserText(m as unknown as Record<string, unknown>)
      if (text && text !== ".") out.push({ role: "user", content: text })
      continue
    }
    if (m.role === "assistant") {
      const text = extractAssistantHistoryText(m as unknown as Record<string, unknown>)
      if (text) appendSeedHistory(out, "assistant", text)
      continue
    }
    if (m.role === "tool" && Array.isArray(m.content)) {
      if (toolResults === "omit") continue
      const keptOnly = toolResults === "trailing" && messageIndex < trailingToolStart
      if (keptOnly && !options?.keepToolCallIds?.size) continue
      const results: string[] = []
      for (const part of m.content) {
        const p = part as unknown as Record<string, unknown>
        if (p.type !== "tool-result") continue
        const toolName = typeof p.toolName === "string" && p.toolName ? p.toolName : "tool"
        const toolCallId = typeof p.toolCallId === "string" ? p.toolCallId : ""
        if (keptOnly && !options?.keepToolCallIds?.has(toolCallId)) continue
        const result = toolResultOutputToText(p.output)
        results.push(formatSeedToolObservation({
          toolName,
          toolCallId,
          output: result.text,
          isError: result.isError,
        }))
      }
      if (results.length > 0) appendSeedHistory(out, "user", results.join("\n\n"))
    }
  }
  // Live user message is the Run action, not seed history.
  if (!options?.preserveTrailingUser && out.length > 0 && out[out.length - 1]!.role === "user") {
    out.pop()
  }
  return out
}

function formatSeedToolObservation(input: {
  toolName: string
  toolCallId: string
  output: string
  isError: boolean
}): string {
  const metadata = JSON.stringify({
    source: "opencode-tool",
    tool: input.toolName,
    callId: input.toolCallId,
    status: input.isError ? "error" : "completed",
  })
  return `OpenCode host observation ${metadata}:\n${input.output}`
}

function extractAssistantHistoryText(msg: Record<string, unknown>): string {
  const content = msg.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const texts: string[] = []
  for (const part of content) {
    const p = part as Record<string, unknown>
    if (p.type === "text" && typeof p.text === "string" && p.text.length > 0) {
      texts.push(p.text)
    }
  }
  return texts.join("\n")
}

function appendSeedHistory(
  out: SeedHistoryMessage[],
  role: SeedHistoryMessage["role"],
  content: string,
): void {
  if (!content) return
  const last = out[out.length - 1]
  if (last?.role === role) {
    last.content += `\n\n${content}`
    return
  }
  out.push({ role, content })
}

/** Share of the target context a foreign-history rebase may fill before compaction. */
export const FOREIGN_HISTORY_REBASE_CONTEXT_SHARE = 0.8

/**
 * A foreign-history rebase replays the full host history. When that cannot fit,
 * fail before opening a Run with an error hosts classify as context overflow
 * (HTTP 413 + "prompt is too long"), so the host compacts and retries.
 */
export function assertForeignHistoryRebaseFits(input: {
  modelInfo: ModelInfo | undefined
  cursorModelId: string
  maxMode: boolean
  history: SeedHistoryMessage[]
  systemPrompt: string | undefined
  userText: string
}): void {
  const documented = getDocumentedCursorModelContext(input.cursorModelId)
  const limit = input.maxMode
    ? (input.modelInfo?.maxContextForMaxMode ?? documented?.maxContextForMaxMode ?? 1_000_000)
    : (input.modelInfo?.maxContext ?? documented?.maxContext ?? 200_000)
  const chars = input.history.reduce((sum, message) => sum + message.content.length, 0)
    + (input.systemPrompt?.length ?? 0)
    + input.userText.length
  const tokens = estimateTokens(chars)
  const budget = Math.floor(limit * FOREIGN_HISTORY_REBASE_CONTEXT_SHARE)
  if (tokens <= budget) return
  trace(
    `foreign-history rebase too large: model=${input.cursorModelId} estimatedTokens=${tokens} ` +
      `budget=${budget} limit=${limit} → requesting host compaction`,
  )
  throw new APICallError({
    message: `prompt is too long: rebasing this session onto Cursor needs ~${tokens} tokens, ` +
      `over ${budget} of the ${limit}-token context`,
    url: "cursor://agent.v1.AgentService/Run",
    requestBodyValues: {},
    statusCode: 413,
    isRetryable: false,
  })
}

/** OpenCode session id header, if present. */
export function opencodeSessionKey(callOptions: LanguageModelV3CallOptions): string | undefined {
  const h = callOptions.headers ?? {}
  // OpenCode 2.x sends x-session-id / x-session-affinity / x-opencode-session
  // as the parent (or fork source) session so subagents share prompt-cache
  // affinity. Only x-opencode-session-id names the requesting session; keying
  // on the others makes a subagent take over its parent's Cursor conversation.
  // `x-opencode-session` is not a fallback: session requests always carry the
  // headers above, and OpenCode 2's stateless `generate.text` sends only a
  // fresh `x-opencode-session` id that no other request will ever share.
  const raw =
    h["x-opencode-session-id"] ??
    h["x-session-id"] ??
    h["X-Session-Id"] ??
    h["x-session-affinity"]
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim()
  return undefined
}

/**
 * Map OpenCode's session id header to the active Cursor conversation_id.
 * Compaction resets remint via bindConversationId; otherwise the binding is
 * sticky for the OpenCode session. Falls back to a random UUID with no header.
 */
export function resolveConversationId(callOptions: LanguageModelV3CallOptions): string {
  return bindConversationId(opencodeSessionKey(callOptions)).conversationId
}

export { sessionIdToUuid } from "./protocol/conversation-bind.js"

/**
 * Grow the held Run's advertised + permitted catalog from this `doStream`
 * call. Continuation skips `startSession`, so without this, exec #36 and
 * permission keep the freeze from Run open. MCP server ids stay those of the
 * Run's one merged-config load (`startSession`); a tool that connects later
 * still gets its identity from that set.
 */
export async function refreshHeldSessionToolCatalog(
  session: CursorSession,
  callOptions: LanguageModelV3CallOptions,
): Promise<void> {
  const sessionKey = session.openCodeSessionId
  const incomingTools = extractTools(callOptions)
  const providerOptions = callOptions.providerOptions?.cursor as Record<string, unknown> | undefined
  const compactionOption = providerOptions?.[CURSOR_COMPACTION_OPTION]
  const isCompaction = compactionOption === true || (
    compactionOption === undefined && !!sessionKey && isCompactionSession(sessionKey)
  )
  const toolState = await resolveTurnToolState({
    sessionKey,
    incomingTools,
    toolChoice: callOptions.toolChoice,
    isCompaction,
    abortSignal: callOptions.abortSignal,
  })
  // A standalone caller has no host session key for the process catalog cache.
  // Its held Run still owns an epoch: keep its prefix and append new names.
  const cachedTools = !sessionKey ? session.toolCatalog ?? [] : []
  const cachedNames = new Set(cachedTools.map(tool => tool.name))
  const advertisedTools = cachedTools.length > 0
    ? [...cachedTools, ...toolState.advertisedTools.filter(tool => !cachedNames.has(tool.name))]
    : toolState.advertisedTools
  const webToolAliases = buildCustomWebToolAliases(advertisedTools)
  const cursorTools = webToolAliases.advertisedTools
  const knownMcpServers = session.knownMcpServers ?? []
  const discoveredSubagentCatalog = extractHostSubagentCatalog(cursorTools)
  const contextSubagents = Array.isArray(session.requestContext.custom_subagents)
    ? session.requestContext.custom_subagents
        .map((agent) => agent && typeof agent === "object" && typeof (agent as Record<string, unknown>).name === "string"
          ? {
              name: (agent as Record<string, unknown>).name as string,
              description: typeof (agent as Record<string, unknown>).description === "string"
                ? (agent as Record<string, unknown>).description as string
                : undefined,
            }
          : undefined)
        .filter((agent): agent is { name: string; description: string | undefined } => !!agent)
    : []
  session.toolCatalog = sessionKey ? snapshotToolCatalog(sessionKey) : structuredClone(advertisedTools)
  session.toolDescriptors = toolsToDescriptors(cursorTools, "opencode", knownMcpServers)
  session.toolAliases = webToolAliases.aliases
  session.hostToolDialect = hostToolDialectFromTools(advertisedTools, session.hostToolDialect)
  session.subagentCatalog = {
    ...discoveredSubagentCatalog,
    agents: [...new Map(
      [...discoveredSubagentCatalog.agents, ...contextSubagents]
        .map((agent) => [agent.name, agent]),
    ).values()],
  }
  session.allowTools = toolState.allowTools
  session.permittedToolNames = new Set(
    toolState.allowTools
      ? incomingTools.map((tool) => tool.name).filter((name): name is string => !!name)
      : [],
  )
}

function extractTools(callOptions: LanguageModelV3CallOptions): OpencodeToolDef[] {
  const tools = callOptions.tools
  if (!tools || tools.length === 0) {
    trace("extractTools: callOptions.tools empty/missing")
    return []
  }
  const out: OpencodeToolDef[] = []
  for (const t of tools) {
    // LanguageModelV3FunctionTool always has type:"function". Be defensive in
    // case a middleware strips it or passes schema as parameters/schema.
    const any = t as {
      type?: string
      name?: string
      description?: string
      inputSchema?: unknown
      parameters?: unknown
      schema?: unknown
    }
    const schema = any.inputSchema ?? any.parameters ?? any.schema
    if (any.type === "function" || (any.name && schema !== undefined)) {
      if (!any.name) continue
      out.push({ name: any.name, description: any.description, inputSchema: schema })
    }
  }
  trace(`extractTools: ${tools.length} incoming → ${out.length} advertised [${out.map((t) => t.name).join(",")}]`)
  return out
}

/** Exported for tests — AI SDK V3 span ends that must precede finish / tool-call. */
export function spanEndParts(opts: {
  textStarted: boolean
  reasoningStarted: boolean
  textId: string
  reasoningId: string
}): Array<{ type: "text-end" | "reasoning-end"; id: string }> {
  const out: Array<{ type: "text-end" | "reasoning-end"; id: string }> = []
  if (opts.reasoningStarted) out.push({ type: "reasoning-end", id: opts.reasoningId })
  if (opts.textStarted) out.push({ type: "text-end", id: opts.textId })
  return out
}

/** UTF-16 name order for the first catalog freeze and for newcomers only. */
function toolsInFixedOrder<T extends { name?: string }>(tools: readonly T[]): T[] {
  return tools
    .map((tool) => ({ ...tool }))
    .sort((left, right) => {
      const a = left.name ?? ""
      const b = right.name ?? ""
      return a < b ? -1 : a > b ? 1 : 0
    })
}

/** Exported for tests — false for compaction/summary (no tools) and toolChoice none. */
export function computeAllowTools(
  toolCount: number,
  toolChoice: LanguageModelV3CallOptions["toolChoice"] | undefined,
): boolean {
  return toolCount > 0 && toolChoice?.type !== "none"
}

export async function resolveTurnToolState(input: {
  sessionKey?: string
  incomingTools: OpencodeToolDef[]
  toolChoice?: LanguageModelV3CallOptions["toolChoice"]
  isCompaction: boolean
  abortSignal?: AbortSignal
}): Promise<{ advertisedTools: OpencodeToolDef[]; allowTools: boolean }> {
  const { sessionKey, incomingTools, isCompaction } = input

  // Advertisement and permission are deliberately independent.
  //
  // Advertisement must stay byte-stable across every Run of a conversation or
  // the RequestContext changes shape and Cursor's prompt cache goes cold.
  //
  // OpenCode V1 *does* shrink the catalog on plan (edit denied → tools dropped
  // in request.ts resolveTools). Copying that into Cursor RequestContext costs
  // the whole tools prefix. Prefer: keep the epoch's fullest catalog for
  // advertisement; compute allowTools from what actually arrived this turn.
  //
  // A zero-tool call is never a smaller catalog — it is a lifecycle turn
  // (compaction, title generation) that re-advertises the last real catalog.
  // New tool names (MCP connect) append at the tail without rewriting
  // descriptors already frozen. Equal name-sets and host shrinks keep the
  // frozen advertisement and its order — schema/description churn must not
  // retokenize tools, and inserting a name that sorts earlier than `z` must
  // not reshuffle the prefix.
  //
  // On cold start the lifecycle Run may arrive before any catalog exists. For a
  // valid session key, wait until a sibling doStream publishes the first real
  // catalog; cancellation is the only escape.
  let advertisedTools: OpencodeToolDef[]
  if (incomingTools.length > 0) {
    if (sessionKey) {
      const cached = toolCatalogBySession.get(sessionKey)
      if (cached && cached.length > 0) {
        const cachedNames = new Set(cached.map((tool) => tool.name))
        const incomingNames = new Set(incomingTools.map((tool) => tool.name))
        const hasNew = [...incomingNames].some((name) => !cachedNames.has(name))
        if (hasNew) {
          const newcomers = toolsInFixedOrder(
            incomingTools.filter((tool) => !cachedNames.has(tool.name)),
          )
          const merged = [...cached, ...newcomers]
          rememberToolCatalog(sessionKey, merged)
          advertisedTools = merged
        } else {
          rememberToolCatalog(sessionKey, cached)
          advertisedTools = cached
        }
      } else {
        const initial = toolsInFixedOrder(incomingTools)
        rememberToolCatalog(sessionKey, initial)
        advertisedTools = initial
      }
    } else {
      advertisedTools = toolsInFixedOrder(incomingTools)
    }
  } else if (sessionKey) {
    const cached = toolCatalogBySession.get(sessionKey)
      ?? await waitForSiblingToolCatalog(sessionKey, input.abortSignal)
    advertisedTools = cached
  } else {
    advertisedTools = []
  }
  return {
    advertisedTools,
    allowTools: !isCompaction && computeAllowTools(incomingTools.length, input.toolChoice),
  }
}

export function resolveTurnConversationReset(input: {
  sessionKey?: string
  isCompaction: boolean
  historyRewrite?: boolean
  /** @deprecated Ignored — prompt identity never remints. Kept for call-site compat. */
  promptIdentity?: PromptIdentity
}): {
  reset: boolean
  reason?: "compaction" | "post-compaction-rebase" | "history-rewrite"
} {
  const { sessionKey, isCompaction } = input
  if (isCompaction) {
    if (sessionKey) rememberPostCompactionRebase(sessionKey)
    return { reset: true, reason: "compaction" }
  }
  if (input.historyRewrite) {
    if (sessionKey) postCompactionRebaseBySession.delete(sessionKey)
    return { reset: true, reason: "history-rewrite" }
  }

  // Diagnostics only: accept promptIdentity for remember without reminting.
  if (sessionKey && input.promptIdentity) {
    const previous = promptIdentityBySession.get(sessionKey)
    rememberPromptIdentity(sessionKey, {
      ...previous,
      ...normalizePromptIdentity(input.promptIdentity),
    })
  }
  if (sessionKey && postCompactionRebaseBySession.delete(sessionKey)) {
    return { reset: true, reason: "post-compaction-rebase" }
  }
  return { reset: false }
}

export function resetTurnStateForTests(): void {
  for (const waiters of toolCatalogWaitersBySession.values()) {
    for (const waiter of waiters) waiter.cancel()
  }
  toolCatalogWaitersBySession.clear()
  toolCatalogBySession.clear()
  postCompactionRebaseBySession.clear()
  promptIdentityBySession.clear()
  mirroredTodosBySession.clear()
  resetContextEpochsForTests()
  cursorListsToolRequests = false
  hostInterrupts.clear()
}

function extractUserText(lastUser: Record<string, unknown> | undefined): string {
  if (!lastUser) return "."
  const content = lastUser.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const part of content) {
      const p = part as Record<string, unknown>
      if (p.type === "text" && typeof p.text === "string") texts.push(p.text)
    }
    if (texts.length > 0) return texts.join("\n")
  }
  return "."
}

function foldStreamParts(parts: V3Part[]): LanguageModelV3GenerateResult {
  let text = ""
  let reasoning = ""
  const content: LanguageModelV3GenerateResult["content"] = []
  let finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: undefined }
  let providerMetadata: LanguageModelV3GenerateResult["providerMetadata"]
  let usage: LanguageModelV3Usage = {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  }

  for (const part of parts) {
    if (part.type === "text-delta") text += part.delta
    else if (part.type === "reasoning-delta") reasoning += part.delta
    else if (part.type === "tool-call") {
      content.push({
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      })
    } else if (part.type === "finish") {
      finishReason = part.finishReason
      usage = part.usage
      providerMetadata = part.providerMetadata
    }
  }

  if (reasoning) content.unshift({ type: "reasoning", text: reasoning })
  if (text) content.unshift({ type: "text", text })

  return {
    content,
    finishReason,
    usage,
    warnings: [],
    ...(providerMetadata ? { providerMetadata } : {}),
  }
}
