import { CURSOR_API_HOST, CONNECT_PROTOCOL_VERSION, SERVER_CONFIG_PATH } from "../shared.js"
import { decodeFramePayload, encodeFrame, encodeGzipFrame, FLAG_END_STREAM, streamFrames } from "../protocol/framing.js"
import { createCursorChecksumHeader } from "../protocol/checksum.js"
import { getDeviceIds } from "../protocol/device-id.js"
import { resolveClientVersion } from "../protocol/client-version.js"
import { errorMessage, trace } from "../debug.js"
import {
  CursorLocalCancellationError,
  CursorProtocolError,
  CursorTransportError,
  cursorGrpcError,
  cursorHttpError,
  errorCode,
  CursorProviderError,
} from "../errors.js"
import { withAbortDeadline } from "../deadline.js"
import { processShared } from "../process-shared.js"
import http2 from "node:http2"
import type { Duplex } from "node:stream"
import type { TLSSocket } from "node:tls"
import { openProxiedTlsSocket, proxyEndpoint, resolveHttpsProxyUrl } from "./https-proxy.js"

const API_BASE = `https://${CURSOR_API_HOST}`
const DEFAULT_UNARY_TIMEOUT_MS = 5_000
const MAX_TIMER_MS = 2_147_483_647

function unaryTimeoutMs(operation: string, value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_UNARY_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
    throw new CursorProtocolError(
      `${operation} timeout must be a positive integer no greater than ${MAX_TIMER_MS}`,
      { code: "CURSOR_INVALID_TIMEOUT" },
    )
  }
  return timeoutMs
}

async function withUnaryDeadline<T>(
  operation: string,
  timeoutMs: number,
  timeoutCode: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return withAbortDeadline(
    timeoutMs,
    () => new CursorTransportError(`${operation} timed out after ${timeoutMs}ms`, {
      transient: true,
      replaySafe: true,
      code: timeoutCode,
    }),
    run,
  )
}

function resolveApiBaseURL(options: { apiBaseURL?: string; baseURL?: string }): string {
  return new URL(options.apiBaseURL ?? options.baseURL ?? API_BASE).origin
}

trace("connect.ts module loaded")

export function buildBaseHeaders(
  token: string,
  clientVersion: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const { machineId, macMachineId } = getDeviceIds()
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "connect-protocol-version": CONNECT_PROTOCOL_VERSION,
    "x-cursor-client-type": "cli",
    "x-cursor-client-version": clientVersion,
    "x-cursor-checksum": createCursorChecksumHeader(machineId, macMachineId),
    "x-ghost-mode": "true",
    ...extra,
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "x-request-id") delete headers[key]
  }
  headers["x-request-id"] = crypto.randomUUID()
  return headers
}

// ── Unary (AvailableModels) ──

export async function unaryAvailableModels(
  token: string,
  options: {
    apiBaseURL?: string
    baseURL?: string
    headers?: Record<string, string>
    timeoutMs?: number
  } = {},
): Promise<Record<string, unknown>> {
  const base = resolveApiBaseURL(options)
  const url = `${base}/aiserver.v1.AiService/AvailableModels`
  const timeoutMs = unaryTimeoutMs("AvailableModels", options.timeoutMs)
  return withUnaryDeadline(
    "AvailableModels",
    timeoutMs,
    "CURSOR_AVAILABLE_MODELS_TIMEOUT",
    async (signal) => {
      const clientVersion = await resolveClientVersion()
      const headers = buildBaseHeaders(token, clientVersion, options.headers)
      let res: Response
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            accept: "application/json",
          },
          // Request parameterized effort/context/fast variants like Cursor IDE.
          body: JSON.stringify({
            includeLongContextModels: true,
            useModelParameters: true,
            useCloudAgentEffortModes: true,
          }),
          signal,
        })
      } catch (cause) {
        throw new CursorTransportError("AvailableModels network request failed", {
          transient: true,
          replaySafe: true,
          code: errorCode(cause),
          cause,
        })
      }

      if (!res.ok) {
        throw await cursorHttpResponseError("AvailableModels failed:", res)
      }

      try {
        return (await res.json()) as Record<string, unknown>
      } catch (cause) {
        throw new CursorProtocolError("AvailableModels returned malformed JSON", { cause })
      }
    },
  )
}

// ── Unary (GetServerConfig) ──

/**
 * Cursor Run stream hosts from GetServerConfig / agentBaseURL.
 * Any HTTPS subdomain of cursor.sh is accepted — hostnames vary
 * (agentn.*, agent.*, agent-gcpp-*, api5 / api5lat, …) and may change.
 */
export function isAllowedAgentHost(hostname: string): boolean {
  return /^([a-z0-9-]+\.)+cursor\.sh$/i.test(hostname)
}

/**
 * Normalize a GetServerConfig agent URL to an https origin.
 * Returns null for missing, malformed, non-https, or non-*.cursor.sh hosts.
 */
export function normalizeAgentRunOrigin(raw: string | undefined): string | null {
  if (raw === undefined || raw === null) return null
  const trimmed = String(raw).trim()
  if (!trimmed) return null
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const parsed = new URL(withScheme)
    if (parsed.protocol !== "https:") return null
    if (parsed.username || parsed.password) return null
    if (!isAllowedAgentHost(parsed.hostname)) return null
    return parsed.origin
  } catch {
    return null
  }
}


/**
 * Fetch the Cursor server config (a Connect unary RPC on the API host) and
 * return the `agentUrlConfig.agentnUrl` field — the region-specific Run stream
 * origin the server routes this account/team to (e.g. `agentn.us.api5.cursor.sh`).
 *
 * Region-routed accounts can be silently rejected by the wrong regional host, so
 * this lookup fails closed instead of substituting any host on error. Any
 * authoritative `*.cursor.sh` origin from GetServerConfig is accepted.
 */
export async function fetchAgentUrl(
  token: string,
  options: {
    apiBaseURL?: string
    baseURL?: string
    telemetryEnabled?: boolean
    timeoutMs?: number
  } = {},
): Promise<string> {
  const base = resolveApiBaseURL(options)
  const url = `${base}${SERVER_CONFIG_PATH}`
  const timeoutMs = unaryTimeoutMs("GetServerConfig", options.timeoutMs)
  return withUnaryDeadline(
    "GetServerConfig",
    timeoutMs,
    "CURSOR_AGENT_URL_TIMEOUT",
    async (signal) => {
      const clientVersion = await resolveClientVersion()
      // Match Cursor CLI: GetServerConfig uses base headers only — session headers belong on Run.
      const headers = buildBaseHeaders(token, clientVersion)

      trace(`GetServerConfig POST ${url}`)
      let res: Response
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ telem_enabled: options.telemetryEnabled ?? false }),
          signal,
        })
      } catch (cause) {
        throw new CursorTransportError("GetServerConfig network request failed", {
          transient: true,
          replaySafe: true,
          code: errorCode(cause),
          cause,
        })
      }

      if (!res.ok) {
        throw await cursorHttpResponseError("GetServerConfig failed:", res)
      }

      let body: Record<string, unknown>
      try {
        body = (await res.json()) as Record<string, unknown>
      } catch (cause) {
        throw new CursorProtocolError("GetServerConfig returned malformed JSON", { cause })
      }
      const cfg = body.agentUrlConfig as { agentnUrl?: string; agentUrl?: string } | undefined
      const raw = cfg?.agentnUrl || cfg?.agentUrl
      const normalized = normalizeAgentRunOrigin(raw)
      trace(
        `GetServerConfig reply: agentnUrl=${cfg?.agentnUrl ?? "<missing>"} ` +
          `agentUrl=${cfg?.agentUrl ?? "<missing>"} → ${normalized ?? "<invalid>"}`,
      )
      if (!normalized) {
        throw new CursorProtocolError(
          raw
            ? "GetServerConfig returned an invalid Cursor agent URL"
            : "GetServerConfig response missing agentUrlConfig.agentnUrl",
        )
      }
      return normalized
    },
  )
}

// ── Bidi (Run stream) ──

// Cursor CLI sends Run messages with connect-es `sendCompression: gzip` and its default `compressMinBytes`.
export const RUN_COMPRESS_MIN_BYTES = 1024
// Origins that refused a gzip Run; their later Runs go uncompressed for the rest of the process.
const uncompressedRunOrigins = processShared("connect.uncompressed-run-origins.v1", () => new Set<string>())

/**
 * Cursor could not take a gzip-compressed Run: HTTP 415, `unimplemented` (how Connect and gRPC
 * refuse an unsupported encoding), or `invalid_argument`/`internal` naming the compression.
 */
export function isCompressionRejection(status: { httpStatus?: number; code?: string; message?: string }): boolean {
  if (status.httpStatus === 415) return true
  const code = status.code?.toLowerCase().replaceAll("-", "_")
  if (code === "unimplemented" || code === "12") return true
  return (code === "invalid_argument" || code === "internal" || code === "3" || code === "13")
    && /compress|gzip|encoding/i.test(status.message ?? "")
}

function endStreamStatus(frame: { flags: number; payload: Uint8Array }): { code?: string; message?: string } {
  try {
    const { error } = JSON.parse(new TextDecoder().decode(decodeFramePayload(frame))) as {
      error?: { code?: unknown; message?: unknown }
    }
    return {
      code: typeof error?.code === "string" ? error.code : undefined,
      message: typeof error?.message === "string" ? error.message : undefined,
    }
  } catch {
    return {}
  }
}

