import { describe, expect, it } from "bun:test"
import {
  buildLanguageModelV3UsageFromCounters,
  buildLanguageModelV3UsageFromTurnEnded,
  carryTurnEndedCounters,
  formatCursorCacheDiagnostics,
  formatCursorTokenCategories,
  formatTurnUsageValidation,
  flatUsageFromV3,
  newOccupancyUsageLedger,
  occupancyGrowthPart,
  occupancyStepUsage,
  occupancyValidationCounters,
  OPENCODE_DISPLAY_ONLY_COST_METADATA,
  turnEndedCounter,
} from "../src/usage.js"
import { evaluateStickyCacheTurns, parseCacheDiagnosisLine, readRatio } from "./cache-diagnosis.js"

describe("turnEndedCounter", () => {
  it("truncates finite non-negative numbers", () => {
    expect(turnEndedCounter({ x: 12.9 }, "x")).toBe(12)
    expect(turnEndedCounter({ x: -1 }, "x")).toBe(0)
    expect(turnEndedCounter({ x: NaN }, "x")).toBe(0)
    expect(turnEndedCounter({}, "x")).toBe(0)
  })
})

describe("buildLanguageModelV3UsageFromTurnEnded", () => {
  const te = {
    input_tokens: 100,
    output_tokens: 50,
    cache_read: 10,
    cache_write: 5,
    reasoning_tokens: 7,
  }

  it("maps nested V3 usage from TurnEnded", () => {
    const usage = buildLanguageModelV3UsageFromTurnEnded(te)
    expect(usage.inputTokens?.total).toBe(100)
    expect(usage.inputTokens?.noCache).toBe(85)
    expect(usage.inputTokens?.cacheRead).toBe(10)
    expect(usage.inputTokens?.cacheWrite).toBe(5)
    expect(usage.outputTokens?.total).toBe(50)
    expect(usage.outputTokens?.text).toBe(43)
    expect(usage.outputTokens?.reasoning).toBe(7)
  })

  it("defaults missing reasoning_tokens to zero", () => {
    const usage = buildLanguageModelV3UsageFromTurnEnded({
      input_tokens: 1,
      output_tokens: 2,
      cache_read: 0,
      cache_write: 0,
    })
    expect(usage.outputTokens?.reasoning).toBe(0)
    expect(usage.outputTokens?.total).toBe(2)
  })

  it("projects V3 usage into flat counter fields", () => {
    const flat = flatUsageFromV3(buildLanguageModelV3UsageFromTurnEnded(te))
    expect(flat).toEqual({
      inputTokens: 85,
      outputTokens: 43,
      reasoningTokens: 7,
      cacheReadInputTokens: 10,
      cacheWriteInputTokens: 5,
    })
  })

  it("maps every request independently even when counters decrease between turns", () => {
    const usage = buildLanguageModelV3UsageFromTurnEnded({
      input_tokens: 42_563,
      output_tokens: 1_141,
      cache_read: 27_392,
      cache_write: 0,
      reasoning_tokens: 801,
    })
    expect(usage.inputTokens).toEqual({
      total: 42_563,
      noCache: 15_171,
      cacheRead: 27_392,
      cacheWrite: 0,
    })
    expect(usage.outputTokens).toEqual({
      total: 1_141,
      text: 340,
      reasoning: 801,
    })
  })

  it("does not dilute a prefix cache hit by multi-step TurnEnded aggregates", () => {
    const usage = buildLanguageModelV3UsageFromTurnEnded(
      {
        input_tokens: 94_836,
        output_tokens: 3_513,
        cache_read: 45_952,
        cache_write: 0,
        reasoning_tokens: 3_178,
      },
      { contextTotalTokens: 50_702, priorContextTokens: 45_243 },
    )
    expect(usage.inputTokens).toEqual({
      total: 47_189,
      noCache: 1_946,
      cacheRead: 45_243,
      cacheWrite: 0,
    })
    expect(usage.outputTokens?.total).toBe(3_513)
  })

  it("uses checkpoint occupancy as the total while preserving cache proportions", () => {
    const usage = buildLanguageModelV3UsageFromTurnEnded(
      {
        input_tokens: 100,
        output_tokens: 20,
        cache_read: 60,
        cache_write: 20,
        reasoning_tokens: 5,
      },
      { contextTotalTokens: 70 },
    )

    expect(usage.inputTokens).toEqual({
      total: 50,
      noCache: 10,
      cacheRead: 30,
      cacheWrite: 10,
    })
    expect(usage.outputTokens).toEqual({
      total: 20,
      text: 15,
      reasoning: 5,
    })
    expect(flatUsageFromV3(usage)).toEqual({
      inputTokens: 10,
      outputTokens: 15,
      reasoningTokens: 5,
      cacheReadInputTokens: 30,
      cacheWriteInputTokens: 10,
    })

    expect(formatTurnUsageValidation(
      {
        inputTokens: 100,
        outputTokens: 20,
        cacheRead: 60,
        cacheWrite: 20,
        reasoningTokens: 5,
      },
      usage,
      {
        usedTokens: 70,
        maxTokens: 100,
        breakdown: {
          totalUsedTokens: 70,
          maxTokens: 100,
          categories: [
            { id: "static", label: "Static", estimatedTokens: 40 },
            { id: "conversation", label: "Conversation", estimatedTokens: 30 },
          ],
        },
      },
    )).toBe(
      "turn usage validation: status=ok source=checkpoint-current-run " +
      "cursor=70/100(70.0%) rawTotal=120 sentTotal=70 totalMatch=true " +
      "input=50 inputParts=50 inputMatch=true output=20 outputParts=20 outputMatch=true " +
      "opencodeProjectedTotal=70 opencodeMatch=true breakdownTotal=70 categorySum=70 " +
      "breakdownMatch=true rawCachedRatio=80.0% sentCachedRatio=80.0% cacheRatioMatch=true",
    )
  })

  it("marks context checks unavailable without deriving occupancy from TurnEnded", () => {
    const counters = {
      inputTokens: 10,
      outputTokens: 2,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningTokens: 0,
    }
    const validation = formatTurnUsageValidation(
      counters,
      buildLanguageModelV3UsageFromCounters({
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
      }),
    )
    expect(validation).toContain("status=ok source=unavailable cursor=unavailable")
    expect(validation).toContain("rawTotal=12 sentTotal=0 totalMatch=unavailable")
    expect(validation).toContain("opencodeProjectedTotal=0 opencodeMatch=true")
    expect(validation).toContain("breakdownMatch=unavailable")
    expect(validation).toContain("cacheRatioMatch=unavailable")
  })
})

