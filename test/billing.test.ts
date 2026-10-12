import { afterEach, describe, expect, it } from "bun:test"
import type { LanguageModelV3Usage } from "@ai-sdk/provider"
import {
  BillingLedger,
  billingLedger,
  cursorPricingId,
  hostStepPrices,
  hostUsageCostUsd,
  nanoAiuForUsd,
  shapeStepUsage,
  turnEndedCostUsd,
} from "../src/billing.js"
import { pump } from "../src/language-model.js"
import { encodeMessage } from "../src/protocol/messages.js"
import { getCursorModelCost, toOpenCode2Costs, type OpenCodeModelCost } from "../src/pricing.js"
import { sessionManager, type CursorSession, type Frame } from "../src/session.js"
import { sessionFixture } from "./session-fixture.js"

const GROK: OpenCodeModelCost = {
  input: 2, output: 6, cache_read: 0.5,
  context_over_200k: { input: 4, output: 12, cache_read: 1 },
}
const CLAUDE: OpenCodeModelCost = { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 }

/** OpenCode 2 `cm`: the step's tokens at the tier its prompt size selects. */
function openCode2Cost(cost: OpenCodeModelCost, usage: LanguageModelV3Usage): number {
  const tokens = {
    input: usage.inputTokens.noCache ?? 0,
    cacheRead: usage.inputTokens.cacheRead ?? 0,
    cacheWrite: usage.inputTokens.cacheWrite ?? 0,
    output: usage.outputTokens.total ?? 0,
  }
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite
  const tiers = toOpenCode2Costs(cost)
  const tier = tiers
    .filter((entry) => entry.tier?.type === "context" && prompt > entry.tier.size)
    .sort((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0] ?? tiers.find((entry) => !entry.tier)!
  return (tokens.input * tier.input + tokens.output * tier.output
    + tokens.cacheRead * tier.cache.read + tokens.cacheWrite * tier.cache.write) / 1e6
}

/** OpenCode 1.x getUsage with a Copilot `totalNanoAiu`. */
const openCode1Cost = (nanoAiu: number) => nanoAiu / 1e11

const total = (usage: LanguageModelV3Usage) => (usage.inputTokens.total ?? 0) + (usage.outputTokens.total ?? 0)

afterEach(() => billingLedger.clear())

describe("pricing a Run", () => {
  it("does not select a long-context tier just because output pushes occupancy over 200k", () => {
    expect(turnEndedCostUsd(GROK, {
      inputTokens: 200_000, outputTokens: 1_000, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0,
    }, 201_000)).toBeCloseTo(0.406, 12)
  })

  it("bounds cache counters to the input partition before pricing them", () => {
    expect(turnEndedCostUsd(CLAUDE, {
      inputTokens: 100, outputTokens: 0, cacheRead: 150, cacheWrite: 50, reasoningTokens: 0,
    }, 100)).toBeCloseTo(100 * 0.3e-6, 12)
  })

  it("uses the catalog's Fast entry only for a Fast variant with its own rate", () => {
    expect(cursorPricingId("grok-4.7", [{ id: "fast", value: "true" }])).toBe("grok-4.7-fast")
    expect(cursorPricingId("grok-4.7", [{ id: "fast", value: "false" }])).toBe("grok-4.7")
    expect(cursorPricingId("grok-4.7", [])).toBe("grok-4.7")
    expect(cursorPricingId("no-such-model", [{ id: "fast", value: "true" }])).toBe("no-such-model")
    expect(getCursorModelCost(cursorPricingId("grok-4.7", [{ id: "fast", value: "true" }]))?.input).toBe(4)
  })

  it("prices a step at the tier its prompt size selects, unpriced cache categories at nothing", () => {
    expect(hostStepPrices(GROK, 200_000)).toEqual({ input: 2e-6, output: 6e-6, cacheRead: 5e-7, cacheWrite: 0 })
    expect(hostStepPrices(GROK, 200_001)).toEqual({ input: 4e-6, output: 12e-6, cacheRead: 1e-6, cacheWrite: 0 })
    expect(hostStepPrices(undefined, 10)).toBeUndefined()
  })

  it("computes what Cursor billed for a Run from TurnEnded", () => {
    // Observed Grok 4.7 turn: 322,441 input (282,240 cached), 7,229 output.
    const usd = turnEndedCostUsd(GROK, {
      inputTokens: 322_441, outputTokens: 7_229, cacheRead: 282_240, cacheWrite: 0, reasoningTokens: 4_941,
    }, 45_934)!
    expect(usd).toBeCloseTo(40_201 * 2e-6 + 282_240 * 5e-7 + 7_229 * 6e-6, 9)
    // A cache category without its own rate is billed as input.
    expect(turnEndedCostUsd({ input: 1, output: 1 }, {
      inputTokens: 100, outputTokens: 0, cacheRead: 40, cacheWrite: 10, reasoningTokens: 0,
    }, 100)).toBeCloseTo(100e-6, 12)
    expect(turnEndedCostUsd(undefined, {
      inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0,
    }, 1)).toBeUndefined()
  })
})

describe("shapeStepUsage", () => {
  it("bills a step like one model call: the carried-over context from cache, the rest as input", () => {
    const { usage, costUsd } = shapeStepUsage({ usedTokens: 29_467, prefixTokens: 22_944, prices: hostStepPrices(GROK, 29_466) })
    expect(usage).toEqual({
      inputTokens: { total: 29_466, noCache: 6_522, cacheRead: 22_944, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    })
    expect(costUsd).toBeCloseTo(openCode2Cost(GROK, usage), 12)
    expect(hostUsageCostUsd(hostStepPrices(GROK, 29_466)!, usage)).toBe(costUsd)
    expect(openCode1Cost(nanoAiuForUsd(costUsd))).toBeCloseTo(costUsd, 9)
  })

  it("settles a target within the input/cache range at the occupancy total", () => {
    for (const target of [0.021, 0.048, 0.0799]) {
      const { usage, costUsd } = shapeStepUsage({
        usedTokens: 40_000, prefixTokens: 30_000, prices: hostStepPrices(GROK, 39_999), targetUsd: target,
      })
      expect(total(usage)).toBe(40_000)
      expect(usage.inputTokens.cacheWrite).toBe(0)
      expect(Math.abs(openCode2Cost(GROK, usage) - target)).toBeLessThan(2e-6)
      expect(costUsd).toBeCloseTo(openCode2Cost(GROK, usage), 12)
    }
  })

  it("clamps a target outside what the occupancy can carry", () => {
    const prices = hostStepPrices(GROK, 39_999)
    const high = shapeStepUsage({ usedTokens: 40_000, prefixTokens: 0, prices, targetUsd: 10 })
    expect(high.usage.inputTokens.noCache).toBe(39_999)
    expect(high.costUsd).toBeCloseTo(39_999 * 2e-6 + 6e-6, 12)
    // Grok has no cache-write rate, so the host charges it nothing: an
    // over-billed session can be brought down to the output token alone.
    const low = shapeStepUsage({ usedTokens: 40_000, prefixTokens: 30_000, prices, targetUsd: -1 })
    expect(low.usage.inputTokens.cacheWrite).toBe(39_999)
    expect(low.costUsd).toBeCloseTo(6e-6, 12)
    expect(total(low.usage)).toBe(40_000)
  })

  it("reaches above the input rate through a dearer cache-write rate", () => {
    const prices = hostStepPrices(CLAUDE, 9_999)
    const { usage, costUsd } = shapeStepUsage({ usedTokens: 10_000, prefixTokens: 0, prices, targetUsd: 0.035 })
    expect(usage.inputTokens.cacheWrite).toBeGreaterThan(0)
    expect(Math.abs(openCode2Cost(CLAUDE, usage) - 0.035)).toBeLessThan(4e-6)
    expect(costUsd).toBeCloseTo(openCode2Cost(CLAUDE, usage), 12)
  })

  it("keeps the occupancy split and costs nothing for an unpriced model", () => {
    const { usage, costUsd } = shapeStepUsage({ usedTokens: 1_000, prefixTokens: 400, prices: undefined, targetUsd: 5 })
    expect(usage.inputTokens).toEqual({ total: 999, noCache: 599, cacheRead: 400, cacheWrite: 0 })
    expect(costUsd).toBe(0)
  })

  it("reports nothing before any occupancy is known", () => {
    expect(shapeStepUsage({ usedTokens: 0, prefixTokens: 5, prices: hostStepPrices(GROK, 0) }).costUsd).toBe(0)
  })
})

describe("BillingLedger", () => {
  it("does not spend an abandoned Run's estimates as credit against another Run", () => {
    const ledger = new BillingLedger()
    const abandoned = {}
    const completed = {}
    ledger.recordBilled("s", 0.08, abandoned)
    ledger.recordBilled("s", 0.01, completed)
    ledger.recordReal("s", 0.03, completed)
    expect(ledger.outstanding("s")).toBeCloseTo(0.02, 12)
    expect(ledger.totals("s")).toEqual({ realUsd: 0.03, billedUsd: 0.09 })
  })

  it("replaces only the matching Run's estimates, including a zero-cost completion", () => {
    const ledger = new BillingLedger()
    const pending = {}
    const free = {}
    ledger.recordBilled("s", 0.08, pending)
    ledger.recordBilled("s", 0.01, free)
    ledger.recordReal("s", 0, free)
    expect(ledger.outstanding("s")).toBeCloseTo(-0.01, 12)
    ledger.recordReal("s", 0.1, pending)
    expect(ledger.outstanding("s")).toBeCloseTo(0.01, 12)
  })

  it("keeps session balances across separately evaluated module instances", async () => {
    const copy = await import(new URL("../src/billing.ts?ledger-copy", import.meta.url).href)
    const run = {}
    billingLedger.recordBilled("shared-session", 0.08, run)
    copy.billingLedger.recordReal("shared-session", 0.1, run)
    expect(billingLedger.estimated("shared-session")).toBe(0)
    expect(billingLedger.outstanding("shared-session")).toBeCloseTo(0.02, 12)
    billingLedger.clear()
    billingLedger.recordReal("shared-session", 0.2)
    copy.billingLedger.recordBilled("shared-session", 0.05)
    expect(copy.billingLedger.totals("shared-session")).toEqual({ realUsd: 0.2, billedUsd: 0.05 })
    expect(billingLedger.outstanding("shared-session")).toBeCloseTo(0.15, 12)
  })

  it("does not subtract an evicted Run's estimates from a replacement session ledger", () => {
    const ledger = new BillingLedger()
    const oldRun = {}
    const newRun = {}
    ledger.recordBilled("s", 0.08, oldRun)
    for (let i = 0; i < 1_024; i++) ledger.recordReal(`other-${i}`, 0.01)
    ledger.recordBilled("s", 0.02, newRun)
    ledger.recordReal("s", 0.1, oldRun)
    expect(ledger.estimated("s")).toBeCloseTo(0.02, 12)
    expect(ledger.outstanding("s")).toBeCloseTo(0.1, 12)
    ledger.recordReal("s", 0.03, newRun)
    expect(ledger.outstanding("s")).toBeCloseTo(0.11, 12)
  })

  it("tracks real against billed per session", () => {
    const ledger = new BillingLedger()
    ledger.recordReal("s", 0.3)
    ledger.recordBilled("s", 0.1)
    ledger.recordBilled("s", 0.05)
    expect(ledger.outstanding("s")).toBeCloseTo(0.15, 12)
    expect(ledger.outstanding("other")).toBe(0)
    ledger.recordReal("s", Number.NaN)
    ledger.recordBilled("s", -1)
    expect(ledger.totals("s")).toEqual({ realUsd: 0.3, billedUsd: 0.15000000000000002 })
  })
})

function serverFrame(message: Record<string, unknown>): Frame {
  return { flags: 0, payload: encodeMessage("AgentServerMessage", message) }
}

function checkpoint(usedTokens: number): Uint8Array {
  return encodeMessage("ConversationStateStructure", {
    token_details: { used_tokens: usedTokens, max_tokens: 256_000 },
  })
}

function pricedRun(id: string, key: string, frames: Frame[], prefixTokens: number): CursorSession {
  let index = 0
  return sessionFixture({
    sessionId: id,
    conversationId: `conv-${id}`,
    billing: { key, cost: GROK, prefixTokens },
    stream: {
      write() {},
      end() {},
      frames: () => ({ async *[Symbol.asyncIterator]() { yield* frames } }),
      destroy() {},
      isClosed: () => false,
      onTerminal: () => () => {},
    },
    frames: {
      next: async () => index < frames.length
        ? { done: false, value: frames[index++]! }
        : { done: true, value: undefined },
    },
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
  })
}

async function finishOf(session: CursorSession): Promise<any> {
  const parts: any[] = []
  const controller = {
    enqueue(part: unknown) { parts.push(part) },
    close() {},
    error(error: unknown) { throw error },
  } as unknown as ReadableStreamDefaultController<any>
  try {
    await pump(session, controller, { textId: "t", reasoningId: "r" })
  } finally {
    sessionManager.dispose()
  }
  return parts.find((part) => part.type === "finish")
}

const turn = (input: number, cacheRead: number, output: number) => serverFrame({
  interaction_update: {
    turn_ended: { input_tokens: input, output_tokens: output, cache_read: cacheRead, cache_write: 0 },
  },
})

describe("turn-end settlement through a Run", () => {
  it("starts a replacement stream with independent estimates", async () => {
    const session = pricedRun("replacement", "ses_replacement", [
      serverFrame({ conversation_checkpoint_update: checkpoint(40_000) }),
      turn(60_000, 50_000, 500),
    ], 30_000)
    billingLedger.recordBilled(session.billing.key, 0.08, session.billing)
    sessionManager.replaceStream(session, session.stream, "new-run")
    expect(session.billing.estimatedUsd).toBe(0)
    const finish = await finishOf(session)
    expect(Math.abs(finish.providerMetadata.cursor.billing.stepUsd - 0.048)).toBeLessThan(2e-6)
    expect(finish.providerMetadata.cursor.billing.sessionEstimatedUsd).toBeCloseTo(0.08, 12)
  })

  it("retains cost with no occupancy until a later priced snapshot can settle it", async () => {
    const first = await finishOf(pricedRun("no-snapshot", "ses_snapshot", [turn(10_000, 0, 0)], 0))
    expect(total(first.usage)).toBe(0)
    expect(first.providerMetadata.copilot.totalNanoAiu).toBe(0)
    expect(billingLedger.outstanding("ses_snapshot")).toBeCloseTo(0.02, 12)
    const next = await finishOf(pricedRun("has-snapshot", "ses_snapshot", [
      serverFrame({ conversation_checkpoint_update: checkpoint(20_000) }),
      turn(10_000, 10_000, 0),
    ], 0))
    expect(Math.abs(openCode2Cost(GROK, next.usage) - 0.025)).toBeLessThan(2e-6)
    expect(Math.abs(billingLedger.outstanding("ses_snapshot"))).toBeLessThan(2e-6)
  })

  it("retains a negative balance when the host's minimum price prevents settlement", async () => {
    const session = pricedRun("minimum", "ses_minimum", [
      serverFrame({ conversation_checkpoint_update: checkpoint(10_000) }),
      turn(100, 100, 0),
    ], 0)
    session.billing.cost = CLAUDE
    const finish = await finishOf(session)
    const billed = openCode2Cost(CLAUDE, finish.usage)
    expect(billed).toBeCloseTo(9_999 * 0.3e-6 + 15e-6, 12)
    expect(billingLedger.outstanding("ses_minimum")).toBeCloseTo(100 * 0.3e-6 - billed, 12)
    expect(finish.providerMetadata.cursor.billing.sessionBilledUsd).toBeCloseTo(billed, 12)
  })

  it("does not book a finish rejected by a cancelled consumer", async () => {
    const session = pricedRun("cancelled", "ses_cancelled", [
      serverFrame({ conversation_checkpoint_update: checkpoint(40_000) }),
      turn(60_000, 50_000, 500),
    ], 30_000)
    const controller = {
      enqueue() { throw new TypeError("Controller is closed") },
      close() {},
      error(error: unknown) { throw error },
    } as unknown as ReadableStreamDefaultController<any>
    try {
      await pump(session, controller, { textId: "t", reasoningId: "r" })
    } finally {
      sessionManager.dispose()
    }
    expect(billingLedger.totals("ses_cancelled").realUsd).toBeCloseTo(0.048, 12)
    expect(billingLedger.totals("ses_cancelled").billedUsd).toBe(0)
    expect(session.billing.prefixTokens).toBe(30_000)
    const next = await finishOf(pricedRun("after-cancel", "ses_cancelled", [
      serverFrame({ conversation_checkpoint_update: checkpoint(40_000) }),
      turn(10_000, 10_000, 0),
    ], 30_000))
    expect(Math.abs(next.providerMetadata.cursor.billing.stepUsd - 0.053)).toBeLessThan(2e-6)
  })

  it("bills the catalog-priced turn cost on both hosts while reporting the occupancy snapshot", async () => {
    const finish = await finishOf(pricedRun("settle", "ses_settle", [
      serverFrame({ conversation_checkpoint_update: checkpoint(40_000) }),
      turn(60_000, 50_000, 500),
    ], 30_000))
    const real = 10_000 * 2e-6 + 50_000 * 5e-7 + 500 * 6e-6
    expect(total(finish.usage)).toBe(40_000)
    expect(Math.abs(openCode2Cost(GROK, finish.usage) - real)).toBeLessThan(2e-6)
    expect(openCode1Cost(finish.providerMetadata.copilot.totalNanoAiu)).toBeCloseTo(openCode2Cost(GROK, finish.usage), 9)
    expect(finish.providerMetadata.cursor.billing).toMatchObject({ estimate: false })
    expect(finish.providerMetadata.cursor.billing.sessionRealUsd).toBeCloseTo(real, 12)
    expect(billingLedger.outstanding("ses_settle")).toBeCloseTo(real - openCode2Cost(GROK, finish.usage), 12)
  })

  it("carries what one turn's snapshot cannot hold to the next turn", async () => {
    // A long agent Run: far more request work than one 20k-token snapshot can carry.
    const first = await finishOf(pricedRun("carry-1", "ses_carry", [
      serverFrame({ conversation_checkpoint_update: checkpoint(20_000) }),
      turn(200_000, 180_000, 2_000),
    ], 0))
    const realFirst = 20_000 * 2e-6 + 180_000 * 5e-7 + 2_000 * 6e-6
    expect(first.providerMetadata.cursor.billing.stepUsd).toBeCloseTo(19_999 * 2e-6 + 6e-6, 12)
    const second = await finishOf(pricedRun("carry-2", "ses_carry", [
      serverFrame({ conversation_checkpoint_update: checkpoint(80_000) }),
      turn(22_000, 20_000, 100),
    ], 20_000))
    const realSecond = 2_000 * 2e-6 + 20_000 * 5e-7 + 100 * 6e-6
    const billed = openCode2Cost(GROK, first.usage) + openCode2Cost(GROK, second.usage)
    expect(Math.abs(billed - (realFirst + realSecond))).toBeLessThan(4e-6)
    expect(Math.abs(billingLedger.outstanding("ses_carry"))).toBeLessThan(4e-6)
  })

  it("keeps an unpriced model at no cost", async () => {
    const session = pricedRun("unpriced", "ses_unpriced", [
      serverFrame({ conversation_checkpoint_update: checkpoint(10_000) }),
      turn(10_000, 0, 10),
    ], 0)
    delete session.billing.cost
    const finish = await finishOf(session)
    expect(finish.providerMetadata.copilot).toEqual({ totalNanoAiu: 0 })
    expect(total(finish.usage)).toBe(10_000)
    expect(billingLedger.totals("ses_unpriced")).toEqual({ realUsd: 0, billedUsd: 0 })
  })
})
