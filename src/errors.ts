import { APICallError } from "@ai-sdk/provider"

export type CursorErrorOrigin =
  | "local-cancel"
  | "transport"
  | "server"
  | "protocol"
  | "auth"

export type CursorErrorDetails = {
  /** `ErrorDetails.error` enum (#1); 0 when omitted, as protobuf decodes it. */
  error: number
  title?: string
  detail?: string
  isRetryable?: boolean
  /** `details.analytics_metadata.action_required` (#10 → #1). */
  actionRequired?: string
  /** `details.additional_info["providerStatusCode"]` (#7): the model provider's own HTTP status. */
  providerStatusCode?: string
}

export type CursorErrorDiagnostics = {
  statusCode?: number
  grpcStatus?: number | string
  rstCode?: number
  code?: string
  retryAfterMs?: number
  /** The message Cursor's error carried (Connect error envelope or `grpc-message`). */
  serverMessage?: string
  /** Cursor's decoded `aiserver.v1.ErrorDetails`. */
  cursorDetails?: CursorErrorDetails
}

export type CursorProviderErrorOptions = CursorErrorDiagnostics & {
  origin: CursorErrorOrigin
  transient: boolean
  replaySafe: boolean
  retryable?: boolean
  hostRetryable?: boolean
  cause?: unknown
}

/** Structured provider failure with retry and transport diagnostics. */
export class CursorProviderError extends Error {
  readonly origin: CursorErrorOrigin
  readonly transient: boolean
  replaySafe: boolean
  /**
   * The Run failed because Cursor could not restore the resumed checkpoint
   * (it requested blobs this client does not hold) before producing anything.
   * Recovery must reseed a new conversation instead of resuming that checkpoint.
   */
  checkpointUnusable?: boolean
  readonly statusCode?: number
  readonly grpcStatus?: number | string
  readonly rstCode?: number
  readonly code?: string
  readonly retryAfterMs?: number
  /** Cursor's classified verdict, or false once provider retries must stop. */
  readonly retryable?: boolean
  readonly serverMessage?: string
  readonly cursorDetails?: CursorErrorDetails
  /**
   * The provider stopped, but the host may send the turn again: the failed
   * attempt only showed text or reasoning, before any checkpoint. Cursor CLI
   * resends the same action in this case.
   */
  readonly hostRetryable?: boolean
  /** What the failed attempt did that a replay inside the Run would repeat. */
  replayBarrier?: "output-only" | "stateful"

  constructor(message: string, options: CursorProviderErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "CursorProviderError"
    this.origin = options.origin
    this.transient = options.transient
    this.replaySafe = options.replaySafe
    this.statusCode = options.statusCode
    this.grpcStatus = options.grpcStatus
    this.rstCode = options.rstCode
    this.code = options.code
    this.retryAfterMs = options.retryAfterMs
    this.retryable = options.retryable
    this.serverMessage = options.serverMessage
    this.cursorDetails = options.cursorDetails
    this.hostRetryable = options.hostRetryable
  }
}

/** Connect error code → HTTP status, per https://connectrpc.com/docs/protocol/#error-codes. */
const CONNECT_CODE_HTTP_STATUS: Readonly<Record<string, number>> = {
  canceled: 499,
  unknown: 500,
  invalid_argument: 400,
  deadline_exceeded: 504,
  not_found: 404,
  already_exists: 409,
  permission_denied: 403,
  resource_exhausted: 429,
  failed_precondition: 400,
  aborted: 409,
  out_of_range: 400,
  unimplemented: 501,
  internal: 500,
  unavailable: 503,
  data_loss: 500,
  unauthenticated: 401,
}

/** Status for a final failure whose Connect code maps to 5xx (internal, unknown, …). */
const NON_RETRYABLE_SERVER_STATUS = 400