/** OpenCode 2.0.24 `SessionUsage.calculateCost` for one finish (single-tier model). */
function openCodeCost(
  usage: ReturnType<typeof occupancyStepUsage>,
  rate: { input: number; output: number; cache_read: number; cache_write: number },
): number {
  return (
    (usage.inputTokens.noCache ?? 0) * rate.input
    + (usage.outputTokens.total ?? 0) * rate.output
    + (usage.inputTokens.cacheRead ?? 0) * rate.cache_read
    + (usage.inputTokens.cacheWrite ?? 0) * rate.cache_write
  ) / 1_000_000
}

/** OpenCode 2.0.24 compaction's measured prompt (`input + cache.read + cache.write + output + reasoning`). */
function measuredPrompt(usage: ReturnType<typeof occupancyStepUsage>): number {
  const text = Math.max(0, (usage.outputTokens.total ?? 0) - (usage.outputTokens.reasoning ?? 0))
  return (usage.inputTokens.noCache ?? 0) + (usage.inputTokens.cacheRead ?? 0)
    + (usage.inputTokens.cacheWrite ?? 0) + text + (usage.outputTokens.reasoning ?? 0)
}

const details = (usedTokens: number) => ({ usedTokens, maxTokens: 1_000_000 })

describe("occupancyStepUsage", () => {
  it("keeps OpenCode 1.x's Copilot cost override at zero", () => {
    expect(OPENCODE_DISPLAY_ONLY_COST_METADATA).toEqual({
      copilot: { totalNanoAiu: 0 },
    })
  })

  it("prices the previous finish's occupancy as a cache read and the growth as a cache write", () => {
    const ledger = newOccupancyUsageLedger({ usedTokens: 123_651, maxTokens: 256_000 })
    const first = occupancyStepUsage(details(153_744), ledger)
    expect(first.inputTokens).toEqual({ total: 153_743, noCache: 0, cacheRead: 123_651, cacheWrite: 30_092 })
    expect(first.outputTokens).toEqual({ total: 1, text: 1, reasoning: 0 })
    const second = occupancyStepUsage(details(160_000), ledger)
    expect(second.inputTokens).toEqual({ total: 159_999, noCache: 0, cacheRead: 153_744, cacheWrite: 6_255 })
    const validation = formatTurnUsageValidation(
      occupancyValidationCounters(second),
      second,
      details(160_000),
      "checkpoint-current-run",
    )
    expect(validation).toContain("status=ok")
    expect(validation).toContain("rawTotal=160000 sentTotal=160000 totalMatch=true")
    expect(validation).toContain("cacheRatioMatch=true")
  })

  it("sends growth uncached only for models Cursor lists without a cache-write rate", () => {
    expect(occupancyGrowthPart("claude-opus-5-5")).toBe("cacheWrite")
    expect(occupancyGrowthPart("grok-4.7")).toBe("noCache")
    expect(occupancyGrowthPart("not-a-cursor-model")).toBe("cacheWrite")
    expect(occupancyGrowthPart(undefined)).toBe("cacheWrite")
  })

  it("starts a Run without a checkpoint from zero and sends growth uncached when asked", () => {
    const ledger = newOccupancyUsageLedger()
    const usage = occupancyStepUsage(details(40), ledger, { growth: "noCache" })
    expect(usage.inputTokens).toEqual({ total: 39, noCache: 39, cacheRead: 0, cacheWrite: 0 })
    expect(usage.outputTokens.total).toBe(1)
  })

  it("caps the cache read when Cursor's context shrank since the previous finish", () => {
    // Live: prior checkpoint 26,823 tokens, current 26,766.
    const usage = occupancyStepUsage(details(26_766), newOccupancyUsageLedger(details(26_823)))
    expect(usage.inputTokens).toEqual({ total: 26_765, noCache: 0, cacheRead: 26_765, cacheWrite: 0 })
    expect(formatTurnUsageValidation(occupancyValidationCounters(usage), usage, details(26_766)))
      .toContain("status=ok")
  })

  it("emits empty usage and leaves the ledger alone when occupancy is not yet known", () => {
    const ledger = newOccupancyUsageLedger(details(500))
    expect(occupancyStepUsage({ usedTokens: 0, maxTokens: 256_000 }, ledger)).toEqual({
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    })
    expect(ledger.previousOccupancy).toBe(500)
  })

  it("settles a held Run on its TurnEnded finish to Cursor's own counts", () => {
    const ledger = newOccupancyUsageLedger(details(50_000))
    const steps = [
      occupancyStepUsage(details(60_000), ledger),
      occupancyStepUsage(details(70_000), ledger),
      // Cursor missed its cache once (a full rewrite) and generated 3,000 tokens.
      occupancyStepUsage(details(80_000), ledger, {
        turnEnded: { inputTokens: 200_000, outputTokens: 3_000, cacheRead: 135_000, cacheWrite: 64_990, reasoningTokens: 900 },
      }),
    ]
    const sum = (pick: (usage: (typeof steps)[number]) => number | undefined) =>
      steps.reduce((total, usage) => total + (pick(usage) ?? 0), 0)
    expect(sum((usage) => usage.outputTokens.total)).toBe(3_000)
    expect(sum((usage) => usage.inputTokens.cacheWrite)).toBe(64_990)
    expect(sum((usage) => usage.inputTokens.noCache)).toBe(10)
    expect(steps[2]!.inputTokens).toEqual({ total: 77_002, noCache: 10, cacheRead: 32_000, cacheWrite: 44_992 })
    expect(steps.map(measuredPrompt)).toEqual([60_000, 70_000, 80_000])
  })

  it("moves an over-estimated cache write back to the cache read", () => {
    const ledger = newOccupancyUsageLedger(details(10_000))
    const usage = occupancyStepUsage(details(30_000), ledger, {
      turnEnded: { inputTokens: 29_999, outputTokens: 1, cacheRead: 25_000, cacheWrite: 4_999, reasoningTokens: 0 },
    })
    expect(usage.inputTokens).toEqual({ total: 29_999, noCache: 0, cacheRead: 25_000, cacheWrite: 4_999 })
  })

  it("adds the counters of a Cursor turn the Run continued past", () => {
    const ledger = newOccupancyUsageLedger(details(1_000))
    carryTurnEndedCounters(ledger, { inputTokens: 1_000, outputTokens: 400, cacheRead: 1_000, cacheWrite: 0, reasoningTokens: 0 })
    const usage = occupancyStepUsage(details(2_000), ledger, {
      turnEnded: { inputTokens: 1_400, outputTokens: 200, cacheRead: 1_400, cacheWrite: 0, reasoningTokens: 0 },
    })
    expect(usage.outputTokens.total).toBe(600)
    expect(usage.inputTokens).toEqual({ total: 1_400, noCache: 0, cacheRead: 1_400, cacheWrite: 0 })
  })

  it("leaves the split alone when TurnEnded carries no counters", () => {
    const usage = occupancyStepUsage(details(2_000), newOccupancyUsageLedger(details(1_000)), {
      turnEnded: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
    })
    expect(usage.inputTokens).toEqual({ total: 1_999, noCache: 0, cacheRead: 1_000, cacheWrite: 999 })
  })

  it("keeps every finish's measured prompt at Cursor's occupancy, the same as before the split", () => {
    let seed = 7
    const random = (limit: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % limit
    }
    for (let run = 0; run < 200; run++) {
      const ledger = newOccupancyUsageLedger(random(3) === 0 ? undefined : details(random(400_000)))
      if (random(4) === 0) {
        carryTurnEndedCounters(ledger, {
          inputTokens: random(900_000), outputTokens: random(9_000), cacheRead: random(900_000),
          cacheWrite: random(90_000), reasoningTokens: 0,
        })
      }
      const steps = 1 + random(8)
      for (let step = 0; step < steps; step++) {
        const used = random(5) === 0 ? random(3) : random(950_000)
        const last = step === steps - 1
        const usage = occupancyStepUsage(details(used), ledger, {
          ...(last && random(5) > 0
            ? {
                turnEnded: {
                  inputTokens: random(4_000_000), outputTokens: random(60_000), cacheRead: random(4_000_000),
                  cacheWrite: random(900_000), reasoningTokens: random(1_000),
                },
              }
            : {}),
          growth: random(2) === 0 ? "cacheWrite" : "noCache",
        })
        // The old split sent occupancy - 1 as input and 1 as output: same sum, same measured steps.
        expect(measuredPrompt(usage)).toBe(used)
        expect((usage.inputTokens.total ?? 0) > 0).toBe(used >= 2)
        if (used > 0) expect(usage.outputTokens.total).toBeGreaterThanOrEqual(1)
        else expect(usage.outputTokens.total).toBe(0)
        for (const part of [usage.inputTokens.noCache, usage.inputTokens.cacheRead, usage.inputTokens.cacheWrite]) {
          expect(part).toBeGreaterThanOrEqual(0)
        }
      }
    }
  })

  it("prices a long cold Run near list price instead of as fresh input every step", () => {
    // Opus 5.5 list rates; context grows from 30K to 877K over 40 model calls.
    const rate = { input: 4, output: 20, cache_read: 0.2, cache_write: 5 }
    const occupancy = Array.from({ length: 40 }, (_, step) => Math.round(30_000 + step * (847_000 / 39)))
    const outputPerStep = 400
    const turnEnded = {
      inputTokens: occupancy.reduce((total, used) => total + used - outputPerStep, 0),
      outputTokens: outputPerStep * occupancy.length,
      cacheRead: occupancy.slice(0, -1).reduce((total, used) => total + used, 0),
      cacheWrite: 0,
      reasoningTokens: 0,
    }
    turnEnded.cacheWrite = turnEnded.inputTokens - turnEnded.cacheRead
    const listPrice = (
      turnEnded.cacheRead * rate.cache_read + turnEnded.cacheWrite * rate.cache_write
      + turnEnded.outputTokens * rate.output
    ) / 1_000_000
    const ledger = newOccupancyUsageLedger()
    let cost = 0
    let before = 0
    occupancy.forEach((used, step) => {
      const usage = occupancyStepUsage(details(used), ledger, step === occupancy.length - 1 ? { turnEnded } : {})
      cost += openCodeCost(usage, rate)
      before += ((used - 1) * rate.input + rate.output) / 1_000_000
    })
    expect(Math.abs(cost - listPrice) / listPrice).toBeLessThan(0.02)
    expect(before / listPrice).toBeGreaterThan(8)
  })

  it("does not price a Run's new input twice when Cursor reports it uncached", () => {
    const rate = { input: 4, output: 20, cache_read: 0.2, cache_write: 5 }
    const occupancy = Array.from({ length: 40 }, (_, step) => Math.round(30_000 + step * (847_000 / 39)))
    const inputTokens = occupancy.reduce((total, used) => total + used - 400, 0)
    const cacheRead = occupancy.slice(0, -1).reduce((total, used) => total + used, 0)
    const turnEnded = { inputTokens, outputTokens: 400 * occupancy.length, cacheRead, cacheWrite: 0, reasoningTokens: 0 }
    const listPrice = (
      cacheRead * rate.cache_read + (inputTokens - cacheRead) * rate.input + turnEnded.outputTokens * rate.output
    ) / 1_000_000
    const ledger = newOccupancyUsageLedger()
    let cost = 0
    const steps = occupancy.map((used, step) =>
      occupancyStepUsage(details(used), ledger, step === occupancy.length - 1 ? { turnEnded } : {}))
    for (const usage of steps) cost += openCodeCost(usage, rate)
    // The growth went out as cache writes before TurnEnded said uncached; only the rate differs.
    expect(cost / listPrice).toBeGreaterThan(1)
    expect(cost / listPrice).toBeLessThan(1.15)
    expect(steps.map(measuredPrompt)).toEqual(occupancy)
  })

  it("distinguishes stale category snapshots from occupancy accounting errors", () => {
    for (const usedTokens of [20_347, 40_000]) {
      const stale = {
        usedTokens, maxTokens: 256_000,
        breakdown: {
          totalUsedTokens: 36_122, maxTokens: 256_000,
          categories: [{ id: "conversation", label: "Conversation", estimatedTokens: 36_122 }],
        },
      }
      const usage = occupancyStepUsage(stale, newOccupancyUsageLedger(details(36_122)))
      const validation = formatTurnUsageValidation(occupancyValidationCounters(usage), usage, stale)
      expect(validation).toContain("status=ok")
      expect(validation).toContain(`sentTotal=${usedTokens} totalMatch=true`)
      expect(validation).toContain("breakdownTotal=36122 categorySum=36122 breakdownMatch=stale")
      expect(formatCursorTokenCategories(stale)).toBe("unavailable")
      const malformed = { ...stale, breakdown: { ...stale.breakdown, totalUsedTokens: 36_123 } }
      const malformedUsage = occupancyStepUsage(malformed, newOccupancyUsageLedger(details(36_122)))
      expect(formatTurnUsageValidation(occupancyValidationCounters(malformedUsage), malformedUsage, malformed))
        .toContain("status=mismatch")
    }
  })

  it("validates the TurnEnded finish against what it sends, not against request aggregates", () => {
    const current = {
      usedTokens: 89_575,
      maxTokens: 256_000,
      breakdown: {
        totalUsedTokens: 89_575,
        maxTokens: 256_000,
        categories: [
          { id: "system_prompt", label: "System Prompt", estimatedTokens: 14_980 },
          { id: "conversation", label: "Conversation", estimatedTokens: 74_595 },
        ],
      },
    }
    const turnEnded = { inputTokens: 176_981, outputTokens: 322, cacheRead: 173_440, cacheWrite: 0, reasoningTokens: 0 }
    const usage = occupancyStepUsage(current, newOccupancyUsageLedger(details(87_353)), { turnEnded })
    expect(formatTurnUsageValidation(turnEnded, usage, current, "checkpoint-current-run")).toContain("status=mismatch")
    const validation = formatTurnUsageValidation(occupancyValidationCounters(usage), usage, current, "checkpoint-current-run")
    expect(validation).toContain("status=ok")
    expect(validation).toContain("rawTotal=89575 sentTotal=89575 totalMatch=true")
    expect(validation).toContain("breakdownMatch=true")
  })
})

