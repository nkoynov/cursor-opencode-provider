import { APICallError } from "@ai-sdk/provider"

export type CursorErrorOrigin =
  | "local-cancel"
  | "transport"
  | "server"
  | "protocol"
  | "auth"

export type CursorErrorDiagnostics = {
  statusCode?: number
  grpcStatus?: number | string
  rstCode?: number
  code?: string
  retryAfterMs?: number
  /** The message Cursor's error carried (Connect error envelope or `grpc-message`). */
  serverMessage?: string
}

export type CursorProviderErrorOptions = CursorErrorDiagnostics & {
  origin: CursorErrorOrigin
  transient: boolean
  replaySafe: boolean
  retryable?: boolean
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
 */
export function hostFacingError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error))
  // Fork (CP-37): as before #97, OpenCode 2 retries this unclassified error (its retry carries a
  // lost request once). OpenCode 1.x retries without a cap on its text patterns (sanitized away)
  // and on a cause's `ECONNRESET`/`ZlibError` code, so the host gets it without the code.
  if (error instanceof CursorUnsafeReplayError && error.retryable !== false) {
    if (error.code === undefined) return error
    return new CursorUnsafeReplayError(error.message, {
      origin: error.origin,
      transient: false,
      replaySafe: false,
      retryable: error.retryable,
      statusCode: error.statusCode,
      grpcStatus: error.grpcStatus,
      rstCode: error.rstCode,
      retryAfterMs: error.retryAfterMs,
      cause: error,
    })
  }
  const auth = error instanceof CursorAuthError
  if (!auth && (!(error instanceof CursorProviderError) || error.retryable !== false)) return error
  const connectStatus = error.code !== undefined && Object.hasOwn(CONNECT_CODE_HTTP_STATUS, error.code)
    ? CONNECT_CODE_HTTP_STATUS[error.code]!
    : CONNECT_CODE_HTTP_STATUS.unknown!
  const status = auth ? (error.statusCode === 403 ? 403 : 401) : connectStatus
  return new APICallError({
    message: sanitizeHostTerminalMessage(error.message),
    url: "cursor://agent.v1.AgentService/Run",
    requestBodyValues: {},
    statusCode: status >= 500 ? NON_RETRYABLE_SERVER_STATUS : status,
    responseHeaders: { "x-should-retry": "false" },
    isRetryable: false,
    cause: error,
  })
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

/** Cursor refused the Run for capacity: gRPC resource_exhausted or unavailable, HTTP 429 or 503. */
export function isCapacityFailure(error: CursorProviderError): boolean {
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

/** A transient failure the provider cannot replay itself (visible output or stateful work came first). */
export class CursorUnsafeReplayError extends CursorProviderError {
  constructor(message: string, options: CursorProviderErrorOptions) {
    super(message, options)
    this.name = "CursorUnsafeReplayError"
  }
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
  return new CursorUnsafeReplayError(
    `${subject} ${reason}; automatic retry unsafe (attempt ${attempt}/${maxAttempts})`,
    {
      origin: cause.origin,
      transient: false,
      replaySafe: false,
      retryable: cause.retryable,
      statusCode: cause.statusCode,
      grpcStatus: cause.grpcStatus,
      rstCode: cause.rstCode,
      code: cause.code,
      retryAfterMs: cause.retryAfterMs,
      cause,
    },
  )
}