/**
 * The error the host receives. Like Cursor CLI, a request Cursor declared not
 * retryable (see `cursorCliRetryable`), a spent/unsafe provider retry, or an
 * authentication failure ends the turn: it becomes an AI SDK `APICallError`
 * with `isRetryable: false` and the
 * conventional `x-should-retry: false` header, which OpenCode 2 checks first
 * (it retries a failure with no status or recognized code). OpenCode 1.x
 * ignores both and retries any status >= 500 or a message matching its retry
 * patterns, so the status is the Connect code's HTTP status capped below 500
 * (Cursor CLI decides from the verdict, never the code) and the message is
 * sanitized. The original code stays on `cause`.
 *
 * A `hostRetryable` failure is the opposite: Cursor CLI would send the same
 * action again, but output the host already shows stops the provider from
 * doing so. It becomes an `APICallError` with `isRetryable: true`, which
 * OpenCode 1.x retries as the same step, and `x-should-retry: true` without a
 * status, which OpenCode 2 continues after the shown output.
 *
 * Hosts label a 429 as a usage limit (OpenCode 2 `provider.rate-limit`, which
 * T3 titles "Usage limit reached"), so Cursor's `ErrorDetails` pick the status
 * instead of the Connect code where they say what failed: see `cursorFailureKind`.
 */
export function hostFacingError(error: unknown, context: { modelId?: string } = {}): Error {
  if (!(error instanceof Error)) return new Error(String(error))
  const auth = error instanceof CursorAuthError
  if (!auth && error instanceof CursorProviderError && error.hostRetryable) {
    return new APICallError({
      message: error.message,
      url: "cursor://agent.v1.AgentService/Run",
      requestBodyValues: {},
      responseHeaders: {
        "x-should-retry": "true",
        ...(error.retryAfterMs === undefined ? {} : { "retry-after-ms": String(error.retryAfterMs) }),
      },
      isRetryable: true,
      cause: error,
    })
  }
  if (!auth && (!(error instanceof CursorProviderError) || error.retryable !== false)) return error
  const kind = auth ? "auth" : cursorFailureKind(error)
  const connectStatus = error.code !== undefined && Object.hasOwn(CONNECT_CODE_HTTP_STATUS, error.code)
    ? CONNECT_CODE_HTTP_STATUS[error.code]!
    : CONNECT_CODE_HTTP_STATUS.unknown!
  const status = auth
    ? (error.statusCode === 403 ? 403 : 401)
    : kind === undefined ? connectStatus : HOST_STATUS_BY_KIND[kind]
  return new APICallError({
    message: sanitizeHostTerminalMessage(hostTerminalMessage(error, kind, context.modelId)),
    url: "cursor://agent.v1.AgentService/Run",
    requestBodyValues: {},
    statusCode: status >= 500 ? NON_RETRYABLE_SERVER_STATUS : status,
    responseHeaders: { "x-should-retry": "false" },
    isRetryable: false,
    cause: error,
  })
}

// `aiserver.v1.ErrorDetails.Error` values, as Cursor CLI names them without the `ERROR_` prefix.
// BAD_API_KEY, NOT_LOGGED_IN, INVALID_AUTH_ID, AUTH_TOKEN_NOT_FOUND, AUTH_TOKEN_EXPIRED,
// AGENT_REQUIRES_LOGIN, UNAUTHORIZED, BAD_USER_API_KEY
const CURSOR_AUTH_ERRORS = new Set([1, 2, 3, 11, 12, 18, 38, 42])
// FREE_USER_USAGE_LIMIT, PRO_USER_USAGE_LIMIT, PRO_USER_ONLY, USAGE_PRICING_REQUIRED(_CHANGEABLE)
const CURSOR_USAGE_LIMIT_ERRORS = new Set([9, 10, 23, 44, 45])
// FREE/PRO_USER_RATE_LIMIT_EXCEEDED, GENERIC_RATE_LIMIT_EXCEEDED, API_KEY_RATE_LIMIT, RATE_LIMITED(_CHANGEABLE)
const CURSOR_RATE_LIMIT_ERRORS = new Set([7, 8, 22, 34, 50, 51])
const CURSOR_ERROR_RESOURCE_EXHAUSTED = 41
const CURSOR_ERROR_PROVIDER_ERROR = 57

export type CursorFailureKind = "auth" | "usage-limit" | "rate-limit" | "capacity" | "provider"

// OpenCode 2 reads 401/403 as provider.auth, 402 as provider.quota and 429 as
// provider.rate-limit; the 5xx become NON_RETRYABLE_SERVER_STATUS, provider.invalid-request.
const HOST_STATUS_BY_KIND: Readonly<Record<CursorFailureKind, number>> = {
  auth: 401,
  "usage-limit": 402,
  "rate-limit": 429,
  capacity: 503,
  provider: 502,
}