describe("Cursor cache diagnostics", () => {
  const prior = {
    usedTokens: 40_000,
    maxTokens: 256_000,
    breakdown: {
      totalUsedTokens: 40_000,
      maxTokens: 256_000,
      categories: [
        { id: "system_prompt", label: "System Prompt", estimatedTokens: 1_000 },
        { id: "tools", label: "Tools", estimatedTokens: 9_000 },
        { id: "conversation", label: "Conversation", estimatedTokens: 30_000 },
      ],
    },
  }
  const current = {
    usedTokens: 45_000,
    maxTokens: 256_000,
    breakdown: {
      totalUsedTokens: 45_000,
      maxTokens: 256_000,
      categories: [
        { id: "system_prompt", label: "System Prompt", estimatedTokens: 1_000 },
        { id: "tools", label: "Tools", estimatedTokens: 9_000 },
        { id: "conversation", label: "Conversation", estimatedTokens: 35_000 },
      ],
    },
  }

  it("prints checkpoint categories as compact JSON", () => {
    expect(formatCursorTokenCategories(current)).toBe(
      '{"system_prompt":1000,"tools":9000,"conversation":35000}',
    )
    expect(formatCursorTokenCategories(undefined)).toBe("unavailable")
  })

  it("does not compare categories retained from an older occupancy snapshot", () => {
    for (const [after, before] of [
      [{ ...current, usedTokens: 20_347 }, prior],
      [current, { ...prior, usedTokens: 20_347 }],
    ]) {
      const line = formatCursorCacheDiagnostics(
        { inputTokens: 50_000, outputTokens: 100, cacheRead: 20_000, cacheWrite: 0, reasoningTokens: 0 },
        after, before,
        {
          conversationId: "fixture-conversation", startedWithCheckpoint: true, requestContextReused: true,
          requestContextHash: "fixture", checkpointUpdates: 2, tokenDetailUpdates: 2, pumpPasses: 1,
          stepStarts: 1, stepCompletes: 1, displayToolCalls: 0, execRequests: 1,
        },
      )
      expect(line).toContain("categoryDelta=unavailable")
      expect(line).toContain("sameSizedCategoryTokens=unavailable")
      expect(line).toContain("toolsCategoryChurn=none")
    }
  })

  it("separates warm-prefix evidence from Cursor's aggregate cache ratio", () => {
    expect(formatCursorCacheDiagnostics(
      {
        inputTokens: 50_000,
        outputTokens: 2_000,
        cacheRead: 20_000,
        cacheWrite: 5_000,
        reasoningTokens: 1_000,
      },
      current,
      prior,
      {
        sessionKey: "ses_cache",
        conversationId: "conversation-cache",
        conversationGroupId: "group-cache",
        modelId: "cursor/default",
        startedWithCheckpoint: true,
        requestContextReused: true,
        requestContextHash: "0123456789abcdef-rest",
        systemPromptHash: "fedcba9876543210-rest",
        checkpointUpdates: 4,
        tokenDetailUpdates: 3,
        pumpPasses: 2,
        stepStarts: 3,
        stepCompletes: 3,
        displayToolCalls: 1,
        execRequests: 5,
      },
    )).toBe(
      "cache diagnosis: sessionKey=ses_cache conversationId=conversation-cache " +
      "conversationGroupId=group-cache model=cursor/default continuity=warm " +
      "rawInput=50000 rawCacheRead=20000 " +
      "rawCacheWrite=5000 rawUncached=25000 rawReadRatio=40.0% rawWriteRatio=10.0% " +
      "priorContext=40000 currentContext=45000 contextDelta=5000 " +
      "rawReadVsPriorContext=50.0% sameSizedCategoryTokens=10000 " +
      'categoryDelta={"system_prompt":0,"tools":0,"conversation":5000} ' +
      "toolsCategoryChurn=none " +
      "requestContext=reused requestContextHash=0123456789abcdef " +
      "systemPromptHash=fedcba9876543210 systemPromptSent=false " +
      "checkpointUpdates=4 tokenDetailUpdates=3 " +
      "pumpPasses=2 steps=3/3 displayToolCalls=1 execRequests=5 " +
      "createPlanInTurn=false switchModeInTurn=false " +
      "perModelCallCache=unavailable",
    )
  })

  it("marks a seeded Run as cold instead of implying a cache failure", () => {
    const line = formatCursorCacheDiagnostics(
      {
        inputTokens: 10_000,
        outputTokens: 100,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
      },
      current,
      undefined,
      {
        conversationId: "conversation-cold",
        startedWithCheckpoint: false,
        requestContextReused: false,
        requestContextHash: "abc",
        checkpointUpdates: 1,
        tokenDetailUpdates: 1,
        pumpPasses: 1,
        stepStarts: 1,
        stepCompletes: 1,
        displayToolCalls: 0,
        execRequests: 1,
      },
    )
    expect(line).toContain("continuity=cold")
    expect(line).toContain("priorContext=unavailable")
    expect(line).toContain("rawReadVsPriorContext=n/a")
    expect(line).toContain("sameSizedCategoryTokens=unavailable")
    expect(line).toContain("categoryDelta=unavailable")
    expect(line).toContain("toolsCategoryChurn=none")
    expect(line).toContain("systemPromptSent=true")
  })

  it("flags upstream tools-category churn when the request-context overlay was reused", () => {
    const line = formatCursorCacheDiagnostics(
      {
        inputTokens: 50_000,
        outputTokens: 1_000,
        cacheRead: 25_000,
        cacheWrite: 0,
        reasoningTokens: 0,
      },
      {
        usedTokens: 27_000,
        maxTokens: 256_000,
        breakdown: {
          totalUsedTokens: 27_000,
          maxTokens: 256_000,
          categories: [
            { id: "system_prompt", label: "System Prompt", estimatedTokens: 1_000 },
            { id: "tools", label: "Tools", estimatedTokens: 9_633 },
            { id: "conversation", label: "Conversation", estimatedTokens: 16_367 },
          ],
        },
      },
      {
        usedTokens: 24_000,
        maxTokens: 256_000,
        breakdown: {
          totalUsedTokens: 24_000,
          maxTokens: 256_000,
          categories: [
            { id: "system_prompt", label: "System Prompt", estimatedTokens: 1_000 },
            { id: "tools", label: "Tools", estimatedTokens: 9_000 },
            { id: "conversation", label: "Conversation", estimatedTokens: 14_000 },
          ],
        },
      },
      {
        conversationId: "conversation-tools-churn",
        startedWithCheckpoint: true,
        requestContextReused: true,
        requestContextHash: "abc",
        checkpointUpdates: 2,
        tokenDetailUpdates: 2,
        pumpPasses: 1,
        stepStarts: 1,
        stepCompletes: 1,
        displayToolCalls: 1,
        execRequests: 1,
      },
    )
    expect(line).toContain("toolsCategoryChurn=upstream-stable-overlay")
    expect(line).toContain('"tools":633')
  })

  it("tags Runs where CreatePlan or SwitchMode ran in-turn", () => {
    const line = formatCursorCacheDiagnostics(
      {
        inputTokens: 50_000,
        outputTokens: 1_000,
        cacheRead: 25_000,
        cacheWrite: 0,
        reasoningTokens: 0,
      },
      current,
      undefined,
      {
        conversationId: "conversation-plan-switch-tags",
        startedWithCheckpoint: false,
        requestContextReused: false,
        requestContextHash: "abc",
        checkpointUpdates: 1,
        tokenDetailUpdates: 1,
        pumpPasses: 1,
        stepStarts: 1,
        stepCompletes: 1,
        displayToolCalls: 1,
        execRequests: 1,
        createPlanInTurn: true,
        switchModeInTurn: true,
      },
    )
    expect(line).toContain("createPlanInTurn=true switchModeInTurn=true")
  })
})

