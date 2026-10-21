import { afterEach, describe, expect, it } from "bun:test"
import { APICallError } from "@ai-sdk/provider"
import {
  CursorAuthError,
  CursorRetryExhaustedError,
  cursorFailureKind,
  hostFacingError,
  isCapacityFailure,
  retrySuppressedError,
  type CursorProviderError,
} from "../src/errors.js"
import { connectFrameError, pumpWithRecovery, resetTurnStateForTests } from "../src/language-model.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { newRetryBudget, reserveRetry } from "../src/retry-budget.js"

// Connect end-stream errors as Cursor sent them on 2026-10-21 (provider debug log; no credentials in them).
const PROVIDER_ERROR_FRAME = JSON.stringify({
  error: {
    code: "resource_exhausted",
    message: "Error",
    details: [{
      type: "aiserver.v1.ErrorDetails",
      debug: {
        error: "ERROR_PROVIDER_ERROR",
        details: {
          title: "Provider Error",
          detail: "We're having trouble connecting to the model provider. This might be temporary - please try again in a moment.",
          isRetryable: false,
          additionalInfo: { providerStatusCode: "400" },
        },
        isExpected: true,
      },
      value: "CDkSnQEKDlByb3ZpZGVyIEVycm9yEm5XZSdyZSBoYXZpbmcgdHJvdWJsZSBjb25uZWN0aW5nIHRvIHRoZSBtb2RlbCBwcm92aWRlci4gVGhpcyBtaWdodCBiZSB0ZW1wb3JhcnkgLSBwbGVhc2UgdHJ5IGFnYWluIGluIGEgbW9tZW50LiAAOhkKEnByb3ZpZGVyU3RhdHVzQ29kZRIDNDAwGAE",
    }],
  },
})
const HIGH_LOAD_FRAME = JSON.stringify({
  error: {
    code: "resource_exhausted",
    message: "Error",
    details: [{
      type: "aiserver.v1.ErrorDetails",
      debug: {
        error: "ERROR_RESOURCE_EXHAUSTED",
        details: {
          title: "High Load",
          detail: "The provider for Claude Opus 5.5 is currently experiencing issues. Please switch to Auto, another model, or try again in a few moments.",
          isRetryable: true,
        },
        isExpected: true,
      },
      value: "CCkSlwEKCUhpZ2ggTG9hZBKHAVRoZSBwcm92aWRlciBmb3IgQ2xhdWRlIE9wdXMgNS41IGlzIGN1cnJlbnRseSBleHBlcmllbmNpbmcgaXNzdWVzLiBQbGVhc2Ugc3dpdGNoIHRvIEF1dG8sIGFub3RoZXIgbW9kZWwsIG9yIHRyeSBhZ2FpbiBpbiBhIGZldyBtb21lbnRzLiABGAE",
    }],
  },
})

/** ErrorDetails{error, details{title, detail, is_retryable}} as Cursor encodes it. */
function detailsFrame(code: string, error: number, options: { title?: string; detail?: string; retryable?: boolean } = {}): string {
  const text = (field: number, value: string) => [(field << 3) | 2, Buffer.byteLength(value), ...Buffer.from(value)]
  const inner = [
    ...(options.title ? text(1, options.title) : []),
    ...(options.detail ? text(2, options.detail) : []),
    ...(options.retryable === undefined ? [] : [0x20, options.retryable ? 1 : 0]),
  ]
  const value = Buffer.from([...(error ? [0x08, error] : []), 0x12, inner.length, ...inner]).toString("base64")
  return JSON.stringify({ error: { code, message: "Error", details: [{ type: "aiserver.v1.ErrorDetails", value }] } })
}

// The parts of OpenCode v2.1.0's `classifyProviderFailure` (packages/ai/src/provider-error.ts) and
// `toSessionError` that a Cursor APICallError reaches, then T3's OpenCode adapter title
// (packages/provider-opencode/src/server/v2/adapter.ts, nightly 20261020.3411).
const RATE_LIMIT_TEXT = /rate increased too quickly|rate[-_\s]?limit|too[_\s]?many[_\s]?requests/i
const QUOTA_TEXT =
  /insufficient[-_\s]?(?:quota|balance)|quota[-_\s]?exceeded|budget exceeded|usage limit|limit exhausted|package has expired|plan does not yet include/i
function openCodeErrorType(error: APICallError): string {
  const status = error.statusCode
  if (status === 402 || (status === 429 && QUOTA_TEXT.test(error.message))) return "provider.quota"
  if (status === 401 || status === 403) return "provider.auth"
  if (status === 429 || RATE_LIMIT_TEXT.test(error.message)) return "provider.rate-limit"
  if (status !== undefined && status >= 500) return "provider.internal"
  if (status !== undefined && status >= 400) return "provider.invalid-request"
  return "provider.unknown"
}
const t3Title = (type: string) =>
  type === "provider.quota" || type === "provider.rate-limit" ? "Usage limit reached" : "Provider error"