/** The nearest `ErrorDetails` along a wrapped failure's causes. */
function cursorDetailsOf(error: CursorProviderError): CursorErrorDetails | undefined {
  for (let current: unknown = error, depth = 0; current instanceof CursorProviderError && depth < 8; depth++) {
    if (current.cursorDetails) return current.cursorDetails
    current = current.cause
  }
  return undefined
}

/**
 * What a final failure was, from Cursor's `ErrorDetails` when they name it, else
 * from the codes `isCapacityFailure` reads. Undefined keeps the Connect code's status,
 * also for details that explain themselves without an enum: they may be a real limit.
 */
export function cursorFailureKind(error: CursorProviderError): CursorFailureKind | undefined {
  if (error instanceof CursorAuthError) return "auth"
  const details = cursorDetailsOf(error)
  if (details && (details.error !== 0 || details.title || details.detail)) {
    if (CURSOR_AUTH_ERRORS.has(details.error)) return "auth"
    if (CURSOR_USAGE_LIMIT_ERRORS.has(details.error)) return "usage-limit"
    if (CURSOR_RATE_LIMIT_ERRORS.has(details.error)) return "rate-limit"
    if (details.error === CURSOR_ERROR_PROVIDER_ERROR) return "provider"
    if (details.error === CURSOR_ERROR_RESOURCE_EXHAUSTED) return "capacity"
    return undefined
  }
  return isCapacityFailure(error) ? "capacity" : undefined
}

function modelVendor(modelId: string | undefined): string | undefined {
  const id = modelId?.toLowerCase() ?? ""
  if (id.includes("claude")) return "Anthropic"
  if (id.includes("gemini")) return "Google"
  if (id.includes("grok")) return "xAI"
  if (/gpt|codex|(?:^|[-/])o\d/.test(id)) return "OpenAI"
  return undefined
}

function hostTerminalMessage(error: CursorProviderError, kind: CursorFailureKind | undefined, modelId: string | undefined): string {
  const details = cursorDetailsOf(error)
  if (kind === "capacity") {
    // Cursor's High Load detail names the model by its display name.
    const model = /\bprovider for (.+?) is\b/.exec(details?.detail ?? "")?.[1] ?? modelId ?? "this model"
    const lead = `Cursor has no capacity for ${model} right now (${details?.title ? `Cursor: ${details.title}` : "capacity_limit"}): ` +
      "a limit on Cursor's side, not on your key or usage."
    if (!(error instanceof CursorRetryExhaustedError)) return `${lead} ${error.message}`
    const over = error.elapsedMs === undefined ? "" : ` over ${Math.round(error.elapsedMs / 1_000)} s`
    return `${lead} The Run was refused ${error.attempts} times${over}; send the message again in a minute or switch to another model.`
  }
  if (kind === "provider") {
    const status = details?.providerStatusCode ? `, provider status ${details.providerStatusCode}` : ""
    return `${modelVendor(modelId) ?? "The model provider"} rejected or failed the request ` +
      `(Cursor ERROR_PROVIDER_ERROR${status}). This is not your key or your usage; ` +
      "send the message again in a moment or switch to another model."
  }
  if (kind === "auth" && !(error instanceof CursorAuthError)) {
    return `Cursor authentication failed; check the Cursor API key or sign in again. ${error.message}`
  }
  const explanation = [details?.title, details?.detail].filter(Boolean).join(" ")
  if (kind === "usage-limit") return `Cursor usage limit on your account: ${explanation || error.message}`
  if (kind === "rate-limit") return `Cursor is throttling requests on your account: ${explanation || error.message}`
  return error.message
}

export class CursorLocalCancellationError extends CursorProviderError {
  constructor(message = "Cursor request cancelled locally", cause?: unknown) {
    super(message, {
      origin: "local-cancel",
      transient: false,
      replaySafe: false,
      cause,
    })
    this.name = "CursorLocalCancellationError"
  }
}

export class CursorTransportError extends CursorProviderError {
  constructor(
    message: string,
    options: Omit<CursorProviderErrorOptions, "origin"> = {
      transient: true,
      replaySafe: true,
    },
  ) {
    super(message, { ...options, origin: "transport" })
    this.name = "CursorTransportError"
  }
}

export class CursorServerError extends CursorProviderError {
  constructor(message: string, options: Omit<CursorProviderErrorOptions, "origin">) {
    super(message, { ...options, origin: "server" })
    this.name = "CursorServerError"
  }
}