const gzipRunFrame = (msg: Uint8Array) => encodeGzipFrame(msg).catch((cause: unknown) => {
  trace(`Run compression: gzip failed (${cause instanceof Error ? cause.message : String(cause)}); sending the message uncompressed`)
  return encodeFrame(0x00, msg)
})
const compressedAhead = new WeakMap<Uint8Array, Uint8Array>()

/**
 * Compress a Run's opening request before its stream opens. The stream then writes it at once, so a refusal
 * or HTTP error can only arrive after it went out and still reaches the registered Run.
 */
export async function compressRunRequestAhead(request: Uint8Array): Promise<void> {
  if (request.length >= RUN_COMPRESS_MIN_BYTES && !compressedAhead.has(request)) {
    compressedAhead.set(request, await gzipRunFrame(request))
  }
}

export function resetRunCompressionForTests(...uncompressedOrigins: string[]): void {
  uncompressedRunOrigins.clear()
  for (const origin of uncompressedOrigins) uncompressedRunOrigins.add(origin)
}

export type BidiStream = {
  /** A promise while the message waits for compression, its own or an earlier one's; false when backpressured. */
  write(msg: Uint8Array): boolean | void | Promise<boolean>
  /** Cursor refused this Run for its gzip compression; the origin's later Runs go uncompressed. */
  compressionRejected?(): boolean
  /**
   * Resolves once a backpressured write has drained. There is no deadline, as
   * in Cursor CLI's transport: a stream error or close (remote or local) settles
   * it, and the read-idle watchdog bounds a stream that stops answering.
   */
  waitForDrain?(): Promise<void>
  end(): void
  frames(): AsyncIterable<{ flags: number; payload: Uint8Array }>
  /** Frames received that no reader has taken yet, removed from the stream; `destroy()` would discard them. */
  takeBufferedFrames?(): Array<{ flags: number; payload: Uint8Array }>
  destroy(): void
  isClosed(): boolean
  onTerminal(listener: (event: BidiTerminalEvent) => void): () => void
}

export type BidiTerminalEvent =
  | { kind: "remote-clean-close" }
  | { kind: "remote-error"; error: CursorProviderError }
  | { kind: "local-close" }

export class CursorRunInterruptedError extends CursorTransportError {
  constructor(message = "Cursor Run ended before turn_ended", options?: ErrorOptions) {
    super(message, {
      transient: true,
      replaySafe: true,
      cause: options?.cause,
      code: options?.cause === undefined ? "CURSOR_STREAM_CLOSED_EARLY" : undefined,
    })
    this.name = "CursorRunInterruptedError"
  }
}

export function cursorRunTerminationError(input: {
  responseStatus: number
  responseHeaders?: Record<string, unknown>
  responseTrailers?: Record<string, unknown>
  streamError?: Error | null
}): CursorProviderError {
  const headers = input.responseHeaders ?? {}
  const trailers = input.responseTrailers ?? {}
  if (input.streamError) {
    return new CursorRunInterruptedError(
      `Cursor Run transport interrupted: ${input.streamError.message}`,
      { cause: input.streamError },
    )
  }
  if (input.responseStatus !== 0 && input.responseStatus !== 200) {
    return cursorRunHttpError(input.responseStatus, headers)
  }
  const grpcStatus = trailers["grpc-status"] ?? headers["grpc-status"]
  if (grpcStatus !== undefined && String(grpcStatus) !== "0") {
    return cursorRunGrpcError(String(grpcStatus), headers, trailers)
  }
  return new CursorRunInterruptedError()
}

function withErrorMessageSuffix(error: CursorProviderError, suffix: string): CursorProviderError {
  if (suffix) error.message += suffix
  return error
}

async function cursorHttpResponseError(operation: string, res: Response): Promise<CursorProviderError> {
  const text = await res.text().catch(() => "")
  return withErrorMessageSuffix(
    cursorHttpError(operation, res.status),
    `${res.statusText ? ` ${res.statusText}` : ""}${text ? ` - ${text.slice(0, 200)}` : ""}`,
  )
}

function cursorRunHttpError(
  statusCode: number,
  headers: Record<string, unknown>,
): CursorProviderError {
  return withErrorMessageSuffix(
    cursorHttpError("Cursor Run failed by remote:", statusCode),
    ` ${JSON.stringify(stripPseudo(headers))}`,
  )
}

function cursorRunGrpcError(
  grpcStatus: string,
  headers: Record<string, unknown>,
  trailers: Record<string, unknown>,
): CursorProviderError {
  const message = trailers["grpc-message"] ?? headers["grpc-message"]
  return withErrorMessageSuffix(
    cursorGrpcError("Cursor Run failed by remote:", grpcStatus, {
      ...(message === undefined ? {} : { serverMessage: String(message) }),
    }),
    message === undefined ? "" : `: ${message}`,
  )
}

// Cache http2 sessions keyed by origin so a custom baseURL never reuses a
// connection opened to the default agent host — and vice versa.
const _http2Sessions = new Map<string, http2.ClientHttp2Session>()
const _http2SessionCreatedAt = new WeakMap<http2.ClientHttp2Session, number>()
const _http2SessionLastInboundAt = new WeakMap<http2.ClientHttp2Session, number>()
const _http2SessionGoawayLastStreamId = new WeakMap<http2.ClientHttp2Session, number>()
// When each Run stream still waiting for Cursor's response headers was opened.
const _http2SessionAwaitingAnswer = new WeakMap<http2.ClientHttp2Session, Map<http2.ClientHttp2Stream, number>>()
// A Run stream on the session closed after a live window without Cursor's answer; cleared by a ping reply.
const _http2SessionAnswerStalled = new WeakSet<http2.ClientHttp2Session>()
const _http2SessionTransportLost = new WeakSet<http2.ClientHttp2Session>()
const _http2SessionListenerCleanup = new WeakMap<http2.ClientHttp2Session, () => void>()
// As in Cursor CLI's transport (@connectrpc/connect-node 1.6.1
// Http2SessionManager), a cached session keeps the process alive only while a
// Run stream or a reuse ping is live on it: unref'd once connected, ref'd while
// it holds one. A Run held open on a pending exec keeps its stream, so it stays
// ref'd; an idle session would otherwise stop a headless host from exiting.
const _http2SessionHolds = new WeakMap<http2.ClientHttp2Session, number>()
// Validation and connect work for the same origin shares one Promise.
const _http2Connecting = new Map<string, Promise<http2.ClientHttp2Session>>()

// Bound the time we'll wait for the initial connect. Without this, a dead or
// unreachable host (DNS failure, network partition) hangs the provider forever
// because the 'connect' / 'error' event may never fire.
const CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_SESSION_PING_TIMEOUT_MS = 5_000
const DEFAULT_READ_IDLE_MS = 120_000
export const HTTP2_SESSION_MAX_AGE_MS = 15 * 60_000
// Cursor CLI pings an agent connection before use only after 10 s without a response or ping reply.
export const HTTP2_SESSION_LIVE_WINDOW_MS = 10_000
// Cursor CLI's agent connections (connect-node Http2SessionManager, pingIdleConnection) are pinged
// 10 s after the last PING answer, busy or idle, and dropped when an answer takes 20 s.
export const HTTP2_KEEPALIVE_INTERVAL_MS = 10_000
export const HTTP2_KEEPALIVE_TIMEOUT_MS = 20_000
// A timer this late means the event loop stalled, and the PING answer may still be unread.
const KEEPALIVE_STALL_GRACE_MS = 1_000
// Streams above a GOAWAY's last stream id were never processed; a run of drains still ends somewhere.
const MAX_GOAWAY_RESENDS = 3
let keepaliveIntervalMs = HTTP2_KEEPALIVE_INTERVAL_MS
let keepaliveTimeoutMs = HTTP2_KEEPALIVE_TIMEOUT_MS
// Origins whose server sent GOAWAY too_many_pings: Cursor CLI then doubles its interval.
const _keepaliveIntervalScale = new Map<string, number>()
const _http2KeepaliveStarted = new WeakSet<http2.ClientHttp2Session>()
// When a Run upload on the session last drained: the peer takes data, so the connection is alive.
const _http2SessionUploadProgressAt = new WeakMap<http2.ClientHttp2Session, number>()
// A PING written after a large upload waits behind it in the socket buffers, so its answer can lag a live
// uplink by many seconds while Cursor sends only flow-control frames we cannot observe.
const LARGE_UPLOAD_BYTES = 64 * 1024
const _http2SessionLargeUploadAt = new WeakMap<http2.ClientHttp2Session, number>()
// Run streams on the session with a write still waiting for 'drain'; one write can take longer than the timeout.
const _http2SessionBlockedUploads = new WeakMap<http2.ClientHttp2Session, Set<http2.ClientHttp2Stream>>()