// OpenCode 1.19's SessionRetry message patterns, which re-arm a retry whatever isRetryable says.
const opencode1Retries = (message: string) => [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|internal error|server error|provider returned error/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
  /exhausted|unavailable/i,
].some((pattern) => pattern.test(message))

function forHost(error: unknown, modelId = "claude-opus-5-5-1m"): APICallError {
  const host = hostFacingError(error, { modelId })
  expect(APICallError.isInstance(host)).toBe(true)
  const apiError = host as APICallError
  expect(apiError.isRetryable).toBe(false)
  expect(apiError.responseHeaders?.["x-should-retry"]).toBe("false")
  expect(apiError.statusCode).toBeLessThan(500)
  expect(opencode1Retries(apiError.message)).toBe(false)
  return apiError
}

const endStream = (body: string): Frame => ({ flags: 0x02, payload: new TextEncoder().encode(body) })
function refusing(id: string, body: string): CursorSession {
  return {
    sessionId: id,
    conversationId: `conv-${id}`,
    stream: { write() {}, end() {}, destroy() {}, isClosed: () => false, frames: () => ({ async *[Symbol.asyncIterator]() {} }) },
    frames: { next: async () => ({ done: false, value: endStream(body) }) },
    pending: new Map(),
    displayToolCalls: new Map(),
    nextBridgedExecId: 900_000,
    blobs: new Map(),
    toolDescriptors: [],
    requestContext: {},
    allowTools: true,
    usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    pumpActive: false,
    heartbeat: null,
    policy: { semanticIdleMs: 60, hardCapMs: 600_000, heartbeatMs: 5 },
  } as unknown as CursorSession
}
async function pumpRefused(body: string): Promise<{ failure: CursorProviderError; runs: number }> {
  let runs = 1
  const failure = await pumpWithRecovery({
    initialSession: refusing("refused", body),
    controller: { enqueue() {}, close() {}, error() {} } as unknown as ReadableStreamDefaultController<any>,
    retryPolicy: { baseDelayMs: 0, maxDelayMs: 0, capacityMaxAttempts: 6 },
    recover: async () => refusing(`refused-${runs++}`, body),
  }).then(() => undefined, (error: unknown) => error as CursorProviderError)
  expect(failure).toBeDefined()
  return { failure: failure!, runs }
}

afterEach(() => {
  sessionManager.dispose()
  resetTurnStateForTests()
})