export class CursorProtocolError extends CursorProviderError {
  constructor(message: string, options: Partial<CursorErrorDiagnostics> & { cause?: unknown } = {}) {
    super(message, {
      ...options,
      origin: "protocol",
      transient: false,
      replaySafe: false,
    })
    this.name = "CursorProtocolError"
  }
}

export class CursorAuthError extends CursorProviderError {
  constructor(
    message = "Cursor authentication failed; reauthenticate with Cursor",
    options: Partial<CursorErrorDiagnostics> & { cause?: unknown; replaySafe?: boolean } = {},
  ) {
    super(message, {
      ...options,
      origin: "auth",
      transient: false,
      replaySafe: options.replaySafe ?? false,
    })
    this.name = "CursorAuthError"
  }
}

function isUnauthenticatedStatus(status: number | string | undefined): boolean {
  if (status === undefined) return false
  const normalized = String(status).toLowerCase().replaceAll("-", "_")
  return normalized === "16" || normalized === "unauthenticated"
}

/**
 * Cursor refused the request's credential (HTTP 401 / gRPC unauthenticated),
 * as opposed to refusing the account an action (403 / permission_denied).
 * Only this case is worth one renewed-token retry.
 */
export function isRejectedCredentialError(error: unknown): error is CursorAuthError {
  return error instanceof CursorAuthError && (
    error.statusCode === 401 ||
    isUnauthenticatedStatus(error.grpcStatus) ||
    isUnauthenticatedStatus(error.code)
  )
}

/**
 * OpenCode 1.x SessionRetry retries an error whose message matches these
 * patterns even when it is marked non-retryable (`RETRYABLE_MESSAGE_PATTERNS`
 * and the `exhausted` / `unavailable` / `too_many_requests` substrings in
 * upstream `packages/opencode/src/session/retry.ts`, v1.19). The status
 * patterns match anywhere, so "$1500" or "500k" also re-arm it.
 */
const HOST_RETRY_MESSAGE_PATTERNS: readonly RegExp[] = [
  /429|500|502|503|504|524/gi,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests|too_many_requests/gi,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/gi,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/gi,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/gi,
  /try your request again|retry your request|resource exhausted|resource_exhausted/gi,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/gi,
  /exhausted|unavailable/gi,
]

/** Invisible U+2060 WORD JOINER: the text reads the same but no longer matches. */
const WORD_JOINER = "\u2060"

/**
 * When this provider has already spent its Run retry budget, decided a replay
 * would be unsafe, or Cursor declared the request not retryable, the
 * host-facing message must not re-arm OpenCode's SessionRetry loop. Common
 * trigger words get readable replacements; any remaining match (status-like
 * digits, Cursor's own wording) is split with a word joiner. Keep the real
 * gRPC/HTTP code on structured fields (`code`, `grpcStatus`).
 */
export function sanitizeHostTerminalMessage(message: string): string {
  let text = message
    .replace(/\bresource[_\s-]?exhausted\b/gi, "capacity_limit")
    .replace(/\bservice[_\s-]?unavailable\b/gi, "capacity_limit")
    .replace(/\bunavailable\b/gi, "capacity_limit")
    .replace(/\boverloaded\b/gi, "capacity_limit")
    .replace(/\bretry exhausted\b/gi, "retries finished")
    .replace(/\bexhausted\b/gi, "finished")
  // A joiner can add a `\b` boundary, so repeat until nothing matches.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false
    for (const pattern of HOST_RETRY_MESSAGE_PATTERNS) {
      text = text.replace(pattern, (match) => {
        changed = true
        return `${match[0]}${WORD_JOINER}${match.slice(1)}`
      })
    }
    if (!changed) break
  }
  return text
}

export class CursorRetryExhaustedError extends CursorProviderError {
  readonly attempts: number
  readonly elapsedMs?: number

