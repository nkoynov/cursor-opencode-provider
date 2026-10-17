import { describe, expect, it } from "bun:test"
import { CURSOR_VARIANT_PARAMETERS_KEY, resolveVariantParameters, resolveVariantMaxMode, type ModelInfo, type ModelVariant } from "../src/models.js"
import { modelsToConfig } from "../src/model-config.js"

function variant(context: string, effort: string, fast = false): ModelVariant {
  return {
    key: `${context}-${effort}-${fast}`,
    displayName: `${context} ${effort} ${fast}`,
    isDefaultNonMax: context === "256k" && effort === "high" && fast,
    isDefaultMax: context !== "256k" && effort === "high" && fast,
    parameterValues: [
      { id: "context", value: context },
      { id: "reasoning_effort", value: effort },
      { id: "fast", value: String(fast) },
    ],
  }
}

describe("catalog effort defaults", () => {
  it("uses declared effort defaults for both standard and Fast synthetic catalog entries", () => {
    const model: ModelInfo = {
      id: "composer-2.5",
      variants: ["256k", "1m"].flatMap((context) =>
        ["low", "high"].flatMap((effort) => [false, true].map((fast) => variant(context, effort, fast))),
      ),
    }
    const catalog = modelsToConfig([model])
    const standard = catalog["composer-2.5-1m"].options[CURSOR_VARIANT_PARAMETERS_KEY]
    expect(standard).toEqual(variant("1m", "high").parameterValues)
    expect(catalog["composer-2.5-1m-fast"].options[CURSOR_VARIANT_PARAMETERS_KEY])
      .toEqual(variant("1m", "high", true).parameterValues)
    const picked = standard
    expect(resolveVariantParameters(model, { picked })).toEqual(standard)
    expect(resolveVariantMaxMode(standard, { picked })).toBe(true)
  })
})