describe("host labels for Cursor's ErrorDetails", () => {
  it("reports Cursor's ERROR_PROVIDER_ERROR as the model provider's failure, not a usage limit", async () => {
    const failure = connectFrameError(PROVIDER_ERROR_FRAME)
    expect(failure.cursorDetails).toMatchObject({ error: 57, isRetryable: false, providerStatusCode: "400" })
    expect(failure).toMatchObject({ code: "resource_exhausted", retryable: false })
    expect(isCapacityFailure(failure)).toBe(false)

    const { failure: final, runs } = await pumpRefused(PROVIDER_ERROR_FRAME)
    expect(runs).toBe(1)
    const host = forHost(final)
    expect(host.statusCode).toBe(400)
    expect(host.message).toBe(
      "Anthropic rejected or failed the request (Cursor ERROR_PROVIDER_ERROR, provider status 400). " +
        "This is not your key or your usage; send the message again in a moment or switch to another model.",
    )
    expect(t3Title(openCodeErrorType(host))).toBe("Provider error")
    expect(forHost(failure, "gpt-5.6-sol-1m").message).toStartWith("OpenAI rejected or failed")
    expect(forHost(failure, "composer-2").message).toStartWith("The model provider rejected or failed")
  })

  it("reports Cursor's High Load as Cursor's capacity for the model after the provider's own retries", async () => {
    const failure = connectFrameError(HIGH_LOAD_FRAME)
    expect(failure.cursorDetails).toMatchObject({ error: 41, title: "High Load", isRetryable: true })
    expect(failure).toMatchObject({ transient: true, retryable: true })
    expect(isCapacityFailure(failure)).toBe(true)

    const { failure: final, runs } = await pumpRefused(HIGH_LOAD_FRAME)
    expect(final).toBeInstanceOf(CursorRetryExhaustedError)
    expect(runs).toBe(6)
    const host = forHost(final)
    expect(host.statusCode).toBe(400)
    expect(host.message).toMatch(new RegExp(
      "^Cursor has no capacity for Claude Opus 5\\.5 right now \\(Cursor: High Load\\): a limit on Cursor's side, " +
        "not on your key or usage\\. The Run was refused 6 times over \\d+ s; send the message again in a minute " +
        "or switch to another model\\.$",
    ))
    expect(t3Title(openCodeErrorType(host))).toBe("Provider error")
  })

  it("names the model from the request when the capacity refusal carries no details", () => {
    const bare = connectFrameError(JSON.stringify({ error: { code: "resource_exhausted" } }))
    const host = forHost(new CursorRetryExhaustedError(6, bare, 18_400))
    expect(host.statusCode).toBe(400)
    expect(host.message).toBe(
      "Cursor has no capacity for claude-opus-5-5-1m right now (capacity_limit): a limit on Cursor's side, not on " +
        "your key or usage. The Run was refused 6 times over 18 s; send the message again in a minute or switch to another model.",
    )
  })

  it("labels a capacity refusal the provider could not retry safely as capacity too", () => {
    const host = forHost(retrySuppressedError(connectFrameError(HIGH_LOAD_FRAME), "after visible output", 2, 6))
    expect(host.statusCode).toBe(400)
    expect(host.message).toStartWith("Cursor has no capacity for Claude Opus 5.5 right now (Cursor: High Load)")
    expect(host.message).toContain("automatic retry unsafe (attempt 2/6)")
  })

  it("keeps genuine usage, spend and plan limits and account rate limits as limits", () => {
    for (const error of [9, 10, 23, 44, 45]) {
      const host = forHost(connectFrameError(detailsFrame("resource_exhausted", error, { title: "You've hit your usage limit" })))
      expect(host.statusCode).toBe(402)
      expect(host.message).toBe("Cursor usage limit on your account: You've hit your usage limit")
      expect(t3Title(openCodeErrorType(host))).toBe("Usage limit reached")
    }
    for (const error of [7, 8, 22, 50, 51]) {
      const host = forHost(connectFrameError(detailsFrame("resource_exhausted", error, { title: "Slow down" })))
      expect(host.statusCode).toBe(429)
      expect(host.message).toBe("Cursor is throttling requests on your account: Slow down")
      expect(t3Title(openCodeErrorType(host))).toBe("Usage limit reached")
    }
  })

  it("does not spend capacity retries on an API-key rate limit Cursor CLI would retry", () => {
    const failure = connectFrameError(detailsFrame("resource_exhausted", 34, { title: "API key rate limit", retryable: true }))
    expect(failure).toMatchObject({ transient: true, retryable: true })
    expect(isCapacityFailure(failure)).toBe(false)
    const budget = newRetryBudget()
    const spent = (() => {
      try {
        for (;;) reserveRetry(budget, failure)
      } catch (error) {
        return error as CursorRetryExhaustedError
      }
    })()
    expect(spent.message).not.toContain("no capacity")
    const host = forHost(spent)
    expect(host.statusCode).toBe(429)
    expect(host.message).toBe("Cursor is throttling requests on your account: API key r\u2060ate limit")
    expect(t3Title(openCodeErrorType(host))).toBe("Usage limit reached")
  })

  it("keeps a login or API-key refusal an authentication error whatever the Connect code", () => {
    for (const error of [1, 2, 3, 11, 12, 18, 38, 42]) {
      const failure = connectFrameError(detailsFrame("resource_exhausted", error, { title: "Invalid API key" }))
      expect(cursorFailureKind(failure)).toBe("auth")
      const host = forHost(failure)
      expect(host.statusCode).toBe(401)
      expect(host.message).toStartWith("Cursor authentication failed; check the Cursor API key or sign in again.")
      expect(openCodeErrorType(host)).toBe("provider.auth")
    }
    const expired = connectFrameError(JSON.stringify({ error: { code: "unauthenticated" } }))
    expect(expired).toBeInstanceOf(CursorAuthError)
    const host = forHost(expired)
    expect(host).toMatchObject({ statusCode: 401, message: "Cursor authentication failed (unauthenticated); reauthenticate with Cursor" })
    expect(openCodeErrorType(host)).toBe("provider.auth")
  })

  it("keeps the Connect status for details it cannot name", () => {
    const custom = forHost(connectFrameError(detailsFrame("resource_exhausted", 29, { title: "Too many computers." })))
    expect(custom.statusCode).toBe(429)
    const unnamed = forHost(connectFrameError(detailsFrame("resource_exhausted", 0, { title: "Limit", retryable: false })))
    expect(unnamed.statusCode).toBe(429)
    const other = forHost(connectFrameError(detailsFrame("resource_exhausted", 63, { title: "Slow pool", retryable: false })))
    expect(other.statusCode).toBe(429)
  })

  it("spends capacity attempts only on High Load among Cursor's named errors", () => {
    for (const error of [63, 25, 59, 29]) {
      const failure = connectFrameError(detailsFrame("resource_exhausted", error, { title: "Busy", retryable: true }))
      expect(failure).toMatchObject({ transient: true, retryable: true })
      expect(isCapacityFailure(failure)).toBe(false)
      expect(new CursorRetryExhaustedError(4, failure).message).not.toContain("no capacity")
    }
    expect(isCapacityFailure(connectFrameError(detailsFrame("resource_exhausted", 41, { title: "High Load", retryable: true })))).toBe(true)
    expect(isCapacityFailure(connectFrameError(detailsFrame("resource_exhausted", 0, { title: "Busy", retryable: true })))).toBe(true)
  })
})