  constructor(attempts: number, last: CursorProviderError, elapsedMs?: number) {
    // Host-facing text must not contain OpenCode SessionRetry trigger words
    // ("unavailable", "exhausted", "at capacity", "try again", …). Structured fields keep the real code.
    const over = elapsedMs === undefined ? "" : ` over ${Math.round(elapsedMs / 1_000)} s`
    super(
      isCapacityFailure(last)
        ? `Cursor has no capacity for this model right now (capacity_limit): a limit on Cursor's side, not on ` +
          `your key. The Run was refused ${attempts} times${over}; send the message again later or pick another model.`
        : `Cursor Run failed after ${attempts} attempts: ${sanitizeHostTerminalMessage(last.message)}`,
      {
        origin: last.origin,
        transient: false,
        replaySafe: false,
        retryable: false,
        statusCode: last.statusCode,
        grpcStatus: last.grpcStatus,
        rstCode: last.rstCode,
        code: last.code,
        retryAfterMs: last.retryAfterMs,
        cause: last,
      },
    )
    this.name = "CursorRetryExhaustedError"
    this.attempts = attempts
    this.elapsedMs = elapsedMs
  }
}

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_SESSION_ERROR",
  "ERR_HTTP2_STREAM_CANCEL",
  "ERR_HTTP2_STREAM_ERROR",
  "ETIMEDOUT",
])

export function isTransientGrpcStatus(status: number | string): boolean {
  const normalized = String(status).toLowerCase().replaceAll("-", "_")
  return (
    normalized === "8" ||
    normalized === "13" ||
    normalized === "14" ||
    normalized === "internal" ||
    normalized === "resource_exhausted" ||
    normalized === "unavailable"
  )
}

const CAPACITY_CODES = new Set(["resource_exhausted", "unavailable", "8", "14"])

/**
 * Cursor refused the Run for capacity: High Load (`ERROR_RESOURCE_EXHAUSTED`), or with no
 * `ErrorDetails` enum gRPC resource_exhausted or unavailable, HTTP 429 or 503.
 */
export function isCapacityFailure(error: CursorProviderError): boolean {
  const details = cursorDetailsOf(error)
  if (details && details.error !== 0) return details.error === CURSOR_ERROR_RESOURCE_EXHAUSTED
  if (error.statusCode === 429 || error.statusCode === 503) return true
  return [error.code, error.grpcStatus].some((value) =>
    value !== undefined && CAPACITY_CODES.has(String(value).toLowerCase().replaceAll("-", "_")))
}

const normalizedStatus = (value: number | string) => String(value).toLowerCase().replaceAll("-", "_")
const COMPRESSION_UNSUPPORTED_CODES = new Set(["unimplemented", "12"])
const COMPRESSION_DECODE_CODES = new Set(["invalid_argument", "internal", "3", "13"])

/**
 * Cursor could not take a gzip-compressed message: HTTP 415, `unimplemented` (Connect's answer to an
 * unsupported `connect-content-encoding`), or `invalid_argument`/`internal` whose message names the compression.
 */
export function isCompressionRejection(
  error: Pick<CursorErrorDiagnostics, "statusCode" | "code" | "grpcStatus" | "serverMessage">,
): boolean {
  if (error.statusCode === 415) return true
  const codes = [error.code, error.grpcStatus]
    .filter((value): value is number | string => value !== undefined)
    .map(normalizedStatus)
  if (codes.some((code) => COMPRESSION_UNSUPPORTED_CODES.has(code))) return true
  return codes.some((code) => COMPRESSION_DECODE_CODES.has(code))
    && /compress|gzip|encoding/i.test(error.serverMessage ?? "")
}

export function isAuthGrpcStatus(status: number | string): boolean {
  const normalized = String(status).toLowerCase().replaceAll("-", "_")
  return (
    normalized === "7" ||
    normalized === "16" ||
    normalized === "permission_denied" ||
    normalized === "unauthenticated"
  )
}

export function cursorHttpError(
  operation: string,
  statusCode: number,
  diagnostics: Omit<CursorErrorDiagnostics, "statusCode"> = {},
): CursorProviderError {
  if (statusCode === 401 || statusCode === 403) {
    // A rejected credential means the server did no work: replaying with a
    // renewed token is safe unless the attempt already crossed a barrier.
    return new CursorAuthError(
      `Cursor authentication failed (HTTP ${statusCode}); reauthenticate with Cursor`,
      { ...diagnostics, statusCode, replaySafe: statusCode === 401 },
    )
  }
  return new CursorServerError(`${operation} HTTP ${statusCode}`, {
    ...diagnostics,
    statusCode,
    transient: statusCode === 429 || statusCode >= 500,
    replaySafe: true,
  })
}