function noteBlockedUpload(session: http2.ClientHttp2Session, stream: http2.ClientHttp2Stream): void {
  let blocked = _http2SessionBlockedUploads.get(session)
  if (!blocked) {
    blocked = new Set()
    _http2SessionBlockedUploads.set(session, blocked)
  }
  if (blocked.has(stream)) return
  blocked.add(stream)
  const unblock = () => {
    blocked.delete(stream)
    stream.removeListener("drain", unblock)
    stream.removeListener("close", unblock)
  }
  stream.once("drain", unblock)
  stream.once("close", unblock)
}
// Several Runs share each session. Node and Bun count its unsent bytes
// against maxSessionMemory (10 MB by default) and, once over it, fail every new
// stream with ENHANCE_YOUR_CALM (Bun before sending it, Node by refusing its
// response headers); Node also fails a single write over it while the uplink
// holds the bytes back. Run requests and KV replies run to many megabytes, and
// the provider holds those bytes anyway, so the limit only adds a failure.
// 256 MB clears the 100 MiB checkpoint transfer budget with room to spare.
// Cursor CLI's transport sets no maxSessionMemory, so it keeps the default (#76).
// Node and Bun default to 64 KiB receive windows: Cursor's MB-sized set_blob frames then arrive at one window per RTT.
export const RUN_STREAM_WINDOW_BYTES = 8 * 1024 * 1024
export const RUN_SESSION_WINDOW_BYTES = 16 * 1024 * 1024
const RUN_SESSION_OPTIONS = {
  maxSessionMemory: 256,
  settings: { initialWindowSize: RUN_STREAM_WINDOW_BYTES },
} satisfies http2.ClientSessionOptions

export function shouldReuseHttp2Session(
  state: { destroyed: boolean; closed: boolean },
  createdAt: number,
  now = Date.now(),
): boolean {
  return !state.destroyed && !state.closed && now - createdAt < HTTP2_SESSION_MAX_AGE_MS
}

/** Whether a session that last received data at `lastInboundAt` can skip its health-check ping. */
export function receivedRecently(lastInboundAt: number | undefined, now = Date.now()): boolean {
  if (lastInboundAt === undefined) return false
  const idleMs = now - lastInboundAt
  return idleMs >= 0 && idleMs < HTTP2_SESSION_LIVE_WINDOW_MS
}

// Wall-clock time on purpose: a machine that slept counts the sleep as idle time.
function noteSessionInbound(session: http2.ClientHttp2Session): void {
  _http2SessionLastInboundAt.set(session, Date.now())
}

function trackRunAnswer(session: http2.ClientHttp2Session, stream: http2.ClientHttp2Stream): void {
  let awaiting = _http2SessionAwaitingAnswer.get(session)
  if (!awaiting) {
    awaiting = new Map()
    _http2SessionAwaitingAnswer.set(session, awaiting)
  }
  const openedAt = Date.now()
  awaiting.set(stream, openedAt)
  const settle = (answered: boolean) => {
    if (!awaiting.delete(stream)) return
    if (!answered && Date.now() - openedAt >= HTTP2_SESSION_LIVE_WINDOW_MS) _http2SessionAnswerStalled.add(session)
  }
  stream.once("response", () => settle(true))
  stream.once("close", () => settle(false))
}

/**
 * Whether Cursor has left a Run on `session` without response headers for a live window. Data
 * still arriving on its older Runs then does not show that Cursor takes new ones on it.
 */
export function awaitingRunAnswersForTests(session: http2.ClientHttp2Session): number {
  return _http2SessionAwaitingAnswer.get(session)?.size ?? 0
}

function runAnswerStalled(session: http2.ClientHttp2Session, now = Date.now()): boolean {
  if (_http2SessionAnswerStalled.has(session)) return true
  for (const openedAt of _http2SessionAwaitingAnswer.get(session)?.values() ?? []) {
    if (now - openedAt >= HTTP2_SESSION_LIVE_WINDOW_MS) return true
  }
  return false
}

let _testConnection: ((origin: string) => Duplex) | undefined

/** Test hook: open direct (non-proxy) Run connections over the given socket instead of TLS. */
export function routeHttp2ConnectionsForTests(createConnection?: (origin: string) => Duplex): void {
  _testConnection = createConnection
}

/** Resolve the HTTP/2 connect origin for a Run stream (exported for tests). */
export function resolveAgentOrigin(baseURL: string): string {
  const origin = normalizeAgentRunOrigin(baseURL)
  if (!origin) {
    throw new CursorProtocolError("Cursor Run stream requires an allowlisted Cursor agent base URL")
  }
  return origin
}

// Cursor's edge throttles a whole connection once many of its Run streams upload at once
// (tool results of 0.4–1.2 MB each drained at ~10 KB/s on one connection carrying 20 Runs while a
// fresh connection took them at MB/s), so Runs spread over a few connections per origin, as Cursor
// CLI processes each keep their own.
export const RUNS_PER_HTTP2_SESSION = 4
export const MAX_HTTP2_SESSIONS_PER_ORIGIN = 8
const _http2SessionKey = new WeakMap<http2.ClientHttp2Session, string>()
const _http2SessionRunStreams = new WeakMap<http2.ClientHttp2Session, number>()
const _http2LaneReservations = new Map<string, number>()

function laneKey(origin: string, lane: number): string {
  return lane === 0 ? origin : `${origin}#lane${lane}`
}

