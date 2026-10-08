import { describe, expect, it, beforeEach } from "bun:test"
import {
  PARALLEL_STEP_IDLE_MS,
  createParallelStep,
  hasSeenToolRequestsListed,
  isParallelStepProgressFrame,
  noteListedCallCount,
  noteParallelStepProgress,
  parallelStepCountMet,
  recordParallelStepEmission,
  resetToolRequestsListedSeenForTests,
  resolveParallelStepCall,
  shouldGuardCloseParallelStep,
  shouldHoldParallelStep,
} from "../src/parallel-step.js"

describe("parallel-step", () => {
  beforeEach(() => {
    resetToolRequestsListedSeenForTests()
  })

  it("does not hold when the process has never seen field 27", () => {
    const step = createParallelStep()
    recordParallelStepEmission(step)
    resolveParallelStepCall(step, "a")
    expect(shouldHoldParallelStep(step)).toBe(false)
  })

  it("holds until the listed count is met once field 27 has been seen", () => {
    const step = createParallelStep()
    noteListedCallCount(step, 3)
    expect(hasSeenToolRequestsListed()).toBe(true)
    recordParallelStepEmission(step)
    resolveParallelStepCall(step, "a")
    expect(shouldHoldParallelStep(step)).toBe(true)
    resolveParallelStepCall(step, "b")
    recordParallelStepEmission(step)
    expect(shouldHoldParallelStep(step)).toBe(true)
    resolveParallelStepCall(step, "c")
    recordParallelStepEmission(step)
    expect(parallelStepCountMet(step)).toBe(true)
    expect(shouldHoldParallelStep(step)).toBe(false)
  })

  it("counts refusals toward the listed total without requiring an emission", () => {
    const step = createParallelStep()
    noteListedCallCount(step, 2)
    resolveParallelStepCall(step, "a")
    resolveParallelStepCall(step, "b")
    expect(parallelStepCountMet(step)).toBe(true)
    expect(step.emitted).toBe(0)
  })

  it("ignores late completions from a prior step", () => {
    const prior = new Set(["old"])
    const step = createParallelStep()
    noteListedCallCount(step, 1)
    expect(resolveParallelStepCall(step, "old", prior)).toBe(false)
    expect(step.resolved.size).toBe(0)
    expect(resolveParallelStepCall(step, "new", prior)).toBe(true)
    expect(parallelStepCountMet(step)).toBe(true)
  })

  it("closes human-gated interactions immediately when the count is unknown", () => {
    // Gate on from an earlier Run in the process.
    noteListedCallCount(createParallelStep(), 1)
    const held = createParallelStep()
    recordParallelStepEmission(held)
    resolveParallelStepCall(held, "q")
    expect(shouldHoldParallelStep(held)).toBe(true)
    expect(shouldHoldParallelStep(held, { humanGatedWithoutCount: true })).toBe(false)
  })

  it("fires the liveness guard after idle without progress", () => {
    const step = createParallelStep()
    noteListedCallCount(step, 3, 1_000)
    noteParallelStepProgress(step, 1_000)
    expect(shouldGuardCloseParallelStep(step, 1_000 + PARALLEL_STEP_IDLE_MS - 1)).toBe(false)
    expect(shouldGuardCloseParallelStep(step, 1_000 + PARALLEL_STEP_IDLE_MS)).toBe(true)
    noteParallelStepProgress(step, 1_000 + PARALLEL_STEP_IDLE_MS)
    expect(shouldGuardCloseParallelStep(step, 1_000 + PARALLEL_STEP_IDLE_MS + 1)).toBe(false)
  })

  it("treats heartbeats as non-progress for the guard", () => {
    expect(isParallelStepProgressFrame({ textDelta: true })).toBe(true)
    expect(isParallelStepProgressFrame({ exec: true })).toBe(true)
    expect(isParallelStepProgressFrame({ toolRequestsListed: true })).toBe(true)
    expect(isParallelStepProgressFrame({})).toBe(false)
  })
})