export function cursorGrpcError(
  operation: string,
  grpcStatus: number | string,
  diagnostics: Omit<CursorErrorDiagnostics, "grpcStatus"> = {},
): CursorProviderError {
  if (isAuthGrpcStatus(grpcStatus)) {
    return new CursorAuthError(
      `Cursor authentication failed (gRPC ${grpcStatus}); reauthenticate with Cursor`,
      { ...diagnostics, grpcStatus, replaySafe: isUnauthenticatedStatus(grpcStatus) },
    )
  }
  return new CursorServerError(`${operation} gRPC status ${grpcStatus}`, {
    ...diagnostics,
    grpcStatus,
    transient: isTransientGrpcStatus(grpcStatus),
    replaySafe: true,
  })
}

export function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

export function toCursorProviderError(
  error: unknown,
  options: { replaySafe: boolean; fallback?: string } = { replaySafe: false },
): CursorProviderError {
  if (error instanceof CursorProviderError) {
    error.replaySafe = options.replaySafe && error.replaySafe
    return error
  }

  const code = errorCode(error)
  const name = error instanceof Error ? error.name : "Error"
  const message = error instanceof Error ? error.message : ""
  if (name.startsWith("Auth") || /access token|api key|authentication/i.test(message)) {
    return new CursorAuthError(undefined, { code, cause: error })
  }

  const httpStatus = /\bHTTP\s+(\d{3})\b/i.exec(message)?.[1]
  if (httpStatus) {
    const failure = cursorHttpError("Cursor request failed with", Number(httpStatus), { code })
    failure.replaySafe = options.replaySafe && failure.replaySafe
    return failure
  }

  if (code && TRANSIENT_NETWORK_CODES.has(code)) {
    return new CursorTransportError(`Cursor transport failure (${code})`, {
      transient: true,
      replaySafe: options.replaySafe,
      code,
      cause: error,
    })
  }
  if (error instanceof TypeError) {
    return new CursorProtocolError(options.fallback ?? "Invalid Cursor provider configuration", {
      code,
      cause: error,
    })
  }
  return new CursorProtocolError(options.fallback ?? `Cursor provider failure (${name})`, {
    code,
    cause: error,
  })
}

/**
 * A transient failure after the attempt showed only text or reasoning, before
 * any checkpoint of the turn. Cursor CLI sends the same action again; the host
 * does that here (see `hostFacingError`), and the lost-request record carries
 * the user's request once.
 */
export function hostRetryError(cause: CursorProviderError, beforeOutput = false): CursorProviderError {
  return new CursorProviderError(
    beforeOutput
      ? `${cause.message}; the Run could not start and the turn can be sent again`
      : `${cause.message} after visible output, before Cursor saved a checkpoint; the turn can be sent again`,
    {
      origin: cause.origin,
      transient: false,
      replaySafe: false,
      hostRetryable: true,
      statusCode: cause.statusCode,
      grpcStatus: cause.grpcStatus,
      rstCode: cause.rstCode,
      code: cause.code,
      retryAfterMs: cause.retryAfterMs,
      cause,
    },
  )
}

/**
 * Cursor CLI stops automatic resumes after two resumed attempts that streamed
 * but saved no checkpoint, so the turn does not repeat the same work forever.
 */
export function noProgressResumeError(cause: CursorProviderError, resumes: number): CursorProviderError {
  return new CursorProviderError(
    `Cursor Run stopped after ${resumes} resume attempts made no progress; ` +
      "send a message to continue from the last saved state",
    {
      origin: cause.origin,
      transient: false,
      replaySafe: false,
      retryable: false,
      code: cause.code,
      cause,
    },
  )
}

export function retrySuppressedError(
  cause: CursorProviderError,
  reason: string,
  attempt: number,
  maxAttempts: number,
): CursorProviderError {
  const subject = sanitizeHostTerminalMessage(
    cause.message.replace(/^Cursor Run stream /, "Cursor stream "),
  )
  return new CursorProviderError(
    `${subject} ${reason}; automatic retry unsafe (attempt ${attempt}/${maxAttempts}). ` +
      `Send a message such as "continue" to resume from the last saved state`,
    {
      origin: cause.origin,
      transient: false,
      replaySafe: false,
      retryable: false,
      statusCode: cause.statusCode,
      grpcStatus: cause.grpcStatus,
      rstCode: cause.rstCode,
      code: cause.code,
      retryAfterMs: cause.retryAfterMs,
      cause,
    },
  )
}