function laneOrigin(key: string): string {
  return key.replace(/#lane\d+$/, "")
}

function laneLoad(key: string): number {
  const session = _http2Sessions.get(key)
  const streams = session && !session.destroyed && !session.closed ? _http2SessionRunStreams.get(session) ?? 0 : 0
  return streams + (_http2LaneReservations.get(key) ?? 0)
}

/** The first connection with room for another Run, or the least loaded one once all are full. */
function pickLane(origin: string): string {
  let best: { key: string; load: number } | undefined
  for (let lane = 0; lane < MAX_HTTP2_SESSIONS_PER_ORIGIN; lane++) {
    const key = laneKey(origin, lane)
    const load = laneLoad(key)
    if (load < RUNS_PER_HTTP2_SESSION) return key
    if (!best || load < best.load) best = { key, load }
  }
  return best!.key
}

function reserveLane(key: string): () => void {
  _http2LaneReservations.set(key, (_http2LaneReservations.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (_http2LaneReservations.get(key) ?? 1) - 1
    if (left > 0) _http2LaneReservations.set(key, left)
    else _http2LaneReservations.delete(key)
  }
}

export function openRunStreamsForTests(session: http2.ClientHttp2Session): number {
  return _http2SessionRunStreams.get(session) ?? 0
}

function trackRunStream(session: http2.ClientHttp2Session, stream: http2.ClientHttp2Stream): void {
  _http2SessionRunStreams.set(session, (_http2SessionRunStreams.get(session) ?? 0) + 1)
  stream.once("close", () => {
    const left = (_http2SessionRunStreams.get(session) ?? 1) - 1
    if (left > 0) _http2SessionRunStreams.set(session, left)
    else _http2SessionRunStreams.delete(session)
  })
}

function dropSession(key: string, session: http2.ClientHttp2Session): void {
  if (_http2Sessions.get(key) === session) _http2Sessions.delete(key)
  const own = _http2SessionKey.get(session)
  if (own !== undefined && _http2Sessions.get(own) === session) _http2Sessions.delete(own)
}

/**
 * Stop offering `session` for new Runs and close it so in-flight streams can
 * drain. Used by age rotation and a failed reuse ping — never
 * `destroy()`, which would abort every sibling Run multiplexed on the session
 * mid-output (those Runs cannot be replayed after visible activity).
 */
function retireCachedSession(origin: string, session: http2.ClientHttp2Session): void {
  dropSession(origin, session)
  try { session.close() } catch { /* already closed */ }
}

function holdHttp2Session(session: http2.ClientHttp2Session): void {
  const holds = _http2SessionHolds.get(session) ?? 0
  _http2SessionHolds.set(session, holds + 1)
  if (holds === 0) session.ref()
}

function releaseHttp2Session(session: http2.ClientHttp2Session): void {
  const holds = (_http2SessionHolds.get(session) ?? 0) - 1
  if (holds > 0) {
    _http2SessionHolds.set(session, holds)
    return
  }
  _http2SessionHolds.delete(session)
  if (!session.destroyed) session.unref()
}

/** Offer a connected session for new Runs; it stays unref'd until one holds it. */
function cacheReadySession(key: string, session: http2.ClientHttp2Session): void {
  if (!_http2SessionHolds.has(session)) session.unref()
  _http2SessionCreatedAt.set(session, Date.now())
  _http2SessionKey.set(session, key)
  _http2Sessions.set(key, session)
  startKeepalive(key, session)
}

/** Test hook: shorten the keepalive PING interval and timeout; no argument restores Cursor CLI's. */
export function setHttp2KeepaliveForTests(options?: { intervalMs: number; timeoutMs: number }): void {
  keepaliveIntervalMs = options?.intervalMs ?? HTTP2_KEEPALIVE_INTERVAL_MS
  keepaliveTimeoutMs = options?.timeoutMs ?? HTTP2_KEEPALIVE_TIMEOUT_MS
  _keepaliveIntervalScale.clear()
}

function keepaliveInterval(key: string): number {
  return keepaliveIntervalMs * (_keepaliveIntervalScale.get(laneOrigin(key)) ?? 1)
}

/** Close a session that no Run holds or is about to take once it reaches the rotation age. */
function retireAgedIdleSession(key: string, session: http2.ClientHttp2Session): boolean {
  if ((_http2SessionHolds.get(session) ?? 0) > 0 || (_http2LaneReservations.get(key) ?? 0) > 0) return false
  if (_http2Sessions.get(key) !== session) return false
  const createdAt = _http2SessionCreatedAt.get(session) ?? 0
  if (shouldReuseHttp2Session(session, createdAt)) return false
  trace(`h2 idle session retired at rotation age: origin=${key}`)
  retireCachedSession(key, session)
  return true
}

/**
 * Fails every stream on a connection that answered no PING and sent nothing else for the keepalive
 * timeout. Unlike a failed reuse ping, nothing can still arrive on it, so its Runs are not left to drain.
 */
function retireDeadSession(key: string, session: http2.ClientHttp2Session, silentMs: number): void {
  // Not a CursorProviderError: every stream gets this one object, and each Run's recovery mutates its own error.
  const error = Object.assign(
    new Error(`Cursor HTTP/2 connection answered no PING and sent nothing for ${silentMs}ms — connection presumed dead`),
    { code: "CURSOR_HTTP2_PING_TIMEOUT" },
  )
  trace(`h2 keepalive: ${error.message}: origin=${key}`)
  dropSession(key, session)
  _http2SessionTransportLost.add(session)
  try { session.destroy(error, http2.constants.NGHTTP2_CANCEL) } catch { /* already closed */ }
}

/**
 * Pings the session `keepaliveIntervalMs` after each answer for as long as it is open, draining ones
 * included. It is dead once a PING has waited `timeout - interval` and nothing — no PING answer, Run
 * data or upload progress — has arrived for `timeout`.
 */
function startKeepalive(key: string, session: http2.ClientHttp2Session): void {
  if (_http2KeepaliveStarted.has(session)) return
  _http2KeepaliveStarted.add(session)
  let timer: ReturnType<typeof setTimeout> | undefined
  let dueAt = 0
  let pingSentAt: number | undefined
  let stallGraced = false
  let stopped = false
  const stop = () => {
    stopped = true
    clearTimeout(timer)
    timer = undefined
  }
  session.once("close", stop)
  const arm = (delayMs: number, run: () => void) => {
    clearTimeout(timer)
    dueAt = Date.now() + Math.max(1, delayMs)
    timer = setTimeout(run, Math.max(1, delayMs))
    timer.unref?.()
  }
  const lastHeardAt = () => Math.max(
    _http2SessionLastInboundAt.get(session) ?? 0,
    _http2SessionUploadProgressAt.get(session) ?? 0,
  )
  const deadline = (sentAt: number) => Math.max(lastHeardAt(), sentAt - keepaliveIntervalMs) + keepaliveTimeoutMs
  const sendPing = () => {
    timer = undefined
    if (stopped || session.destroyed) return stop()
    if (retireAgedIdleSession(key, session)) return stop()
    const sentAt = Date.now()
    pingSentAt = sentAt
    stallGraced = false
    let accepted = false
    try {
      accepted = session.ping((error) => onAnswer(sentAt, error))
    } catch (error) {
      trace(`h2 keepalive ping not sent: origin=${key} err=${errorMessage(error)}`)
    }
    if (pingSentAt !== sentAt) return
    if (!accepted) {
      pingSentAt = undefined
      return arm(keepaliveInterval(key), sendPing)
    }
    arm(deadline(sentAt) - sentAt, checkDeadline)
  }
  const onAnswer = (sentAt: number, error: Error | null) => {
    if (stopped || pingSentAt !== sentAt) return
    pingSentAt = undefined
    if (error) {
      // Node cancels PINGs on a session closing after a GOAWAY; Cursor CLI's transport stops pinging it too.
      trace(`h2 keepalive stopped: origin=${key} err=${error.message}`)
      return stop()
    }
    noteSessionInbound(session)
    arm(keepaliveInterval(key), sendPing)
  }
  const checkDeadline = () => {
    const lateMs = Date.now() - dueAt
    timer = undefined
    if (lateMs > KEEPALIVE_STALL_GRACE_MS && !stallGraced) {
      stallGraced = true
      return arm(KEEPALIVE_STALL_GRACE_MS, checkDeadline)
    }
    // Reads already waiting on the socket run before an immediate.
    setImmediate(decide)
  }
  const decide = () => {
    if (stopped || pingSentAt === undefined || session.destroyed) return
    const remainingMs = deadline(pingSentAt) - Date.now()
    if (remainingMs > 0) return arm(remainingMs, checkDeadline)
    const uploadWindowMs = (_http2SessionBlockedUploads.get(session)?.size ?? 0) > 0
      ? keepaliveTimeoutMs
      : (_http2SessionLargeUploadAt.get(session) ?? 0) + keepaliveTimeoutMs - Date.now()
    if (uploadWindowMs > 0) {
      // Possibly only slow: new Runs go elsewhere, and its own Runs keep their watchdogs.
      if (_http2Sessions.get(key) === session) {
        trace(`h2 keepalive: PING unanswered behind a large upload — no new Runs on it: origin=${key}`)
        retireCachedSession(key, session)
      }
      return arm(uploadWindowMs, checkDeadline)
    }
    stop()
    retireDeadSession(key, session, Date.now() - Math.max(lastHeardAt(), pingSentAt - keepaliveIntervalMs))
  }
  arm(keepaliveInterval(key), sendPing)
}

/** Test cleanup for local HTTP/2 fixtures; production sessions stay process-cached. */
export function closeCachedHttp2SessionsForTests(): void {
  for (const session of _http2Sessions.values()) {
    _http2SessionListenerCleanup.get(session)?.()
    try { session.destroy() } catch { /* already closed */ }
  }
  _http2Sessions.clear()
  _http2Connecting.clear()
  _http2LaneReservations.clear()
}

function timeoutMs(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > MAX_TIMER_MS) {
    throw new CursorProtocolError(
      `${name} must be a positive integer no greater than ${MAX_TIMER_MS}`,
    )
  }
  return resolved
}

function toTransportError(value: unknown, fallback: string): CursorTransportError {
  if (value instanceof CursorTransportError) return value
  return new CursorTransportError(fallback, {
    transient: true,
    replaySafe: true,
    code: errorCode(value),
    cause: value,
  })
}

function installSessionInvalidation(
  origin: string,
  session: http2.ClientHttp2Session,
): void {
  const socket = session.socket
  let cleaned = false
  let removeSocketListeners: (() => void) | undefined
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    session.removeListener("close", onSessionClose)
    session.removeListener("goaway", onSessionGoaway)
    session.removeListener("error", onSessionError)
    removeSocketListeners?.()
    removeSocketListeners = undefined
    _http2SessionListenerCleanup.delete(session)
  }
  const onSessionClose = () => {
    trace(`h2 session closed: origin=${origin}`)
    dropSession(origin, session)
    cleanup()
  }
  const onSessionGoaway = (errorCode: number, lastStreamID: number, opaqueData?: Buffer) => {
    trace(`h2 session GOAWAY: origin=${origin} errorCode=${errorCode} lastStreamID=${lastStreamID}`)
    // A later GOAWAY must not raise the id (RFC 9113 §6.8); some servers still send a higher one.
    const previous = _http2SessionGoawayLastStreamId.get(session)
    _http2SessionGoawayLastStreamId.set(session, previous === undefined ? lastStreamID : Math.min(previous, lastStreamID))
    if (errorCode === http2.constants.NGHTTP2_ENHANCE_YOUR_CALM && opaqueData?.toString("ascii") === "too_many_pings") {
      const scale = (_keepaliveIntervalScale.get(laneOrigin(origin)) ?? 1) * 2
      _keepaliveIntervalScale.set(laneOrigin(origin), scale)
      trace(`h2 keepalive interval doubled after too_many_pings: origin=${origin} intervalMs=${keepaliveIntervalMs * scale}`)
    }
    // Existing streams may drain, but future Runs must use a fresh session.
    dropSession(origin, session)
  }
  const onSessionError = (error: Error) => {
    trace(`h2 session error: origin=${origin} err=${error.message}`)
    _http2SessionTransportLost.add(session)
    dropSession(origin, session)
  }
  const onSocketEnd = () => {
    trace(`h2 socket ended: origin=${origin}`)
    _http2SessionTransportLost.add(session)
    dropSession(origin, session)
  }
  const onSocketClose = () => {
    trace(`h2 socket closed: origin=${origin}`)
    _http2SessionTransportLost.add(session)
    dropSession(origin, session)
  }

  session.once("close", onSessionClose)
  session.on("goaway", onSessionGoaway)
  // Keep an error listener until close so teardown errors cannot become an
  // unhandled EventEmitter error.
  session.on("error", onSessionError)
  if (socket) {
    socket.once("end", onSocketEnd)
    socket.once("close", onSocketClose)
    // Http2Session.socket is a lifecycle-bound proxy. Looking up methods after
    // detach throws ERR_HTTP2_SOCKET_UNBOUND, so bind removers while attached.
    const removeEndListener = socket.removeListener.bind(socket, "end", onSocketEnd)
    const removeCloseListener = socket.removeListener.bind(socket, "close", onSocketClose)
    removeSocketListeners = () => {
      try { removeEndListener() } catch { /* teardown is best-effort */ }
      try { removeCloseListener() } catch { /* teardown is best-effort */ }
    }
  }
  _http2SessionListenerCleanup.set(session, cleanup)
}