describe("sticky-session cache diagnosis", () => {
  const line = (
    inputTokens: number,
    cacheRead: number,
    overrides: { warm?: boolean; reused?: boolean; conversationId?: string; requestContextHash?: string } = {},
  ) => formatCursorCacheDiagnostics(
    { inputTokens, outputTokens: 10, cacheRead, cacheWrite: 0, reasoningTokens: 0 },
    undefined,
    overrides.warm ? { usedTokens: 12_000, maxTokens: 200_000 } : undefined,
    {
      sessionKey: "ses_cache",
      conversationId: overrides.conversationId ?? "conversation-cache",
      conversationGroupId: "group-cache",
      modelId: "cursor/default",
      requestContextHash: overrides.requestContextHash ?? "0123456789abcdef-rest",
      systemPromptHash: "fedcba9876543210-rest",
      checkpointUpdates: 1,
      tokenDetailUpdates: 1,
      pumpPasses: 1,
      stepStarts: 1,
      stepCompletes: 1,
      displayToolCalls: 0,
      execRequests: 1,
      startedWithCheckpoint: !!overrides.warm,
      requestContextReused: overrides.reused ?? !!overrides.warm,
    },
  )
  const seed = line(24_000, 20_000)
  const warm = line(24_500, 24_000, { warm: true })

  it("parses the formatter's fields", () => {
    const parsed = parseCacheDiagnosisLine(warm)
    expect(parsed).toMatchObject({
      continuity: "warm",
      requestContext: "reused",
      systemPromptSent: "false",
      toolsCategoryChurn: "none",
      requestContextHash: "0123456789abcdef",
    })
    expect(readRatio(parsed)).toBe(0.98)
  })

  it("passes a warm reused turn, skipping an interleaved lifecycle Run", () => {
    const title = line(8_000, 4_000, { conversationId: "conversation-title" })
    const verdict = evaluateStickyCacheTurns([seed, title, warm])
    expect(verdict).toMatchObject({ ok: true, failures: [] })
    expect(verdict.seed?.conversationId).toBe("conversation-cache")
  })

  it("fails a cold-only Run and a warm Run that rebuilt context or missed cache", () => {
    expect(evaluateStickyCacheTurns([seed]).failures).toEqual(["no continuity=warm turn"])
    const rebuilt = line(24_500, 10_000, { warm: true, reused: false, requestContextHash: "ffffffffffffffff-rest" })
    expect(evaluateStickyCacheTurns([seed, rebuilt]).failures).toEqual([
      "warm requestContext=built",
      "RequestContext hash changed",
      "rawReadRatio=40.8%",
    ])
  })
})
