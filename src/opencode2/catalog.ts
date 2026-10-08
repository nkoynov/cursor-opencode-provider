import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { CURSOR_PROVIDER_ID } from "../shared.js"
import { CURSOR_WIRE_MODEL_ID_KEY, type ModelInfo } from "../models.js"
import { modelsToConfig } from "../model-config.js"
import { toOpenCode2Costs, type OpenCode2ModelCost, type OpenCodeModelCost } from "../pricing.js"
import type { ConnectionInfo, ModelVariantInfo, ProviderEditor } from "./types.js"

/**
 * In-memory provider registration for the OpenCode 2.0 plugin — the replacement
 * for the classic plugin's `config` hook.
 *
 * Model naming, thinking suffixes, and long-context tiering are NOT reimplemented
 * here: we run the shared `modelsToConfig` and translate its output into the 2.0
 * `Model.Info` shape, so every surface exposes an identical model list.
 */

/** Integration id owning Cursor credentials. Matches the provider id. */
export const CURSOR_INTEGRATION_ID = CURSOR_PROVIDER_ID

const CURSOR_PACKAGE_NAME = "cursor-opencode-provider"

/**
 * `aisdk:` selects OpenCode 2.0's AI SDK path, which is what surfaces the
 * `aisdk.hook("sdk")` / `("language")` extension points we supply the provider
 * through. The suffix is this package's npm name for the host's built-in
 * fallback, which runs `npm.add(pkg)` against the *published* registry,
 * ignoring any local `file://` plugin path this process was loaded from. On
 * OpenCode 2.0.22 that fallback runs before plugin `sdk` hooks
 * (anomalyco/opencode#42788), so the language model always comes from this
 * spec. It is pinned to this package's own version: OpenCode resolves a bare
 * name as `@latest`, which would load whatever was published last.
 *
 * `CURSOR_OPENCODE2_DEV_ENTRY` overrides the suffix with an `aisdk:file://…`
 * spec instead, pointed at a local built entry file (e.g. `dist/index.js`,
 * which exports `createCursor`). The host's fallback recognizes `file://`
 * specs and imports them directly, skipping `npm.add` — the only way to
 * exercise a local build through that fallback path short of publishing.
 * Unset in production; only meant for local `opencode2 run` testing.
 */
export const CURSOR_AISDK_PACKAGE = process.env.CURSOR_OPENCODE2_DEV_ENTRY
  ? `aisdk:${pathToFileURL(process.env.CURSOR_OPENCODE2_DEV_ENTRY).href}`
  : `aisdk:${ownPackageSpec()}`

/**
 * `cursor-opencode-provider@<version>` from this package's own package.json
 * (two levels up from both `src/opencode2/` and `dist/opencode2/`), or the
 * bare name when that file is missing or does not describe this package.
 */
export function ownPackageSpec(
  packageJsonUrl: URL = new URL("../../package.json", import.meta.url),
): string {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { name?: unknown; version?: unknown }
    if (
      pkg.name === CURSOR_PACKAGE_NAME
      && typeof pkg.version === "string"
      && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)
    ) {
      return `${CURSOR_PACKAGE_NAME}@${pkg.version}`
    }
  } catch {
    // Bundled or relocated copies have no package.json beside them.
  }
  return CURSOR_PACKAGE_NAME
}

/**
 * Plain-object `Model.Info` equivalent used by `ctx.provider.transform`.
 */
export type CatalogModelInfo = {
  id: string
  modelID: string
  providerID: string
  name: string
  family?: string
  capabilities: {
    tools: boolean
    input: string[]
    output: string[]
  }
  limit: {
    context: number
    output: number
  }
  variants: ModelVariantInfo[]
  status: "active"
  enabled: true
  time: { released: number }
  cost: OpenCode2ModelCost[]
  settings?: Record<string, unknown>
}

/** Translate one `modelsToConfig` entry into the 2.0 `Model.Info` shape. */
export function modelConfigEntryToInfo(id: string, entry: Record<string, any>): CatalogModelInfo {
  const options = entry.options as Record<string, unknown> | undefined
  // Long-context and Fast entries get synthetic OpenCode ids (`<id>-1m`,
  // `<id>-fast`, `<id>-1m-fast`) while still addressing the same Cursor model
  // on the wire. V1 smuggled that through provider options; 2.0 has a
  // first-class `modelID` for exactly this.
  const wireId =
    typeof options?.[CURSOR_WIRE_MODEL_ID_KEY] === "string"
      ? (options[CURSOR_WIRE_MODEL_ID_KEY] as string)
      : id

  const variants: ModelVariantInfo[] = Object.entries(
    (entry.variants ?? {}) as Record<string, Record<string, unknown>>,
  ).map(([variantId, settings]) => ({ id: variantId, settings: { ...settings } }))

  const inputModalities = Array.isArray(entry.modalities?.input)
    ? entry.modalities.input.filter((modality: unknown): modality is string => typeof modality === "string")
    : ["text"]
  const outputModalities = Array.isArray(entry.modalities?.output)
    ? entry.modalities.output.filter((modality: unknown): modality is string => typeof modality === "string")
    : ["text"]

  const info: CatalogModelInfo = {
    id,
    modelID: wireId,
    providerID: CURSOR_PROVIDER_ID,
    name: entry.name ?? id,
    capabilities: {
      tools: entry.tool_call !== false,
      input: inputModalities,
      output: outputModalities,
    },
    limit: {
      context: entry.limit?.context ?? 200_000,
      output: entry.limit?.output ?? 8192,
    },
    variants,
    status: "active",
    enabled: true,
    time: { released: 0 },
    cost: toOpenCode2Costs(entry.cost as OpenCodeModelCost | undefined),
  }
  if (typeof entry.family === "string" && entry.family.trim()) info.family = entry.family.trim()
  if (options) info.settings = { ...options }
  return info
}

/** Full model map for the in-memory provider inventory. */
export function modelsToCatalogModelMap(models: ModelInfo[]): Record<string, CatalogModelInfo> {
  const config = modelsToConfig(models)
  const out: Record<string, CatalogModelInfo> = {}
  for (const [id, entry] of Object.entries(config)) {
    out[id] = modelConfigEntryToInfo(id, entry as Record<string, any>)
  }
  return out
}

/**
 * Publish discovered Cursor models into the live provider inventory.
 *
 * Skip while empty (keeps the last successful inventory through a no-op
 * transform on first register), replace the definition with `editor.add`,
 * then `ctx.provider.reload()`.
 */
export function applyCursorProviderInventory(
  editor: ProviderEditor,
  models: ModelInfo[],
  sourceConnection?: ConnectionInfo,
): void {
  if (models.length === 0) return

  editor.add({
    info: {
      id: CURSOR_PROVIDER_ID,
      name: "Cursor",
      activation: "enabled",
      package: CURSOR_AISDK_PACKAGE,
      integrationID: CURSOR_INTEGRATION_ID,
    },
    models: Object.values(modelsToCatalogModelMap(models)),
    ...(sourceConnection ? { sourceConnection } : {}),
  })
}