/** Node-runtime regression hook; production callers use getSession(). */
export function installSessionInvalidationForTests(
  origin: string,
  session: http2.ClientHttp2Session,
): void {
  installSessionInvalidation(origin, session)
}

/** Node-runtime regression hook: cache a connected local session for `origin`. */
export function cacheHttp2SessionForTests(
  origin: string,
  session: http2.ClientHttp2Session,
): void {
  // Tests re-cache one client per turn; replace its listeners rather than stack them.
  _http2SessionListenerCleanup.get(session)?.()
  installSessionInvalidation(origin, session)
  cacheReadySession(origin, session)
}

function invalidateSession(origin: string, session: http2.ClientHttp2Session): void {
  dropSession(origin, session)
  _http2SessionListenerCleanup.get(session)?.()
  try { session.destroy() } catch { /* already closed */ }
}

function validateCachedSession(
  session: http2.ClientHttp2Session,
  pingTimeoutMs: number,
): Promise<void> {
  if (session.destroyed || session.closed) {
    return Promise.reject(new CursorTransportError("Cursor HTTP/2 cached session is already closed"))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      session.removeListener("close", onClosed)
      session.removeListener("goaway", onGoaway)
      session.removeListener("error", onError)
      if (error) reject(error)
      else resolve()
    }
    const onClosed = () => finish(new CursorTransportError("Cursor HTTP/2 cached session closed during ping"))
    const onGoaway = () => finish(new CursorTransportError("Cursor HTTP/2 cached session received GOAWAY during ping"))
    const onError = (error: Error) => finish(toTransportError(error, "Cursor HTTP/2 cached session ping failed"))
    const timer = setTimeout(() => {
      finish(new CursorTransportError(`Cursor HTTP/2 cached session ping timed out after ${pingTimeoutMs}ms`))
    }, pingTimeoutMs)
    timer.unref?.()
    session.once("close", onClosed)
    session.once("goaway", onGoaway)
    session.once("error", onError)
    try {
      const accepted = session.ping((error) => {
        if (error) finish(toTransportError(error, "Cursor HTTP/2 cached session ping failed"))
        else finish()
      })
      if (!accepted) finish(new CursorTransportError("Cursor HTTP/2 cached session refused a health-check ping"))
    } catch (error) {
      finish(toTransportError(error, "Cursor HTTP/2 cached session ping failed"))
    }
  })
}

function raiseSessionWindow(session: http2.ClientHttp2Session): void {
  try {
    session.setLocalWindowSize(RUN_SESSION_WINDOW_BYTES)
  } catch (error) {
    trace(`h2 session window not raised: ${errorMessage(error)}`)
  }
}

function connectSession(key: string): Promise<http2.ClientHttp2Session> {
  const origin = laneOrigin(key)
  return new Promise((resolve, reject) => {
    let settled = false
    let session: http2.ClientHttp2Session | undefined
    let tunnelSocket: TLSSocket | undefined
    const abort = new AbortController()

    const clearConnectTimer = () => {
      clearTimeout(timer)
    }
    const detachSessionListeners = () => {
      if (!session) return
      session.removeListener("error", onError)
      session.removeListener("close", onClose)
      session.removeListener("connect", onConnect)
    }
    const destroyTunnel = () => {
      try { tunnelSocket?.destroy() } catch { /* ignore */ }
      tunnelSocket = undefined
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearConnectTimer()
      try { abort.abort(error) } catch { /* ignore */ }
      detachSessionListeners()
      if (session) {
        dropSession(key, session)
        try { session.destroy() } catch { /* ignore */ }
      }
      destroyTunnel()
      reject(error)
    }
    const onError = (error: Error) => fail(toTransportError(error, "Cursor HTTP/2 connection failed"))
    const onClose = () => fail(new CursorTransportError(`HTTP/2 connection to ${origin} closed before connecting`))
    const onConnect = () => {
      if (settled || !session) return
      settled = true
      clearConnectTimer()
      detachSessionListeners()
      installSessionInvalidation(key, session)
      if (session.destroyed || session.closed) {
        const error = new CursorTransportError(`HTTP/2 connection to ${origin} closed while connecting`)
        invalidateSession(key, session)
        destroyTunnel()
        reject(error)
        return
      }
      // The TLS socket (if any) is owned by the HTTP/2 session from here on.
      tunnelSocket = undefined
      cacheReadySession(key, session)
      noteSessionInbound(session)
      raiseSessionWindow(session)
      trace(`h2 session connected: origin=${key} localWindow=${session.state?.localWindowSize ?? "?"}`)
      resolve(session)
    }
    const timer = setTimeout(() => {
      fail(new CursorTransportError(`HTTP/2 connect to ${origin} timed out after ${CONNECT_TIMEOUT_MS}ms`))
    }, CONNECT_TIMEOUT_MS)
    timer.unref?.()

    void (async () => {
      try {
        const { hostname, port: originPort } = new URL(origin)
        const targetPort = originPort ? Number(originPort) : 443
        const proxy = resolveHttpsProxyUrl(hostname, process.env, targetPort)
        if (proxy) {
          const endpoint = proxyEndpoint(proxy)
          trace(`h2 connect via HTTPS proxy: origin=${origin} proxy=${endpoint.host}:${endpoint.port}`)
          const tlsSocket = await openProxiedTlsSocket({
            proxy,
            targetHost: hostname,
            targetPort,
            signal: abort.signal,
          })
          if (settled) {
            try { tlsSocket.destroy() } catch { /* ignore */ }
            return
          }
          tunnelSocket = tlsSocket
          session = http2.connect(origin, {
            ...RUN_SESSION_OPTIONS,
            createConnection: () => tlsSocket,
          })
        } else if (_testConnection) {
          const createTestConnection = _testConnection
          session = http2.connect(origin, {
            ...RUN_SESSION_OPTIONS,
            createConnection: () => createTestConnection(origin),
          })
        } else {
          session = http2.connect(origin, RUN_SESSION_OPTIONS)
        }
        if (settled) {
          try { session.destroy() } catch { /* ignore */ }
          destroyTunnel()
          return
        }
        session.on("error", onError)
        session.once("close", onClose)
        session.once("connect", onConnect)
      } catch (error) {
        fail(toTransportError(error, "Cursor HTTP/2 connection failed"))
      }
    })()
  })
}

export function getSession(
  baseURL: string,
  options: { pingTimeoutMs?: number } = {},
): Promise<http2.ClientHttp2Session> {
  return acquireSession(baseURL, options).then((lease) => {
    lease.release()
    return lease.session
  })
}

/**
 * `verified`: the session was just connected or answered a ping, rather than reused on recent traffic alone.
 * `release`: the Run has opened its stream (or given up), so it no longer reserves room on the session.
 */
type SessionLease = { session: http2.ClientHttp2Session; verified: boolean; release: () => void }

function acquireSession(
  baseURL: string,
  options: { pingTimeoutMs?: number },
): Promise<SessionLease> {
  const pingTimeoutMs = timeoutMs(
    "Cursor provider pingTimeoutMs",
    options.pingTimeoutMs,
    DEFAULT_SESSION_PING_TIMEOUT_MS,
  )
  const origin = pickLane(resolveAgentOrigin(baseURL))
  const release = reserveLane(origin)
  return acquireLaneSession(origin, pingTimeoutMs).then(
    (lease) => ({ ...lease, release }),
    (error: unknown) => {
      release()
      throw error
    },
  )
}

function acquireLaneSession(
  origin: string,
  pingTimeoutMs: number,
): Promise<{ session: http2.ClientHttp2Session; verified: boolean }> {
  const inflight = _http2Connecting.get(origin)
  if (inflight) return inflight.then((session) => ({ session, verified: true }))

  const cached = _http2Sessions.get(origin)
  const lastInboundAt = cached && _http2SessionLastInboundAt.get(cached)
  if (
    cached
    && shouldReuseHttp2Session(cached, _http2SessionCreatedAt.get(cached) ?? 0)
    && receivedRecently(lastInboundAt)
  ) {
    if (!runAnswerStalled(cached)) {
      trace(`h2 cached session reused without ping: origin=${origin} idleMs=${Date.now() - lastInboundAt!}`)
      return Promise.resolve({ session: cached, verified: false })
    }
    trace(`h2 cached session left a Run unanswered for ${HTTP2_SESSION_LIVE_WINDOW_MS}ms — pinging it before reuse: origin=${origin}`)
  }

  const promise = (async () => {
    const existing = _http2Sessions.get(origin)
    if (existing) {
      const createdAt = _http2SessionCreatedAt.get(existing) ?? 0
      if (!shouldReuseHttp2Session(existing, createdAt)) {
        trace(`h2 session rotate: origin=${origin} ageMs=${Math.max(0, Date.now() - createdAt)}`)
        retireCachedSession(origin, existing)
      } else {
        try {
          holdHttp2Session(existing)
          try {
            await validateCachedSession(existing, pingTimeoutMs)
          } finally {
            releaseHttp2Session(existing)
          }
          if (_http2Sessions.get(origin) === existing && !existing.destroyed && !existing.closed) {
            trace(`h2 cached session ping ok: origin=${origin}`)
            noteSessionInbound(existing)
            _http2SessionAnswerStalled.delete(existing)
            return existing
          }
        } catch (error) {
          // Sibling Runs may still be streaming on this session; destroy() would
          // abort them mid-output, where they cannot be replayed.
          trace(`h2 cached session ping failed: origin=${origin} err=${(error as Error).message}`)
          retireCachedSession(origin, existing)
        }
      }
    }
    return connectSession(origin)
  })()
  _http2Connecting.set(origin, promise)
  const cleanup = () => {
    if (_http2Connecting.get(origin) === promise) _http2Connecting.delete(origin)
  }
  promise.then(cleanup, cleanup)
  return promise.then((session) => ({ session, verified: true }))
}

