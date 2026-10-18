import { afterEach, describe, expect, it } from "bun:test"
import { CursorRetryExhaustedError, CursorServerError, CursorTransportError, hostFacingError } from "../src/errors.js"
import { CursorRunInterruptedError } from "../src/transport/connect.js"
import { retryTurnKey } from "../src/language-model.js"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { endlessRetriesEnabled, forgetRetryBudget, newRetryBudget, reserveRetry, resetRetryBudgetsForTests, retryCategory, turnRetryBudget } from "../src/retry-budget.js"

const savedEndless = process.env.CURSOR_ENDLESS_RETRIES
afterEach(() => {
  if (savedEndless === undefined) delete process.env.CURSOR_ENDLESS_RETRIES
  else process.env.CURSOR_ENDLESS_RETRIES = savedEndless
  resetRetryBudgetsForTests()
})

const transport = () => new CursorTransportError("Connection reset", { transient: true, replaySafe: true, code: "ECONNRESET" })
const server = () => new CursorServerError("unavailable", { transient: true, replaySafe: true })
const stall = () => new CursorTransportError("Stalled", { transient: true, replaySafe: true, code: "CURSOR_SEMANTIC_IDLE_TIMEOUT" })

describe("Cursor CLI retry budgets", () => {
  it("counts capacity retries against an explicit maxAttempts", () => {
    expect(() => reserveRetry({ ...newRetryBudget(), retries: 1, capacity: 1 }, transport(), 3)).toThrow(CursorRetryExhaustedError)
    expect(() => reserveRetry({ ...newRetryBudget(), retries: 1 }, transport(), 3)).not.toThrow()
  })

  it("ignores only standalone host interruption notices in an ongoing turn", () => {
    const notice = "The previous response was interrupted. Continue from where you left off without repeating completed content."
    const user = (text: string): LanguageModelV3Prompt[number] => ({ role: "user", content: [{ type: "text", text }] })
    const prompt: LanguageModelV3Prompt = [user("Continue")]
    const key = retryTurnKey(prompt)
    prompt.push({ role: "assistant", content: [{ type: "text", text: "partial answer" }] })
    prompt.push(user("<system-update>new instructions</system-update>"), user(notice))
    expect(retryTurnKey(prompt)).not.toBe(key)
    expect(retryTurnKey(prompt, true)).toBe(key)
    expect(retryTurnKey([user(notice)])).not.toBe(retryTurnKey([]))
    expect(retryTurnKey([...prompt, user("Continue")])).not.toBe(key)
    expect(retryTurnKey([...prompt, user(`${notice}\nPlease inspect the diff`)])).not.toBe(key)
    expect(retryTurnKey([...prompt, { role: "user", content: [{ type: "text", text: notice },
      { type: "file", data: new Uint8Array([1]), mediaType: "image/png" }] }])).not.toBe(key)
  })

  it("recognizes interruption notices with appended host-note parts but not new requests or attachments", () => {
    const notice = "The previous response was interrupted. Continue from where you left off without repeating completed content."
    const prompt: LanguageModelV3Prompt = [{ role: "user", content: [{ type: "text", text: "Continue" }] }]
    const key = retryTurnKey(prompt)
    const transformed = structuredClone(prompt)
    const first = transformed[0]!
    if (first.role !== "user") throw new Error("Expected the initial user message")
    first.content.push({ type: "text", text: "<system-reminder>Initial request reminder</system-reminder>" })
    expect(retryTurnKey(transformed)).toBe(key)
    expect(first.content).toHaveLength(2) // identity normalization must not edit the actual prompt
    prompt.push({ role: "assistant", content: [{ type: "text", text: "partial answer" }] })
    for (const extra of ["<system-reminder>Check the pending tasks</system-reminder>", "<system-update>Updated instructions</system-update>"]) {
      const continued: LanguageModelV3Prompt = [...prompt, { role: "user", content: [
        { type: "text", text: notice }, { type: "text", text: extra },
      ] }]
      expect(retryTurnKey(continued)).not.toBe(key)
      expect(retryTurnKey(continued, true)).toBe(key)
    }
    for (const extra of [
      { type: "text" as const, text: "Actually inspect another file" },
      { type: "file" as const, data: new Uint8Array([1]), mediaType: "image/png" },
    ]) {
      expect(retryTurnKey([...prompt, { role: "user", content: [{ type: "text", text: notice }, extra] }], true)).not.toBe(key)
    }
  })

  it("requires a requested host retry before sharing a plain-text continuation's budget", () => {
    const original = turnRetryBudget("session", "original")
    reserveRetry(original, server())
    expect(turnRetryBudget("session", "user-quote", "original")).not.toBe(original)
    original.hostRetryPending = true
    expect(turnRetryBudget("session", "host-notice", "original")).toBe(original)
    // The admitted prompt still owns the same budget during later tool steps.
    expect(turnRetryBudget("session", "host-notice", "original")).toBe(original)
    original.hostRetryPending = true
    expect(turnRetryBudget("session", "next-host-notice", "host-notice")).toBe(original)
    expect(turnRetryBudget("session", "later-user-quote", "next-host-notice")).not.toBe(original)
  })

  it("allows ten transport retries and three server retries independently", () => {
    delete process.env.CURSOR_ENDLESS_RETRIES
    const budget = newRetryBudget()
    for (let i = 0; i < 10; i++) reserveRetry(budget, transport())
    for (let i = 0; i < 3; i++) reserveRetry(budget, server())
    for (const failure of [transport(), server()]) {
      expect(() => reserveRetry(budget, failure)).toThrow(CursorRetryExhaustedError)
    }
    expect(budget.retries).toBe(13)
  })

  it("uses transport for incomplete streams and stalls, and server for read-idle", () => {
    expect(retryCategory(new CursorRunInterruptedError())).toBe("transport")
    expect(retryCategory(new CursorTransportError("idle", { code: "CURSOR_READ_IDLE_TIMEOUT", transient: true, replaySafe: true }))).toBe("server")
    expect(retryCategory(stall())).toBe("transport")
  })

  it("retains the allowance across module copies, host retries and tool steps, until completion or Stop", async () => {
    const first = turnRetryBudget("session", "turn")
    reserveRetry(first, server())
    const copy = await import(`../src/retry-budget.js?copy=${crypto.randomUUID()}`)
    expect(copy.turnRetryBudget("session", "turn")).toBe(first)
    expect(turnRetryBudget("other", "turn").retries).toBe(0)
    const helper = turnRetryBudget("session", "helper")
    forgetRetryBudget("session", helper)
    expect(turnRetryBudget("session", "turn")).toBe(first)
    forgetRetryBudget("session")
    expect(turnRetryBudget("session", "turn").retries).toBe(0)
  })

  it("enforces an explicit total attempt ceiling across categories", () => {
    delete process.env.CURSOR_ENDLESS_RETRIES
    const budget = newRetryBudget()
    reserveRetry(budget, transport(), 2)
    let failure: unknown
    try { reserveRetry(budget, server(), 2) } catch (error) { failure = error }
    expect(hostFacingError(failure)).toMatchObject({ isRetryable: false, statusCode: 400, responseHeaders: { "x-should-retry": "false" } })
  })

  it("opts into endless counts only with 1 or true", () => {
    for (const value of ["", "0", "false", "TRUE", "yes"]) {
      process.env.CURSOR_ENDLESS_RETRIES = value
      expect(endlessRetriesEnabled()).toBe(false)
    }
    for (const value of ["1", "true"]) {
      process.env.CURSOR_ENDLESS_RETRIES = value
      const budget = newRetryBudget()
      for (let i = 0; i < 25; i++) {
        reserveRetry(budget, server(), 1)
        reserveRetry(budget, transport(), 1)
      }
      expect(budget.retries).toBe(50)
    }
  })

  it("keeps the 180 second consecutive-stall retry window even in endless mode", () => {
    process.env.CURSOR_ENDLESS_RETRIES = "true"
    const budget = newRetryBudget()
    reserveRetry(budget, stall(), undefined, 100)
    reserveRetry(budget, stall(), undefined, 180_099)
    expect(() => reserveRetry(budget, stall(), undefined, 180_100)).toThrow(CursorRetryExhaustedError)
    reserveRetry(budget, server(), undefined, 180_101)
    reserveRetry(budget, stall(), undefined, 180_102)
    expect(budget.stallStartedAt).toBe(180_102)
  })
})