/** Process-wide order in which Run frames came off the network, before any reader takes them. */
const frameArrivals = new WeakMap<object, number>()
let lastArrival = 0

export function frameArrival(frame: object): number | undefined {
  return frameArrivals.get(frame)
}

export function lastFrameArrival(): number {
  return lastArrival
}

export function noteFrameArrivalForTests(frame: object): void {
  frameArrivals.set(frame, ++lastArrival)
}

export async function bidiRunStream(
  token: string,
  options: {
    signal?: AbortSignal
    baseURL: string
    headers?: Record<string, string>
    readIdleMs?: number
    pingTimeoutMs?: number
  },
): Promise<BidiStream> {
  const origin = resolveAgentOrigin(options.baseURL)
  const readIdleMs = timeoutMs(
    "Cursor provider readIdleMs",
    options.readIdleMs,
    DEFAULT_READ_IDLE_MS,
  )
  const sessionOptions = { pingTimeoutMs: options.pingTimeoutMs }
  const leasing = acquireSession(options.baseURL, sessionOptions)
  const [lease, clientVersion] = await Promise.all([
    leasing,
    resolveClientVersion().catch((error: unknown) => {
      leasing.then((pending) => pending.release(), () => {})
      throw error
    }),
  ])
  const compress = !uncompressedRunOrigins.has(origin)
  let compressionRejected = false
  const noteCompressionStatus = (status: Parameters<typeof isCompressionRejection>[0]) => {
    if (!compress || compressionRejected || !isCompressionRejection(status)) return
    compressionRejected = true
    uncompressedRunOrigins.add(origin)
    trace(`Run compression: Cursor refused a gzip Run ${JSON.stringify(status)}; later Runs to ${origin} go uncompressed`)
  }
  const noteCompressionHeaders = (h: Record<string, unknown>) => {
    const grpcStatus = h["grpc-status"]
    const grpcMessage = h["grpc-message"]
    noteCompressionStatus({
      httpStatus: h[":status"] === undefined ? undefined : Number(h[":status"]),
      code: grpcStatus === undefined ? undefined : String(grpcStatus),
      message: grpcMessage === undefined ? undefined : String(grpcMessage),
    })
  }
  let baseHeaders: Record<string, string>
  try {
    baseHeaders = buildBaseHeaders(token, clientVersion, options.headers)
  } catch (error) {
    lease.release()
    throw error
  }
  const headers = {
    ...baseHeaders,
    ":method": "POST",
    ":path": "/agent.v1.AgentService/Run",
    "content-type": "application/connect+proto",
    // decodeFramePayload only inflates gzip.
    "connect-accept-encoding": "gzip",
    ...(compress ? { "connect-content-encoding": "gzip" } : {}),
    // The CLI's streaming interceptor sets this on the bidi Run stream
    // (decompiled client.ts:1190). Without it Cursor may treat the stream as
    // non-streaming.
    "x-cursor-streaming": "true",
    "user-agent": "connect-es/1.6.1",
  }

  let session = lease.session
  // Each stream holds its own session until that stream closes, a replaced one included.
  const openStream = () => {
    const owner = session
    const opened = owner.request(headers as unknown as http2.OutgoingHttpHeaders, { endStream: false })
    trackRunAnswer(owner, opened)
    trackRunStream(owner, opened)
    holdHttp2Session(owner)
    opened.on("drain", () => _http2SessionUploadProgressAt.set(owner, Date.now()))
    opened.once("close", () => releaseHttp2Session(owner))
    return opened
  }
  // A Run keeps its frames until Cursor answers, so it can be sent again on a new connection when a
  // GOAWAY shows Cursor never processed its stream.
  let unanswered: Uint8Array[] | undefined = []
  // A Run on a session reused without its ping is also sent once more if that session turns out dead.
  let resendOnLoss = !lease.verified
  let resentAfterLoss = false
  let goawayResends = 0
  // Frames written while that new connection opens.
  let resending: Uint8Array[] | undefined
  const resendListeners = new Set<(resent: boolean) => void>()
  let streamGeneration = 0
  // Set at the stream's first terminal event: Node and Bun destroy a closed session (this Run's own
  // close, a GOAWAY, rotation or a failed ping) once its last stream ends, even one Cursor cancelled.
  let connectionLost = false
  let stream: http2.ClientHttp2Stream
  try {
    try {
      stream = openStream()
    } catch (error) {
      // Nothing was sent: a session that closed after it was leased can be left as safely as an unverified one.
      if (!resendOnLoss && !session.closed && !session.destroyed) throw error
      trace(`h2 Run stream did not open on a cached session (${errorMessage(error)}) — reconnecting`)
      dropSession(origin, session)
      resendOnLoss = false
      const replacement = await acquireSession(options.baseURL, sessionOptions)
      try {
        session = replacement.session
        resendOnLoss = !replacement.verified
        stream = openStream()
      } finally {
        replacement.release()
      }
    }
  } finally {
    lease.release()
  }

  let writable = true
  let locallyClosed = false
  let remotelyClosed = false
  let backpressured = false
  let responseStatus = 0
  let responseHeaders: Record<string, unknown> = {}
  let responseTrailers: Record<string, unknown> = {}
  let rawStreamError: unknown
  let streamFailure: CursorProviderError | null = null
  let terminalEvent: BidiTerminalEvent | undefined
  let terminalSettlementScheduled = false
  const terminalListeners = new Set<(event: BidiTerminalEvent) => void>()

  const inboundFrames: Array<{ flags: number; payload: Uint8Array }> = []
  const pendingChunks: Uint8Array[] = []
  let inboundEnded = false
  let inboundFailure: Error | undefined
  let inboundWaiter:
    | {
        resolve: (frame: { flags: number; payload: Uint8Array } | undefined) => void
        reject: (error: Error) => void
      }
    | undefined
  let readIdleTimer: ReturnType<typeof setTimeout> | undefined
  let inboundReaderStarted = false
  const abortSignal = options.signal
  let abortHandler: (() => void) | undefined

  const send = (frame: Uint8Array): boolean => {
    backpressured = !stream.write(frame)
    if (backpressured) noteBlockedUpload(session, stream)
    if (backpressured || frame.length >= LARGE_UPLOAD_BYTES) _http2SessionLargeUploadAt.set(session, Date.now())
    return !backpressured
  }

  const observedFailure = (): CursorProviderError | undefined => {
    if (streamFailure) return streamFailure
    if (responseStatus !== 0 && responseStatus !== 200) {
      streamFailure = cursorRunHttpError(responseStatus, responseHeaders)
      return streamFailure
    }
    const grpcStatus = responseTrailers["grpc-status"] ?? responseHeaders["grpc-status"]
    if (grpcStatus !== undefined && String(grpcStatus) !== "0") {
      streamFailure = cursorRunGrpcError(String(grpcStatus), responseHeaders, responseTrailers)
      return streamFailure
    }
    if (rawStreamError) {
      streamFailure = toTransportError(rawStreamError, "Cursor Run transport interrupted")
      return streamFailure
    }
    return undefined
  }
  const drainTerminalError = (event: BidiTerminalEvent): CursorProviderError => {
    if (event.kind === "local-close") {
      return new CursorLocalCancellationError("Cursor Run stream closed locally during drain")
    }
    if (event.kind === "remote-error") return event.error
    return observedFailure() ?? new CursorRunInterruptedError("Cursor Run stream ended before drain")
  }
  const settleTerminal = (event: BidiTerminalEvent) => {
    if (terminalEvent) return
    terminalEvent = event
    for (const listener of terminalListeners) {
      try { listener(event) } catch { /* observers cannot destabilize teardown */ }
    }
    terminalListeners.clear()
  }
  const clearReadIdleTimer = () => {
    if (readIdleTimer) clearTimeout(readIdleTimer)
    readIdleTimer = undefined
  }
  const cleanupTerminalResources = () => {
    clearReadIdleTimer()
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener("abort", abortHandler)
      abortHandler = undefined
    }
  }
  const finishInbound = (error?: Error) => {
    if (error) {
      inboundFailure = error
      pendingChunks.length = 0
    } else if (!inboundFailure) {
      inboundEnded = true
    }
    const waiter = inboundWaiter
    inboundWaiter = undefined
    if (!waiter) return
    if (inboundFailure) waiter.reject(inboundFailure)
    else waiter.resolve(undefined)
  }
  const stopInboundReader = () => {
    cleanupTerminalResources()
    if (inboundReaderStarted) {
      stream.removeListener("data", onInboundChunk)
      inboundReaderStarted = false
    }
  }
  const nextInboundFrame = (): Promise<{ flags: number; payload: Uint8Array } | undefined> => {
    const queued = inboundFrames.shift()
    if (queued) return Promise.resolve(queued)
    if (inboundFailure) return Promise.reject(inboundFailure)
    if (inboundEnded) return Promise.resolve(undefined)
    return new Promise((resolve, reject) => {
      inboundWaiter = { resolve, reject }
    })
  }
  const enqueueFrame = (frame: { flags: number; payload: Uint8Array }) => {
    const waiter = inboundWaiter
    inboundWaiter = undefined
    if (waiter) waiter.resolve(frame)
    else inboundFrames.push(frame)
  }
  const notifyResend = (resent: boolean) => {
    const listeners = [...resendListeners]
    resendListeners.clear()
    for (const listener of listeners) listener(resent)
  }
  // Why Cursor cannot have taken the Run: a GOAWAY excluded its stream, it refused the stream, or the
  // connection died before Cursor answered and no GOAWAY said the stream might still be processed.
  const notTakenByCursor = (): { reason: string; goaway: boolean } | undefined => {
    const goawayLastStreamId = _http2SessionGoawayLastStreamId.get(session)
    if (goawayLastStreamId !== undefined) {
      if (stream.id !== undefined && goawayLastStreamId >= stream.id) return undefined
      return { reason: `GOAWAY lastStreamID=${goawayLastStreamId} stream=${stream.id ?? "unsent"}`, goaway: true }
    }
    if (stream.rstCode === http2.constants.NGHTTP2_REFUSED_STREAM) return { reason: "stream refused", goaway: false }
    if (connectionLost) return { reason: "connection lost", goaway: false }
    return undefined
  }
  const resendAllowed = (refusal: { goaway: boolean }) =>
    refusal.goaway ? goawayResends < MAX_GOAWAY_RESENDS : resendOnLoss
  // Whether frames written to a failing stream may still go out on a new connection.
  const mayStillResend = (): boolean => {
    if (resending) return true
    if (!unanswered) return false
    if (resendOnLoss) return true
    const goawayLastStreamId = _http2SessionGoawayLastStreamId.get(session)
    return goawayLastStreamId !== undefined
      && (stream.id === undefined || stream.id > goawayLastStreamId)
      && goawayResends < MAX_GOAWAY_RESENDS
  }
  const resendOnNewConnection = async (refusal: { reason: string; goaway: boolean }) => {
    const frames = unanswered ?? []
    unanswered = undefined
    resending = frames
    if (refusal.goaway) goawayResends++
    else resentAfterLoss = true
    resendOnLoss = false
    streamGeneration++
    if (inboundReaderStarted) stream.removeListener("data", onInboundChunk)
    trace(
      `h2 Run stream failed before Cursor answered (${refusal.reason}) — ` +
        `sending it again on a new connection (${frames.length} frame(s))`,
    )
    // A refused stream leaves the connection serving other Runs, so it is only taken out of the cache.
    dropSession(origin, session)
    rawStreamError = undefined
    writable = true
    remotelyClosed = false
    connectionLost = false
    let next: http2.ClientHttp2Stream | undefined
    try {
      const replacement = await acquireSession(options.baseURL, sessionOptions)
      try {
        session = replacement.session
        // A GOAWAY resend onto another lane reused without its ping keeps the one resend after a loss.
        resendOnLoss = !replacement.verified && !resentAfterLoss
        if (!locallyClosed && !terminalEvent && !streamFailure) next = openStream()
      } finally {
        replacement.release()
      }
    } catch (error) {
      rawStreamError = error
      writable = false
    }
    resending = undefined
    if (!next) {
      notifyResend(false)
      scheduleTerminalSettlement()
      return
    }
    stream = next
    unanswered = frames
    attachStreamListeners(next)
    if (inboundReaderStarted) {
      next.on("data", onInboundChunk)
      armReadIdleWatchdog()
    }
    for (const frame of frames) send(frame)
    notifyResend(true)
  }
  const settleObservedTerminal = () => {
    terminalSettlementScheduled = false
    if (terminalEvent || resending) return
    if (locallyClosed) {
      finishInbound()
      stopInboundReader()
      settleTerminal({ kind: "local-close" })
      return
    }
    if (unanswered) {
      const refusal = streamFailure ? undefined : notTakenByCursor()
      if (refusal && resendAllowed(refusal)) {
        void resendOnNewConnection(refusal)
        return
      }
      unanswered = undefined
      notifyResend(false)
    }
    const failure = observedFailure()
    finishInbound(failure)
    stopInboundReader()
    settleTerminal(
      failure
        ? { kind: "remote-error", error: failure }
        : { kind: "remote-clean-close" },
    )
  }
  const scheduleTerminalSettlement = () => {
    if (terminalEvent || terminalSettlementScheduled) return
    terminalSettlementScheduled = true
    // HTTP/2 often emits end/aborted immediately before error/close. One turn
    // lets the strongest terminal metadata win.
    setImmediate(settleObservedTerminal)
  }
  const onReadIdleTimeout = () => {
    readIdleTimer = undefined
    if (locallyClosed || remotelyClosed || streamFailure) return
    streamFailure = new CursorTransportError(
      `Cursor Run stream read-idle timeout after ${readIdleMs}ms — connection presumed dead`,
      { transient: true, replaySafe: true, code: "CURSOR_READ_IDLE_TIMEOUT" },
    )
    writable = false
    finishInbound(streamFailure)
    stopInboundReader()
    settleTerminal({ kind: "remote-error", error: streamFailure })
    try { stream.destroy(streamFailure) } catch { /* already closing */ }
  }
  const armReadIdleWatchdog = () => {
    clearReadIdleTimer()
    if (locallyClosed || remotelyClosed || streamFailure) return
    readIdleTimer = setTimeout(onReadIdleTimeout, readIdleMs)
    readIdleTimer.unref?.()
  }
  const onInboundChunk = (chunk: Buffer | Uint8Array) => {
    armReadIdleWatchdog()
    noteSessionInbound(session)
    if (inboundEnded || inboundFailure) return
    pendingChunks.push(new Uint8Array(chunk))
    const merged = mergeBuffers(pendingChunks)
    const parsed = Array.from(streamFrames(merged))
    const consumed = parsed.reduce((sum, frame) => sum + 5 + frame.payload.length, 0)
    pendingChunks.length = 0
    if (consumed < merged.length) pendingChunks.push(merged.subarray(consumed))
    for (const frame of parsed) {
      // Readers gunzip the payload of this same object, so the number reaches the decoded frame.
      frameArrivals.set(frame, ++lastArrival)
      if (compress && frame.flags & FLAG_END_STREAM) noteCompressionStatus(endStreamStatus(frame))
      enqueueFrame(frame)
    }
  }
  const startInboundReader = () => {
    if (inboundReaderStarted || locallyClosed || remotelyClosed || streamFailure) return
    inboundReaderStarted = true
    stream.on("data", onInboundChunk)
    armReadIdleWatchdog()
  }

  // Capture the HTTP/2 response status/headers and any stream-level error.
  // Without this, a non-200 or RST_STREAM surfaces as a silent clean end
  // (frames() just stops) — which looks exactly like "no response, no error".
  const attachStreamListeners = (target: http2.ClientHttp2Stream): void => {
    const generation = streamGeneration
    const owner = session
    const replaced = () => generation !== streamGeneration
    let terminalSeen = false
    const noteConnectionState = () => {
      if (terminalSeen) return
      terminalSeen = true
      connectionLost = owner.destroyed || _http2SessionTransportLost.has(owner)
    }
    target.on("response", (h: Record<string, unknown>) => {
      if (replaced()) return
      unanswered = undefined
      noteSessionInbound(owner)
      responseHeaders = h
      responseStatus = h[":status"] !== undefined ? Number(h[":status"]) : 0
      trace(`h2 response: status=${responseStatus} headers=${JSON.stringify(stripPseudo(h))}`)
      noteCompressionHeaders(h)
    })
    target.on("trailers", (h: Record<string, unknown>) => {
      if (replaced()) return
      noteSessionInbound(owner)
      responseTrailers = h
      trace(`h2 trailers: ${JSON.stringify(stripPseudo(h))}`)
      noteCompressionHeaders(h)
    })
    target.on("error", (err: Error) => {
      if (replaced()) return
      noteConnectionState()
      writable = false
      // Bun 1.3 also reports our own CANCEL reset as a stream error while the
      // response is still open; it is not a failure of a Run we closed.
      if (locallyClosed) return
      rawStreamError = err
      trace(`h2 stream error: ${err?.name}: ${err?.message}`)
      scheduleTerminalSettlement()
    })
    target.on("aborted", () => {
      if (replaced()) return
      noteConnectionState()
      writable = false
      // Node and Bun also emit `aborted` for our own CANCEL reset while the
      // request side is still open; every local close sets the flag first.
      if (locallyClosed) return
      rawStreamError ??= new CursorTransportError("Cursor Run stream aborted by remote", {
        transient: true,
        replaySafe: true,
        rstCode: target.rstCode,
        code: "ERR_HTTP2_STREAM_CANCEL",
      })
      scheduleTerminalSettlement()
    })
    target.on("end", () => {
      if (replaced()) return
      noteConnectionState()
      writable = false
      scheduleTerminalSettlement()
    })
    target.on("close", () => {
      if (replaced()) return
      noteConnectionState()
      writable = false
      remotelyClosed = !locallyClosed
      if (remotelyClosed) {
        dropSession(origin, owner)
        // Stop assigning sibling Runs to a connection that remotely lost one
        // of its streams. close() drains existing streams without destroying
        // them; the next Run opens a fresh HTTP/2 session.
        try { owner.close() } catch { /* already closed */ }
      }
      trace(
        `h2 stream closed (status=${responseStatus}, local=${locallyClosed}, ` +
          `err=${rawStreamError instanceof Error ? rawStreamError.message : "none"})`,
      )
      scheduleTerminalSettlement()
    })
  }
  attachStreamListeners(stream)

  // Reset with CANCEL, as Cursor CLI's transport does for an aborted call
  // (@connectrpc/connect-node 1.6.1). A plain close() leaves a stream whose
  // request write is still buffered open for good, which also keeps its
  // session held and the process alive.
  const closeLocally = () => {
    try { stream.close(http2.constants.NGHTTP2_CANCEL) } catch { /* already closing */ }
  }

  if (abortSignal) {
    abortHandler = () => {
      if (!locallyClosed) {
        locallyClosed = true
        writable = false
        inboundFrames.length = 0
        pendingChunks.length = 0
        finishInbound()
        stopInboundReader()
        settleTerminal({ kind: "local-close" })
        closeLocally()
      }
    }
    abortSignal.addEventListener("abort", abortHandler, { once: true })
    if (abortSignal.aborted) abortHandler()
  }

  startInboundReader()

  const failing = () => !writable || remotelyClosed || stream.closed || stream.destroyed
  // While the Run may still go out on a new connection, its frames wait for that decision.
  const resendQueue = (): Uint8Array[] | undefined => {
    if (locallyClosed || terminalEvent) return undefined
    return resending ?? (failing() && mayStillResend() ? unanswered : undefined)
  }
  const assertWritable = () => {
    if (!failing() || resendQueue()) return
    if (locallyClosed) {
      throw new CursorLocalCancellationError("Cursor Run stream is closed locally")
    }
    throw observedFailure() ?? new CursorRunInterruptedError("Cursor Run stream is no longer writable")
  }
  const writeFrame = (frame: Uint8Array): boolean => {
    const queue = resendQueue()
    if (queue) {
      // Goes out with the rest of the Run if it is sent again, and is dropped with it otherwise.
      queue.push(frame)
      return true
    }
    try {
      const accepted = send(frame)
      unanswered?.push(frame)
      return accepted
    } catch (cause) {
      rawStreamError = cause
      streamFailure = toTransportError(cause, "Cursor Run stream write failed")
      streamFailure.replaySafe = false
      writable = false
      scheduleTerminalSettlement()
      throw streamFailure
    }
  }
  // Messages go out in write order: one written while another compresses waits behind it.
  let queuedWrites: Promise<boolean> | undefined

  return {
    write(msg: Uint8Array) {
      assertWritable()
      const gzip = compress && msg.length >= RUN_COMPRESS_MIN_BYTES
      const ready = gzip ? compressedAhead.get(msg) : undefined
      if ((!gzip || ready) && !queuedWrites) return writeFrame(ready ?? encodeFrame(0x00, msg))
      const queued = Promise.resolve(queuedWrites).catch(() => false).then(async () => {
        const frame = gzip ? await gzipRunFrame(msg) : encodeFrame(0x00, msg)
        if (locallyClosed) throw new CursorLocalCancellationError("Cursor Run stream is closed locally")
        // Cursor ended the Run meanwhile. As for a message buffered just before that, the Run's own error reports it.
        if (failing() && !resendQueue()) return true
        return writeFrame(frame)
      })
      queuedWrites = queued
      const settled = () => {
        if (queuedWrites === queued) queuedWrites = undefined
      }
      queued.then(settled, settled)
      return queued
    },
    compressionRejected: () => compressionRejected,
    waitForDrain() {
      if (!backpressured) return Promise.resolve()
      if (terminalEvent) return Promise.reject(drainTerminalError(terminalEvent))
      return new Promise<void>((resolve, reject) => {
        let settled = false
        let target = stream
        let failLater: (() => void) | undefined
        const detach = () => {
          target.removeListener("drain", onDrain)
          target.removeListener("error", onError)
          target.removeListener("close", onClose)
          terminalListeners.delete(onTerminal)
          resendListeners.delete(onResend)
        }
        const attach = () => {
          target.once("drain", onDrain)
          target.once("error", onError)
          target.once("close", onClose)
          terminalListeners.add(onTerminal)
          if (unanswered || resending) resendListeners.add(onResend)
        }
        const finish = (error?: CursorProviderError) => {
          if (settled) return
          settled = true
          detach()
          if (error) reject(error)
          else resolve()
        }
        const onDrain = () => {
          backpressured = false
          finish()
        }
        // The Run's end settles it too: Node holds back `close` while a write
        // is buffered, and a response can end while the request is still
        // blocked, after which the read-idle watchdog no longer runs.
        const onTerminal = (event: BidiTerminalEvent) => finish(drainTerminalError(event))
        const failOnError = (cause: Error) => {
          streamFailure ??= toTransportError(cause, "Cursor Run stream drain failed")
          streamFailure.replaySafe = false
          finish(streamFailure)
        }
        const failOnClose = () => {
          finish(
            locallyClosed
              ? new CursorLocalCancellationError("Cursor Run stream closed locally during drain")
              : observedFailure() ?? new CursorRunInterruptedError("Cursor Run stream closed before drain"),
          )
        }
        // While the Run may still go out on a new connection, that decision settles the wait.
        const mayResend = () => !locallyClosed && mayStillResend()
        const onError = (cause: Error) => {
          if (!mayResend()) return failOnError(cause)
          failLater ??= () => failOnError(cause)
        }
        const onClose = () => {
          if (!mayResend()) return failOnClose()
          failLater ??= failOnClose
        }
        const onResend = (resent: boolean) => {
          if (settled) return
          if (!resent) return (failLater ?? failOnClose)()
          detach()
          target = stream
          if (!backpressured) return finish()
          attach()
        }
        attach()
      })
    },
    end() {
      locallyClosed = true
      writable = false
      inboundFrames.length = 0
      pendingChunks.length = 0
      finishInbound()
      stopInboundReader()
      settleTerminal({ kind: "local-close" })
      // A blocked write cannot finish gracefully; discard it rather than leave
      // its stream and session referenced after the drain has been rejected.
      if (backpressured || queuedWrites) closeLocally()
      else stream.end()
    },
    async *frames() {
      try {
        while (true) {
          const frame = await nextInboundFrame()
          if (!frame) break
          trace(`frame yield: flags=0x${frame.flags.toString(16)} payload=${frame.payload.length}B`)
          yield frame
        }

        remotelyClosed = !locallyClosed
        if (locallyClosed) return

        // A clean HTTP/2 end before Cursor's turn_ended is still an interrupted
        // Run at the provider layer.
        throw observedFailure() ?? cursorRunTerminationError({
          responseStatus,
          responseHeaders,
          responseTrailers,
        })
      } catch (error) {
        if (locallyClosed) return
        if (error instanceof CursorProviderError) throw error
        throw toTransportError(
          error,
          `Cursor Run transport interrupted: ${error instanceof Error ? error.message : "unknown error"}`,
        )
      } finally {
        stopInboundReader()
      }
    },
    takeBufferedFrames() {
      return inboundFrames.splice(0)
    },
    destroy() {
      if (!locallyClosed) {
        locallyClosed = true
        writable = false
        inboundFrames.length = 0
        pendingChunks.length = 0
        finishInbound()
        stopInboundReader()
        settleTerminal({ kind: "local-close" })
      }
      // end() may already have half-closed the request. destroy() must still
      // reset the stream if the peer has left its response open.
      closeLocally()
    },
    isClosed() {
      if (resending) return locallyClosed
      return remotelyClosed || locallyClosed || stream.closed || stream.destroyed
    },
    onTerminal(listener) {
      if (terminalEvent) {
        try { listener(terminalEvent) } catch { /* observers cannot destabilize teardown */ }
        return () => {}
      }
      terminalListeners.add(listener)
      return () => terminalListeners.delete(listener)
    },
  }
}

function mergeBuffers(buffers: Uint8Array[]): Uint8Array {
  if (buffers.length === 0) return new Uint8Array(0)
  if (buffers.length === 1) return buffers[0]
  const total = buffers.reduce((s, b) => s + b.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const b of buffers) {
    merged.set(b, offset)
    offset += b.length
  }
  return merged
}

export function makeRequestId(): string {
  return crypto.randomUUID()
}

function stripPseudo(h: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(h)) {
    if (k.startsWith(":")) {
      if (k === ":status") out[k] = v
      continue
    }
    if (k === "authorization" || k === "x-cursor-checksum") {
      out[k] = "<redacted>"
      continue
    }
    out[k] = v
  }
  return out
}
