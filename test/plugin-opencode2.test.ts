import { describe, expect, test, beforeEach, afterEach, setSystemTime } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { APICallError } from "@ai-sdk/provider"
import plugin from "../src/plugin-opencode2.js"
import { CursorPlugin } from "../src/plugin.js"
import { applyCursorProviderInventory, CURSOR_AISDK_PACKAGE, modelConfigEntryToInfo, ownPackageSpec } from "../src/opencode2/catalog.js"
import {
  accessTokenFromCredential,
  applyCursorIntegration,
  refreshOAuth,
  requireCursorAccessToken,
} from "../src/opencode2/integration.js"
import { resetAuthRenewalState } from "../src/auth-renewal.js"
import { decodeJwtExpiryMs } from "../src/auth.js"
import { CursorAuthError } from "../src/errors.js"
import { clearCompactionSessions, isCompactionSession, markCompactionSession } from "../src/compaction-marker.js"
import {
  clearSessionDirectories,
  getSessionDirectory,
  markSessionDirectory,
  opencodeDirectoryHeader,
  resolveSessionWorkspaceRoot,
} from "../src/session-directory.js"
import {
  flushHostAgentModeSwitch,
  isHostPlanEntryPending,
  queueHostAgentModeSwitch,
  resetHostAgentModeSwitchForTests,
} from "../src/host-agent-mode.js"
import { consumeCursorShellResult, CURSOR_TIMEOUT_BACKGROUND, registerCursorShellCall, resetCursorShellCalls } from "../src/shell-timeout.js"
import { createManagedTerminal } from "../src/terminal-runner.js"
import { listenForHostSteers, matchEarlySteers, recordEarlySteer, resetHostSteersForTests } from "../src/host-steer.js"
import { toolResultFailure } from "../src/opencode2/tool-results.js"
import { RUNNING_TOOL_CAP_MS, sessionActivity } from "../src/activity.js"
import { onHostInterrupt } from "../src/host-interrupt.js"
import { stageCursorImage } from "../src/image-staging.js"
import { hostPlansDir, opencode2PlanDir, setHostCacheDirOverride, setNativePlansDir } from "../src/context/paths.js"
import { hostSkillFiles, resetHostSkillFilesForTests } from "../src/context/skills.js"
import {
  BUSY_SETTLE_MS,
  pollBackgroundShells,
  resetBackgroundShellNotices,
  watchBackgroundShell,
} from "../src/background-shell-notice.js"
import { writeCache } from "../src/models.js"
import { resetClientVersionCache } from "../src/protocol/client-version.js"
import { MODEL_CACHE_SCHEMA_VERSION } from "../src/shared.js"
import {
  getActiveCursorMode,
  resetActiveCursorModesForTests,
  setActiveCursorMode,
} from "../src/protocol/switch-mode.js"
import type {
  IntegrationDraft,
  IntegrationMethodRegistration,
  ModelInfo2,
  ProviderEditor,
  ProviderInfo,
  PermissionAssertInput,
} from "../src/opencode2/types.js"
import type { ModelInfo } from "../src/models.js"

const DAY_S = 86_400

const setupCleanups: Array<() => Promise<void> | void> = []

/** This plugin's setup always returns its cleanup; fail loudly if it stops doing so. */
async function setupPlugin(ctx: Parameters<typeof plugin.setup>[0], implementation = plugin): Promise<() => Promise<void>> {
  const cleanup = await implementation.setup(ctx)
  if (typeof cleanup !== "function") throw new Error("OpenCode 2.0 plugin setup returned no cleanup")
  let settled = false
  const once = async () => {
    if (settled) return
    settled = true
    await cleanup()
  }
  setupCleanups.push(once)
  return once
}

/** Cursor browser-login session JWT: 60-day life, issue time in `time`. */
function sessionJwt(issuedAgoSec: number): string {
  const issued = Math.floor(Date.now() / 1000) - issuedAgoSec
  const payload = Buffer.from(JSON.stringify({
    type: "session",
    time: String(issued),
    exp: issued + 60 * DAY_S,
    randomness: Math.random().toString(36),
  })).toString("base64url")
  return `h.${payload}.s`
}

function jwtExpiringIn(seconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds, n: Math.random() }))
    .toString("base64url")
  return `h.${payload}.s`
}

/** Run `body` with `fetch` answered by `respond`. */
async function withFetch<T>(respond: (url: string) => Response, body: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => respond(String(input))) as unknown as typeof fetch
  try {
    return await body()
  } finally {
    globalThis.fetch = realFetch
  }
}

// ── Fake provider editor ──

function fakeProviderEditor() {
  const providers = new Map<string, ProviderInfo>()
  const models = new Map<string, ModelInfo2>()
  const editor: ProviderEditor = {
    add(input) {
      providers.set(input.info.id, { ...input.info })
      for (const key of [...models.keys()]) {
        if (key.startsWith(`${input.info.id}/`)) models.delete(key)
      }
      for (const model of input.models) {
        models.set(`${input.info.id}/${model.id}`, { ...model, providerID: input.info.id })
      }
    },
  }
  return { editor, providers, models }
}

/** Host-shaped editor: extra methods exist, but publishing must go through `add`. */
function fakeHostProviderEditor() {
  const inner = fakeProviderEditor()
  const calls: string[] = []
  const unused = (name: string) => {
    calls.push(name)
    throw new Error(`${name} is not how this plugin publishes the Cursor inventory`)
  }
  const editor = {
    list: () => unused("list"),
    get: () => unused("get"),
    add(input: { info: ProviderInfo; models: readonly ModelInfo2[] }) {
      calls.push("add")
      inner.editor.add(input)
    },
    update: () => unused("update"),
    remove: () => unused("remove"),
    models: {
      set: () => unused("models.set"),
      update: () => unused("models.update"),
      remove: () => unused("models.remove"),
    },
  }
  return { editor, providers: inner.providers, models: inner.models, calls }
}

const baseModel: ModelInfo = {
  id: "claude-4.5-sonnet",
  displayName: "Sonnet 4.5",
  supportsAgent: true,
  supportsThinking: false,
  supportsImages: true,
  maxContext: 200_000,
  variants: [],
}

describe("opencode2 provider inventory", () => {
  test("skips registration while the inventory is empty", () => {
    const { editor, providers, models } = fakeProviderEditor()
    applyCursorProviderInventory(editor, [])
    expect(providers.size).toBe(0)
    expect(models.size).toBe(0)
  })

  test("registers the cursor provider on the aisdk path with an integration link", () => {
    const { editor, providers } = fakeProviderEditor()
    applyCursorProviderInventory(editor, [baseModel])

    const provider = providers.get("cursor")
    expect(provider).toBeDefined()
    expect(provider!.package).toBe(CURSOR_AISDK_PACKAGE)
    // `aisdk:` is what selects the hook-driven path we supply the SDK through.
    expect(provider!.package.startsWith("aisdk:")).toBe(true)
    expect(provider!.integrationID).toBe("cursor")
    expect(provider!.activation).toBe("enabled")
  })

  test("pins the aisdk package to this package's own version", () => {
    // A bare name is resolved as `@latest`, so the host would load a newer
    // language model than the plugin the user pinned.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    if (!process.env.CURSOR_OPENCODE2_DEV_ENTRY) {
      expect(CURSOR_AISDK_PACKAGE).toBe(`aisdk:cursor-opencode-provider@${pkg.version}`)
    }
    expect(ownPackageSpec()).toBe(`cursor-opencode-provider@${pkg.version}`)
  })

  test("falls back to the bare package name without a matching package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-pin-"))
    try {
      expect(ownPackageSpec(new URL(`file://${dir}/missing.json`))).toBe("cursor-opencode-provider")
      writeFileSync(join(dir, "other.json"), JSON.stringify({ name: "some-bundle", version: "1.2.3" }))
      expect(ownPackageSpec(new URL(`file://${dir}/other.json`))).toBe("cursor-opencode-provider")
      writeFileSync(join(dir, "range.json"), JSON.stringify({ name: "cursor-opencode-provider", version: "^0.8.0" }))
      expect(ownPackageSpec(new URL(`file://${dir}/range.json`))).toBe("cursor-opencode-provider")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("maps a model into the 2.0 shape", () => {
    const { editor, models } = fakeProviderEditor()
    applyCursorProviderInventory(editor, [baseModel])

    const model = models.get("cursor/claude-4.5-sonnet")
    expect(model).toBeDefined()
    expect(model!.name).toBe("Sonnet 4.5")
    expect(model!.modelID).toBe("claude-4.5-sonnet")
    expect(model!.capabilities.tools).toBe(true)
    expect(model!.capabilities.input).toEqual(["text", "image"])
    expect(model!.capabilities.output).toEqual(["text"])
    expect(model!.limit.context).toBe(200_000)
    expect(model!.enabled).toBe(true)
    // Test fixture uses a legacy id that is not in the current pricing table.
    expect(model!.cost).toEqual([])
    expect(model!.family).toBe("claude-sonnet")
  })

  test("preserves non-empty family metadata and omits absent or blank metadata", () => {
    expect(modelConfigEntryToInfo("example", { family: "  custom-family  " }).family).toBe("custom-family")
    for (const family of [undefined, "", "   "]) {
      expect(modelConfigEntryToInfo("example", { family })).not.toHaveProperty("family")
    }
  })

  test("publishes canonical families for wire ids with context and speed suffixes", () => {
    const { editor, models } = fakeProviderEditor()
    const entries = [
      ["gpt-5.4-1m", "gpt"],
      ["claude-sonnet-4-1m", "claude-sonnet"],
      ["grok-4.7-fast", "grok"],
      ["kimi-k2.7-code", "kimi-k2"],
    ] as const
    applyCursorProviderInventory(editor, entries.map(([id]) => ({ id, variants: [] })))
    for (const [id, family] of entries) {
      expect(models.get(`cursor/${id}`)).toMatchObject({ id, modelID: id, family })
    }
  })

  test("attaches published Cursor token rates to catalog cost tiers", () => {
    const { editor, models } = fakeProviderEditor()
    applyCursorProviderInventory(editor, [
      {
        ...baseModel,
        id: "claude-sonnet-4-5",
        displayName: "Sonnet 4.5",
      },
    ])

    const model = models.get("cursor/claude-sonnet-4-5")
    expect(model!.cost).toEqual([
      {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    ])
  })

  test("long-context entries keep a distinct id but address the same wire model", () => {
    const { editor, models } = fakeProviderEditor()
    applyCursorProviderInventory(editor, [
      {
        ...baseModel,
        maxContextForMaxMode: 1_000_000,
        variants: [
          {
            key: "base",
            displayName: "Sonnet 4.5",
            parameterValues: [],
            isDefaultNonMax: true,
            isDefaultMax: false,
          },
          {
            key: "max",
            displayName: "Sonnet 4.5 1M",
            parameterValues: [{ id: "context", value: "1000000" }],
            isDefaultNonMax: false,
            isDefaultMax: true,
          },
        ],
      },
    ])

    const long = models.get("cursor/claude-4.5-sonnet-1m")
    expect(long).toBeDefined()
    // Synthetic OpenCode id, real Cursor id on the wire.
    expect(long!.id).toBe("claude-4.5-sonnet-1m")
    expect(long!.modelID).toBe("claude-4.5-sonnet")
    expect(long!.limit.context).toBe(1_000_000)
    expect(long!.family).toBe("claude-sonnet")
  })

  test("Fast entries keep a distinct id but address the same wire model", () => {
    const { editor, models } = fakeProviderEditor()
    applyCursorProviderInventory(editor, [
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        supportsAgent: true,
        variants: [
          {
            key: "slow",
            displayName: "Composer 2.5",
            parameterValues: [{ id: "fast", value: "false" }],
            isDefaultNonMax: true,
            isDefaultMax: false,
          },
          {
            key: "fast",
            displayName: "Composer 2.5 Fast",
            parameterValues: [{ id: "fast", value: "true" }],
            isDefaultNonMax: false,
            isDefaultMax: true,
          },
        ],
      },
    ])

    const fast = models.get("cursor/composer-2.5-fast")
    expect(fast).toBeDefined()
    expect(fast!.id).toBe("composer-2.5-fast")
    expect(fast!.modelID).toBe("composer-2.5")
    expect(fast!.name).toBe("Composer 2.5 Fast")
    expect(fast!.family).toBe("composer")
    expect(fast!.cost).toEqual([
      {
        input: 3,
        output: 15,
        cache: { read: 0.5, write: 0 },
      },
    ])
  })

  test("variants become an array carrying their parameters in settings", () => {
    const { editor, models } = fakeProviderEditor()
    applyCursorProviderInventory(editor, [
      {
        ...baseModel,
        variants: [
          {
            key: "thinking",
            displayName: "Sonnet 4.5 Thinking",
            parameterValues: [{ id: "thinking", value: "true" }],
            isDefaultNonMax: true,
            isDefaultMax: false,
          },
        ],
      },
    ])

    const model = models.get("cursor/claude-4.5-sonnet")!
    expect(Array.isArray(model.variants)).toBe(true)
    expect(model.variants).toHaveLength(1)
    expect(model.variants[0].id).toBe("Sonnet 4.5 Thinking")
    expect(model.variants[0].settings).toBeDefined()
  })

  test("re-applying is idempotent (host replays transforms on reload)", () => {
    const { editor, models, providers } = fakeProviderEditor()
    applyCursorProviderInventory(editor, [baseModel])
    applyCursorProviderInventory(editor, [baseModel])

    expect(providers.size).toBe(1)
    expect(models.size).toBe(1)
  })

  test("replaces the previous inventory instead of merging", () => {
    const { editor, models } = fakeProviderEditor()
    applyCursorProviderInventory(editor, [
      baseModel,
      { ...baseModel, id: "gpt-5", displayName: "GPT-5" },
    ])
    expect(models.has("cursor/gpt-5")).toBe(true)

    applyCursorProviderInventory(editor, [baseModel])
    expect([...models.keys()]).toEqual(["cursor/claude-4.5-sonnet"])
  })

  test("binds sourceConnection onto editor.add when provided", () => {
    const seen: unknown[] = []
    const editor: ProviderEditor = {
      add(input) {
        seen.push(input.sourceConnection)
      },
    }
    applyCursorProviderInventory(editor, [baseModel], { type: "env", name: "CURSOR_API_KEY" })
    expect(seen).toEqual([{ type: "env", name: "CURSOR_API_KEY" }])
  })

  test("publishes through editor.add on a host-shaped editor", () => {
    const { editor, providers, models, calls } = fakeHostProviderEditor()
    applyCursorProviderInventory(editor, [baseModel])

    expect(calls).toEqual(["add"])
    expect(providers.get("cursor")?.package.startsWith("aisdk:")).toBe(true)
    expect(models.get("cursor/claude-4.5-sonnet")?.modelID).toBe("claude-4.5-sonnet")
  })
})

// ── Fake integration draft ──

function fakeIntegrationDraft() {
  const refs = new Map<string, { id: string; name: string }>()
  const methods: IntegrationMethodRegistration[] = []
  const draft: IntegrationDraft = {
    update(id, update) {
      const current = refs.get(id) ?? { id, name: id }
      refs.set(id, current)
      update(current)
    },
    method: {
      update(input) {
        methods.push(input)
      },
    },
  }
  return { draft, refs, methods }
}

describe("opencode2 integration", () => {
  beforeEach(() => resetAuthRenewalState())

  test("registers oauth, key, and env connection methods", () => {
    const { draft, refs, methods } = fakeIntegrationDraft()
    applyCursorIntegration(draft)

    expect(refs.get("cursor")?.name).toBe("Cursor")
    const types = methods.map((m) => m.method.type)
    expect(types).toContain("oauth")
    expect(types).toContain("key")
    expect(types).toContain("env")
  })

  test("the oauth method supplies authorize and refresh", () => {
    const { draft, methods } = fakeIntegrationDraft()
    applyCursorIntegration(draft)

    const oauth = methods.find((m) => m.method.type === "oauth")
    expect(oauth).toBeDefined()
    // Promise-valued in 2.0 (Effect-valued in the 1.18 v2 API).
    expect(typeof (oauth as any).authorize).toBe("function")
    expect(typeof (oauth as any).refresh).toBe("function")
  })

  test("env method advertises CURSOR_API_KEY", () => {
    const { draft, methods } = fakeIntegrationDraft()
    applyCursorIntegration(draft)

    const env = methods.find((m) => m.method.type === "env")
    expect((env!.method as any).names).toContain("CURSOR_API_KEY")
  })

  test("a session credential that is not due is used as-is, without a request", async () => {
    const jwt = sessionJwt(DAY_S)
    const token = await withFetch(() => { throw new Error("no request expected") }, () =>
      accessTokenFromCredential({ type: "oauth", methodID: "oauth", access: jwt, refresh: jwt, expires: 0 }))
    expect(token).toBe(jwt)
  })

  test("an already-exchanged key credential is passed through unchanged", async () => {
    // Non-`crsr_` keys are treated as JWTs, so no network exchange is attempted.
    const token = await accessTokenFromCredential({ type: "key", key: "example-already-token" })
    expect(token).toBe("example-already-token")
  })

  test("a raw key credential is exchanged once and cached", async () => {
    let exchanges = 0
    const exchanged = jwtExpiringIn(3600)
    const fetchStub = (url: string) => {
      if (!url.includes("/auth/exchange_user_api_key")) throw new Error(`unexpected ${url}`)
      exchanges++
      return Response.json({ accessToken: exchanged, refreshToken: "unused" })
    }
    const first = await withFetch(fetchStub, () => accessTokenFromCredential({ type: "key", key: "crsr_o2" }))
    const second = await withFetch(fetchStub, () => accessTokenFromCredential({ type: "key", key: "crsr_o2" }))
    expect([first, second]).toEqual([exchanged, exchanged])
    expect(exchanges).toBe(1)
  })

  test("a missing credential raises a sign-in error", async () => {
    const error = await accessTokenFromCredential(undefined).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CursorAuthError)
  })

  test("refresh renews through /oauth/token and stores the JWT expiry as expires", async () => {
    const old = sessionJwt(16 * DAY_S)
    const fresh = sessionJwt(0)
    const paths: string[] = []
    const renewed = await withFetch((url) => {
      paths.push(new URL(url).pathname)
      return Response.json({ access_token: fresh, id_token: "id", shouldLogout: false })
    }, () => refreshOAuth({ type: "oauth", methodID: "oauth", access: old, refresh: old, expires: 0, metadata: { a: 1 } }))
    expect(paths).toEqual(["/oauth/token"])
    expect(renewed).toEqual({
      type: "oauth",
      methodID: "oauth",
      access: fresh,
      refresh: fresh,
      expires: decodeJwtExpiryMs(fresh)!,
      metadata: { a: 1 },
    })
  })

  test("refresh keeps a valid session through a transient failure and asks again later", async () => {
    const old = sessionJwt(16 * DAY_S)
    const credential = { type: "oauth" as const, methodID: "oauth", access: old, refresh: old, expires: 0 }
    const result = await withFetch(() => new Response("down", { status: 503 }), () => refreshOAuth(credential))
    expect(result.access).toBe(old)
    expect(result.expires).toBeGreaterThan(Date.now())
    expect(result.expires).toBeLessThan(Date.now() + 60 * 60_000)
  })

  test("refresh throws when Cursor ended the session", async () => {
    const old = sessionJwt(16 * DAY_S)
    const error = await withFetch(
      () => Response.json({ access_token: "", id_token: "", shouldLogout: true }),
      () => refreshOAuth({ type: "oauth", methodID: "oauth", access: old, refresh: old, expires: 0 }),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CursorAuthError)
  })

  test("refresh hands the host a session this process already renewed in memory", async () => {
    const old = sessionJwt(16 * DAY_S)
    const fresh = sessionJwt(0)
    let requests = 0
    const stub = () => {
      requests++
      return Response.json({ access_token: fresh, shouldLogout: false })
    }
    const legacy = { type: "oauth" as const, methodID: "oauth", access: old, refresh: old, expires: Date.now() + 44 * DAY_S * 1000 }
    expect(await withFetch(stub, () => accessTokenFromCredential(legacy))).toBe(fresh)
    const handed = await withFetch(stub, () => refreshOAuth(legacy))
    expect(handed.access).toBe(fresh)
    expect(requests).toBe(1)
  })

  test("requireCursorAccessToken keeps a classified host error and wraps others", async () => {
    const domain = (resolve: () => Promise<any>) => ({
      transform: async () => ({ dispose: async () => {} }),
      reload: async () => {},
      connection: { active: async () => ({ type: "credential", id: "c", label: "l" }), resolve },
    }) as any
    const classified = new CursorAuthError("ended", { code: "session_logout" })
    expect(await requireCursorAccessToken(domain(async () => { throw classified })).catch((e: unknown) => e)).toBe(classified)
    const wrapped = await requireCursorAccessToken(domain(async () => { throw new Error("db down") })).catch((e: unknown) => e)
    expect(wrapped).toBeInstanceOf(CursorAuthError)
    expect((wrapped as Error).message).toContain("db down")
  })
})

describe("compaction marker", () => {
  beforeEach(() => clearCompactionSessions())

  test("records and clears by session id", () => {
    markCompactionSession("s1", true)
    expect(isCompactionSession("s1")).toBe(true)
    markCompactionSession("s1", false)
    expect(isCompactionSession("s1")).toBe(false)
  })

  test("ignores unknown and undefined session ids", () => {
    expect(isCompactionSession("nope")).toBe(false)
    expect(isCompactionSession(undefined)).toBe(false)
  })

  test("is bounded so a long-lived server cannot leak session ids", () => {
    for (let i = 0; i < 300; i++) markCompactionSession(`s${i}`, true)
    // Oldest entries evicted; newest retained.
    expect(isCompactionSession("s299")).toBe(true)
    expect(isCompactionSession("s0")).toBe(false)
  })
})

describe("opencode2 plugin shape", () => {
  test("default export is a 2.0 plugin definition", () => {
    expect(plugin.id).toBe("cursor.provider")
    expect(typeof plugin.setup).toBe("function")
    expect(plugin.server).toBe(CursorPlugin)
  })
})

// ── setup() against a fake host context ──

function fakeContext(events: readonly unknown[] = []) {
  const registered: string[] = []
  const disposed: string[] = []
  const reloads: string[] = []
  const hooks = new Map<string, (input: any) => any>()
  const transforms = new Map<string, (draft: any) => void>()
  const inventory = fakeProviderEditor()

  const registration = (label: string) => {
    registered.push(label)
    return { dispose: async () => void disposed.push(label) }
  }
  const hookDomain = (domain: string) => ({
    hook: async (name: string, callback: (input: any) => any, options?: { providerID?: string }) => {
      // Mirror the host's ModelHookOptions scoping: a scoped hook skips events
      // for any other provider (opencode `packages/core/src/plugin/hooks.ts`).
      hooks.set(`${domain}.${name}`, (input: any) =>
        options?.providerID !== undefined && options.providerID !== input?.model?.providerID
          ? undefined
          : callback(input),
      )
      return registration(`${domain}.${name}`)
    },
  })
  const transformDomain = (domain: string) => ({
    transform: async (callback: (draft: any) => void) => {
      transforms.set(domain, callback)
      return registration(`${domain}.transform`)
    },
    reload: async () => {},
  })

  let activeConnection: any = undefined
  const sessionLocations = new Map<string, string>()
  const sessionPermissions = new Map<string, unknown>()

  const ctx: any = {
    app: { name: "opencode", version: "2.0", channel: "latest" },
    location: { directory: "/workspace" },
    options: {},
    aisdk: hookDomain("aisdk"),
    event: {
      subscribe: () => events.length
        ? (async function* () {
            for (const event of events) yield event
          })()
        : undefined,
    },
    integration: {
      ...transformDomain("integration"),
      connection: {
        active: async () => activeConnection,
        resolve: async () => undefined,
      },
    },
    session: {
      ...hookDomain("session"),
      get: async ({ sessionID }: { sessionID: string }) => {
        const directory = sessionLocations.get(sessionID)
        if (!directory) throw new Error(`no fake location for session ${sessionID}`)
        const permissions = sessionPermissions.get(sessionID)
        return {
          id: sessionID,
          location: { directory },
          ...(permissions !== undefined ? { permissions } : {}),
        }
      },
      switchAgent: async () => {},
      synthetic: async () => ({}),
      prompt: async () => ({}),
    },
    websearch: transformDomain("websearch"),
    mcp: transformDomain("mcp"),
    shell: hookDomain("shell"),
    provider: {
      transform: async (callback: (editor: any) => void) => {
        transforms.set("provider", callback)
        return registration("provider.transform")
      },
      reload: async () => {
        reloads.push("provider")
        transforms.get("provider")?.(inventory.editor)
      },
    },
  }
  ctx.tool = {
    hook: hookDomain("tool").hook,
    transform: transformDomain("tool").transform,
    reload: async () => void reloads.push("tool"),
  }

  return { ctx, registered, disposed, hooks, transforms, sessionLocations, sessionPermissions, reloads, inventory }
}

/** OpenCode's process-wide event stream: every subscriber gets every Location's events until it aborts. */
function fakeEventBus() {
  const subscribers = new Set<(event: unknown) => void>()
  const subscribe = ({ signal }: { signal?: AbortSignal } = {}) => {
    const queue: unknown[] = []
    let wake: (() => void) | undefined
    const push = (event: unknown) => { queue.push(event); wake?.() }
    subscribers.add(push)
    return (async function* () {
      try {
        while (!signal?.aborted) {
          if (queue.length) { yield queue.shift(); continue }
          await new Promise<void>((resolve) => {
            wake = resolve
            signal?.addEventListener("abort", () => resolve(), { once: true })
          })
          wake = undefined
        }
      } finally { subscribers.delete(push) }
    })()
  }
  const publish = async (event: unknown) => {
    for (const push of subscribers) push(event)
    await Bun.sleep(5)
  }
  return { subscribe, publish }
}

describe("opencode2 setup", () => {
  beforeEach(() => {
    resetHostAgentModeSwitchForTests()
    resetActiveCursorModesForTests()
    setNativePlansDir(undefined)
    resetBackgroundShellNotices({ manualPolling: true })
  })

  afterEach(() => {
    resetBackgroundShellNotices()
  })

  const BG_SHELL_ID = 4343
  const finishedTerminalFile = (dir: string, output: string) => {
    const file = join(dir, `${BG_SHELL_ID}.txt`)
    writeFileSync(file, [
      "---",
      `pid: ${process.pid}`,
      'cwd: "/tmp"',
      'command: "sleep 90; echo done"',
      "status: succeeded",
      "started_at: 2026-10-07T10:00:00Z",
      "running_for_ms: 90000          ",
      "---",
      `${output}`,
      "---",
      "exit_code: 0",
      "elapsed_ms: 90000",
      "ended_at: 2026-10-07T10:01:30Z",
      "---",
      "",
    ].join("\n"))
    return file
  }

  test("a Cursor background shell's end reaches its session through session.synthetic", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-oc2-bg-"))
    try {
      const { ctx, hooks } = fakeContext()
      const posted: any[] = []
      ctx.session.synthetic = async (input: any) => void posted.push(input)
      const cleanup = await setupPlugin(ctx)
      const executionID = "cursor_bg_notice"
      registerCursorShellCall(executionID, {
        background_shell_spawn: true,
        command: "sleep 90; echo done",
        working_directory: "/tmp",
      })
      const file = finishedTerminalFile(dir, "done\n")
      const raw = `__CURSOR_BACKGROUND_SHELL__${BG_SHELL_ID}:${process.pid}:${file}\n`
      await hooks.get("tool.execute.after")!({
        tool: "shell",
        sessionID: "ses_bg",
        agent: "build",
        messageID: "message",
        id: executionID,
        input: { command: "sleep 90; echo done" },
        status: "completed",
        result: { output: { output: raw, status: "completed", truncated: false }, content: [{ type: "text", text: raw }], metadata: {} },
      })
      const now = Date.now()
      pollBackgroundShells(now)
      expect(posted).toEqual([])
      pollBackgroundShells(now + BUSY_SETTLE_MS)
      expect(posted).toHaveLength(1)
      expect(posted[0].sessionID).toBe("ses_bg")
      expect(posted[0].description).toBe("sleep 90; echo done")
      expect(posted[0].text).toStartWith(`<system-update>\n<shell id="${BG_SHELL_ID}" state="completed" command="sleep 90; echo done">`)
      expect(posted[0].text).toContain(`finished with exit code 0 after 1m 30s.\nIts output (also in ${file}):\ndone\n</shell>`)
      await cleanup()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a foreground Cursor shell is not watched", async () => {
    const { ctx, hooks } = fakeContext()
    const posted: any[] = []
    ctx.session.synthetic = async (input: any) => void posted.push(input)
    const cleanup = await setupPlugin(ctx)
    const executionID = "cursor_fg_shell"
    registerCursorShellCall(executionID, { shell_stream: true, command: "true", working_directory: "/tmp", timeout_ms: 30_000 })
    await hooks.get("tool.execute.after")!({
      tool: "shell",
      sessionID: "ses_fg",
      agent: "build",
      messageID: "message",
      id: executionID,
      input: { command: "true" },
      status: "completed",
      result: { output: { output: "", status: "completed", truncated: false }, content: [], metadata: { exit: 0 } },
    })
    pollBackgroundShells(Date.now() + BUSY_SETTLE_MS * 10)
    expect(posted).toEqual([])
    await cleanup()
  })

  test("a session's Stop, seen on the event stream, keeps a held note from starting a turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-oc2-bg-"))
    try {
      const file = finishedTerminalFile(dir, "")
      const posted: any[] = []
      const notifier = async (input: any) => void posted.push(input)
      watchBackgroundShell({ sessionID: "ses_stop", shellId: BG_SHELL_ID, pid: process.pid, file, command: "make test", notifier })
      const { ctx } = fakeContext([{ type: "session.execution.interrupted", data: { sessionID: "ses_stop", reason: "user" } }])
      ctx.session.synthetic = notifier
      const cleanup = await setupPlugin(ctx)
      await new Promise((resolve) => setTimeout(resolve, 10))
      pollBackgroundShells(Date.now())
      expect(posted).toHaveLength(1)
      expect(posted[0].resume).toBe(false)
      await cleanup()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("cleanup stops a setup posting notes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-oc2-bg-"))
    try {
      const { ctx } = fakeContext([{ type: "session.execution.succeeded", data: { sessionID: "ses_gone" } }])
      const posted: any[] = []
      ctx.session.synthetic = async (input: any) => void posted.push(input)
      const cleanup = await setupPlugin(ctx)
      await cleanup()
      watchBackgroundShell({ sessionID: "ses_gone", shellId: BG_SHELL_ID, pid: process.pid, file: finishedTerminalFile(dir, ""), command: "x", notifier: ctx.session.synthetic })
      pollBackgroundShells(Date.now() + BUSY_SETTLE_MS)
      expect(posted).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  afterEach(async () => {
    const pending = setupCleanups.splice(0)
    for (const cleanup of pending.reverse()) await cleanup()
    setNativePlansDir(undefined)
    resetCursorShellCalls()
  })

  test("reloads the provider inventory from cache without writing opencode.json", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "cursor-oc2-plugin-config-"))
    const cacheDir = mkdtempSync(join(tmpdir(), "cursor-oc2-plugin-cache-"))
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = configDir
    setHostCacheDirOverride(cacheDir)
    try {
      await writeCache(cacheDir, {
        models: [baseModel],
        fetchedAt: Date.now(),
        schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
      })
      const { ctx, registered, reloads, inventory } = fakeContext()

      const cleanup = await setupPlugin(ctx)

      expect(registered).toContain("provider.transform")
      expect(reloads).toEqual(["provider"])
      expect(inventory.providers.get("cursor")?.package).toContain("aisdk:")
      expect(inventory.providers.get("cursor")?.integrationID).toBe("cursor")
      expect(inventory.models.get(`cursor/${baseModel.id}`)?.providerID).toBe("cursor")
      expect(existsSync(join(configDir, "opencode.json"))).toBe(false)
      expect(existsSync(join(configDir, "opencode.jsonc"))).toBe(false)
      await cleanup()
    } finally {
      setHostCacheDirOverride(undefined)
      if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
      rmSync(configDir, { recursive: true, force: true })
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("does not rewrite an existing opencode.json", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "cursor-oc2-plugin-broken-"))
    const cacheDir = mkdtempSync(join(tmpdir(), "cursor-oc2-plugin-cache-"))
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = configDir
    setHostCacheDirOverride(cacheDir)
    const existing = '{ "plugin": ["example"] }\n'
    const path = join(configDir, "opencode.json")
    writeFileSync(path, existing)
    try {
      await writeCache(cacheDir, {
        models: [baseModel],
        fetchedAt: Date.now(),
        schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
      })
      const { ctx } = fakeContext()
      const cleanup = await setupPlugin(ctx)
      expect(readFileSync(path, "utf8")).toBe(existing)
      await cleanup()
    } finally {
      setHostCacheDirOverride(undefined)
      if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
      rmSync(configDir, { recursive: true, force: true })
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("writes CreatePlan plans in OpenCode 2.0's Plan directory", async () => {
    const { ctx } = fakeContext()
    const cleanup = await setupPlugin(ctx)
    expect(hostPlansDir()).toBe(opencode2PlanDir())
    await cleanup()
    expect(hostPlansDir()).not.toBe(opencode2PlanDir())
  })

  test("puts MCP tools on the direct catalog without editing server config", async () => {
    const { ctx, transforms } = fakeContext()
    const cleanup = await setupPlugin(ctx)
    const servers: Record<string, { type: string; codemode?: boolean }> = {
      github: { type: "local" },
      executor: { type: "local", codemode: true },
    }
    const tools = [
      { id: "github_create_pull_request", options: { namespace: "github", codemode: true as boolean | undefined, permission: "github_create_pull_request" } },
      { id: "executor_run", options: { namespace: "executor", codemode: true as boolean | undefined } },
      { id: "opencode_session_rename", options: { namespace: "opencode", codemode: true as boolean | undefined } },
    ]
    const applyTools = () => {
      transforms.get("tool")?.({
        add: () => {},
        list: () => tools,
        update: (id: string, update: (tool: (typeof tools)[number]) => void) => {
          const tool = tools.find((item) => item.id === id)
          if (tool) update(tool)
        },
      })
    }

    applyTools()
    expect(tools[0]?.options.codemode).toBe(true)

    transforms.get("mcp")?.({ list: () => Object.entries(servers) })
    expect(servers.github?.codemode).toBeUndefined()
    expect(servers.executor?.codemode).toBe(true)

    applyTools()
    expect(tools[0]?.options).toEqual({
      namespace: "github",
      permission: "github_create_pull_request",
      codemode: false,
    })
    expect(tools[1]?.options.codemode).toBe(true)
    expect(tools[2]?.options.codemode).toBe(true)

    // Discovery reloads rebuild from the host's original registrations, then
    // replay this transform over newly discovered tools too.
    tools.push({ id: "github_search", options: { namespace: "github", codemode: true } })
    applyTools()
    expect(tools[3]?.options.codemode).toBe(false)

    servers.github!.codemode = true
    transforms.get("mcp")?.({ list: () => Object.entries(servers) })
    for (const tool of tools) tool.options.codemode = true
    applyTools()
    expect(tools[0]?.options.codemode).toBe(true)
    expect(tools[3]?.options.codemode).toBe(true)

    delete servers.github
    transforms.get("mcp")?.({ list: () => Object.entries(servers) })
    applyTools()
    expect(tools[0]?.options.codemode).toBe(true)
    await cleanup()
  })

  test("reloads tools when MCP namespaces arrive after the tool catalog was built", async () => {
    const { ctx, transforms, reloads } = fakeContext()
    const tools = [
      { id: "linear_list_issues", options: { namespace: "linear", codemode: true as boolean | undefined } },
    ]
    const applyTools = () => {
      transforms.get("tool")?.({
        add: () => {},
        list: () => tools,
        update: (id: string, update: (tool: (typeof tools)[number]) => void) => {
          const tool = tools.find((item) => item.id === id)
          if (tool) update(tool)
        },
      })
    }
    ctx.tool.reload = async () => {
      reloads.push("tool")
      applyTools()
    }
    const cleanup = await plugin.setup(ctx)
    const servers = () => [["linear", { type: "remote" }]] as const
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

    // A plugin reload can rebuild the tool registry before the MCP registry.
    applyTools()
    expect(tools[0]?.options.codemode).toBe(true)

    transforms.get("mcp")?.({ list: servers })
    await settle()
    expect(reloads.filter((domain) => domain === "tool")).toEqual(["tool"])
    expect(tools[0]?.options).toEqual({ namespace: "linear", codemode: false })

    transforms.get("mcp")?.({ list: servers })
    await settle()
    expect(reloads.filter((domain) => domain === "tool")).toEqual(["tool"])
    if (typeof cleanup === "function") await cleanup()
  })

  test("sets up on a host without the mcp domain", async () => {
    const { ctx, registered } = fakeContext()
    delete ctx.mcp
    const cleanup = await setupPlugin(ctx)
    expect(registered).not.toContain("mcp.transform")
    expect(registered).toContain("provider.transform")
    await cleanup()
  })

  test("registers every domain it needs and returns a cleanup", async () => {
    const { ctx, registered, transforms } = fakeContext()
    const cleanup = await setupPlugin(ctx)

    expect(registered).toContain("integration.transform")
    expect(registered).toContain("provider.transform")
    expect(registered).toContain("aisdk.sdk")
    expect(registered).toContain("aisdk.language")
    expect(registered).toContain("tool.transform")
    expect(registered).toContain("tool.execute.before")
    expect(registered).toContain("tool.execute.after")
    expect(registered).toContain("session.context")
    expect(registered).toContain("session.compaction")
    expect(registered).toContain("session.generate")
    expect(registered).toContain("session.title")
    expect(registered).toContain("shell.create.before")
    expect(registered).toContain("websearch.transform")
    expect(registered).toContain("mcp.transform")
    expect(typeof cleanup).toBe("function")

    const tools: Array<{
      name: string
      output?: unknown
      options?: { codemode?: boolean }
    }> = []
    transforms.get("tool")!({ add: (tool: { name: string; output?: unknown; options?: { codemode?: boolean } }) => tools.push(tool) })
    expect(tools.map((tool) => tool.name)).toEqual(["cursor_image_save"])
    expect(tools[0]?.options?.codemode).toBe(false)
    expect(tools[0]?.output).toBeDefined()
  })

  test("registers cursor_image_save and leaves web search to the host tool", async () => {
    const { ctx, transforms } = fakeContext()
    await setupPlugin(ctx)
    const tools: Array<{ name: string; options?: { permission?: string; codemode?: boolean } }> = []
    transforms.get("tool")!({
      add: (tool: { name: string; options?: { permission?: string; codemode?: boolean } }) => tools.push(tool),
      get: (id: string) => id === "websearch"
        ? { id: "websearch", name: "websearch", description: "", input: {}, execute: async () => ({}) }
        : undefined,
    })
    expect(tools.map((t) => t.name)).toEqual(["cursor_image_save"])
    expect(tools[0]?.options).toEqual({ codemode: false, permission: "edit" })
    expect(tools.map((t) => t.name)).not.toContain("custom_websearch")
  })

  test("cursor_image_save obtains per-path native permission before committing staged bytes", async () => {
    const { ctx, transforms, sessionLocations } = fakeContext()
    await setupPlugin(ctx)
    let registered: {
      execute: (
        input: { image_id: string },
        context: { sessionID: string },
      ) => Promise<{ output: { bytes: number }; content: string }>
    } | undefined
    transforms.get("tool")!({ add: (tool: typeof registered) => {
      registered = tool
    } })
    const workspace = mkdtempSync(join(tmpdir(), "oc2-img-ws-"))
    const projectDir = mkdtempSync(join(tmpdir(), "oc2-img-proj-"))
    sessionLocations.set("ses_img", workspace)
    const permissions: PermissionAssertInput[] = []
    ctx.permission = { assert: async (input: PermissionAssertInput) => { permissions.push(input) } }
    try {
      const target = join(projectDir, "assets", "dot.png")
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
      const image_id = stageCursorImage({ path: target, projectDir, mime: "image/png", data: png })
      const context = { sessionID: "ses_img", agent: "build", messageID: "msg_img", id: "cursor_img" }
      const result = await registered!.execute({ image_id }, context)
      expect(result.output.bytes).toBe(png.length)
      expect(readFileSync(target)).toEqual(Buffer.from(png))
      expect(permissions.map(input => input.action)).toEqual(["external_directory", "edit"])
      expect(permissions[1]).toMatchObject({
        sessionID: "ses_img", agent: "build",
        source: { type: "tool", messageID: "msg_img", id: "cursor_img" },
      })
      expect(permissions[1]!.resources[0]).not.toContain("../")
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test.each(["plan-deny", "user-decline", "no-permission-api"] as const)(
    "cursor_image_save writes nothing after %s", async outcome => {
      const { ctx, transforms, sessionLocations } = fakeContext()
      await setupPlugin(ctx)
      let execute!: (input: { image_id: string }, context: {
        sessionID: string; agent: string; messageID: string; id: string;
      }) => Promise<unknown>
      transforms.get("tool")!({ add: (tool: { execute: typeof execute }) => { execute = tool.execute } })
      const workspace = mkdtempSync(join(tmpdir(), "oc2-img-deny-"))
      sessionLocations.set("ses_img_deny", workspace)
      const refusal = new Error(outcome)
      const seen: PermissionAssertInput[] = []
      if (outcome !== "no-permission-api") {
        ctx.permission = { assert: async (input: PermissionAssertInput) => {
          seen.push(input)
          if (input.action === "edit") throw refusal
        } }
      }
      const target = join(workspace, "assets", "denied.png")
      const image_id = stageCursorImage({ path: target, projectDir: workspace,
        mime: "image/png", data: Uint8Array.of(1, 2, 3) })
      try {
        const saving = execute({ image_id }, {
          sessionID: "ses_img_deny", agent: "plan", messageID: "msg_deny", id: "cursor_deny",
        })
        if (outcome === "no-permission-api") await expect(saving).rejects.toThrow("permission assertion")
        else await expect(saving).rejects.toBe(refusal)
        expect(existsSync(join(workspace, "assets"))).toBe(false)
        if (seen.length) expect(seen[0]).toMatchObject({
          agent: "plan", action: "edit", resources: ["assets/denied.png"],
        })
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  test("cursor_image_save falls back to the tool-context ask when permission.assert is absent", async () => {
    const { ctx, transforms, sessionLocations } = fakeContext()
    await setupPlugin(ctx)
    let execute!: (input: { image_id: string }, context: {
      sessionID: string; agent: string; messageID: string; id: string;
      ask?: (request: {
        permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown>
      }) => Promise<void>
    }) => Promise<{ output: { path: string } }>
    transforms.get("tool")!({ add: (tool: { execute: typeof execute }) => { execute = tool.execute } })
    const workspace = mkdtempSync(join(tmpdir(), "oc2-img-ask-ws-"))
    const projectDir = mkdtempSync(join(tmpdir(), "oc2-img-ask-proj-"))
    sessionLocations.set("ses_img_ask", workspace)
    const asked: Array<{ permission: string; patterns: string[] }> = []
    const target = join(projectDir, "assets", "asked.png")
    const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)
    const image_id = stageCursorImage({ path: target, projectDir, mime: "image/png", data: png })
    try {
      const result = await execute({ image_id }, {
        sessionID: "ses_img_ask", agent: "build", messageID: "msg_ask", id: "cursor_ask",
        ask: async request => { asked.push({ permission: request.permission, patterns: request.patterns }) },
      })
      expect(asked.map(entry => entry.permission)).toEqual(["external_directory", "edit"])
      expect(readFileSync(target)).toEqual(Buffer.from(png))
      expect(result.output.path).toContain("asked.png")
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test("cursor_image_save retains a staging failure instead of treating it as permission denial", async () => {
    const { ctx, transforms, sessionLocations } = fakeContext()
    await setupPlugin(ctx)
    let execute!: (input: { image_id: string }, context: {
      sessionID: string; agent: string; messageID: string; id: string;
    }) => Promise<unknown>
    transforms.get("tool")!({ add: (tool: { execute: typeof execute }) => { execute = tool.execute } })
    const workspace = mkdtempSync(join(tmpdir(), "oc2-img-staging-failure-"))
    sessionLocations.set("ses_missing_image", workspace)
    let assertions = 0
    ctx.permission = { assert: async () => { assertions++ } }
    try {
      await expect(execute({ image_id: "unknown-image" }, {
        sessionID: "ses_missing_image", agent: "plan", messageID: "msg_missing", id: "missing_image",
      })).rejects.toThrow("No pending Cursor image")
      expect(assertions).toBe(0)
    } finally { rmSync(workspace, { recursive: true, force: true }) }
  })

  test.each(["id", "callID"] as const)("accepts the %s tool execution identifier", async (field) => {
    const { ctx, hooks } = fakeContext()
    await setupPlugin(ctx)

    const executionID = `cursor_shell_${field}`
    registerCursorShellCall(executionID, {
      background_shell_spawn: true,
      command: "echo hello",
      working_directory: "/tmp",
    })
    const input = { command: "echo hello" }
    await hooks.get("tool.execute.before")!({
      tool: "bash",
      sessionID: "session",
      agent: "agent",
      messageID: "message",
      [field]: executionID,
      input,
    })
    // OpenCode 2.0 injects the wrapper via shell.create.before for bash/zsh,
    // so the advertised command stays the original user payload.
    expect(typeof input.command).toBe("string")

    const result = { output: "hello\n", metadata: {} }
    await hooks.get("tool.execute.after")!({
      tool: "bash",
      sessionID: "session",
      agent: "agent",
      messageID: "message",
      [field]: executionID,
      input,
      status: "completed",
      result,
    })
    expect(result.output).toBe("hello\n")
  })

  test("cleanup disposes every registration", async () => {
    const { ctx, registered, disposed } = fakeContext()
    const cleanup = await setupPlugin(ctx)
    await (cleanup as () => Promise<void>)()

    expect(disposed.sort()).toEqual([...registered].sort())
  })

  test("the provider transform is a no-op until models are published", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "cursor-oc2-plugin-empty-"))
    setHostCacheDirOverride(cacheDir)
    try {
      const { ctx, inventory } = fakeContext()
      await setupPlugin(ctx)
      expect(inventory.providers.size).toBe(0)
    } finally {
      setHostCacheDirOverride(undefined)
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("a transform replay with no models leaves an existing inventory in place", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "cursor-oc2-plugin-keep-"))
    setHostCacheDirOverride(cacheDir)
    try {
      const { ctx, inventory } = fakeContext()
      const kept: ModelInfo2 = {
        id: "keep-me",
        modelID: "keep-me",
        providerID: "cursor",
        name: "Keep",
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        variants: [],
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 1, output: 1 },
      }
      inventory.editor.add({
        info: { id: "cursor", name: "Cursor", package: "aisdk:keep", activation: "enabled" },
        models: [kept],
      })

      const cleanup = await setupPlugin(ctx)
      await ctx.provider.reload()

      expect(inventory.models.get("cursor/keep-me")?.name).toBe("Keep")
      expect(inventory.providers.get("cursor")?.package).toBe("aisdk:keep")
      await cleanup()
    } finally {
      setHostCacheDirOverride(undefined)
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("a failed provider.reload after cache seed does not throw and does not publish", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "cursor-oc2-plugin-reload-fail-"))
    const cacheDir = mkdtempSync(join(tmpdir(), "cursor-oc2-plugin-reload-fail-cache-"))
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = configDir
    setHostCacheDirOverride(cacheDir)
    try {
      await writeCache(cacheDir, {
        models: [baseModel],
        fetchedAt: Date.now(),
        schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
      })
      const { ctx, inventory } = fakeContext()
      let attempts = 0
      ctx.provider.reload = async () => {
        attempts++
        throw new Error("reload failed")
      }

      const cleanup = await setupPlugin(ctx)
      await new Promise((r) => setTimeout(r, 20))

      expect(inventory.providers.size).toBe(0)
      expect(inventory.models.size).toBe(0)
      expect(attempts).toBeGreaterThan(0)
      await cleanup()
    } finally {
      setHostCacheDirOverride(undefined)
      if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
      rmSync(configDir, { recursive: true, force: true })
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("the aisdk sdk hook resolves the token per Run, not when the SDK is built", async () => {
    const { ctx, hooks } = fakeContext()
    let resolves = 0
    ctx.integration.connection = {
      active: async () => ({ type: "credential", id: "c", label: "Cursor" }),
      resolve: async () => {
        resolves++
        return { type: "key", key: "example-already-token" }
      },
    }
    const cleanup = await setupPlugin(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const before = resolves
    const event: any = { model: { providerID: "cursor", id: "m", modelID: "m" }, package: CURSOR_AISDK_PACKAGE, options: {} }
    await hooks.get("aisdk.sdk")!(event)
    expect(typeof event.sdk?.languageModel).toBe("function")
    expect(resolves).toBe(before)
    expect(typeof cleanup).toBe("function")
    if (typeof cleanup === "function") await cleanup()
  })

  test("a preloaded Cursor SDK still resolves current credentials before opening a Run", async () => {
    const { ctx, hooks } = fakeContext()
    const cleanup = await setupPlugin(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    let resolves = 0
    ctx.integration.connection = {
      active: async () => ({ type: "credential", id: "current", label: "Cursor" }),
      resolve: async () => {
        resolves++
        throw new Error("synthetic credential unavailable")
      },
    }
    const fallback = { languageModel: () => ({ doStream: async () => ({ bypassed: true }) }) }
    const event: any = {
      model: { providerID: "cursor", id: "m", modelID: "m" },
      package: CURSOR_AISDK_PACKAGE,
      sdk: fallback,
      options: {
        apiKey: "example-stale-token",
        getAccessToken: async () => { throw new Error("stale resolver used") },
        retry: { maxAttempts: 1 },
      },
    }
    try {
      await hooks.get("aisdk.sdk")!(event)
      expect(event.sdk).not.toBe(fallback)
      expect(resolves).toBe(0)
      const failure: unknown = await event.sdk.languageModel("m").doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Respond briefly" }] }],
      }).catch((error: unknown) => error)
      expect(APICallError.isInstance(failure)).toBe(true)
      if (!APICallError.isInstance(failure)) throw new Error("Expected terminal sign-in failure")
      expect(failure).toMatchObject({
        statusCode: 401,
        isRetryable: false,
        responseHeaders: { "x-should-retry": "false" },
      })
      expect(failure.message).toContain("synthetic credential capacity_limit")
      expect(failure.cause).toBeInstanceOf(CursorAuthError)
      expect(resolves).toBe(1)
    } finally {
      await cleanup()
    }
  })

  test("the sdk hook preserves another provider's preloaded SDK", async () => {
    const { ctx, hooks } = fakeContext()
    const cleanup = await setupPlugin(ctx)
    const sdk = { languageModel: () => ({}) }
    try {
      const event: any = { model: { providerID: "other" }, package: "other-provider", options: {}, sdk }
      await hooks.get("aisdk.sdk")!(event)
      expect(event.sdk).toBe(sdk)
    } finally {
      await cleanup()
    }
  })

  test("the aisdk language hook resolves the wire model id", async () => {
    const { ctx, hooks } = fakeContext()
    await setupPlugin(ctx)

    const asked: string[] = []
    const event: any = {
      model: { providerID: "cursor", id: "sonnet-1m", modelID: "sonnet" },
      sdk: {
        languageModel: (id: string) => {
          asked.push(id)
          return { id }
        },
      },
      options: {},
    }
    await hooks.get("aisdk.language")!(event)
    expect(asked).toEqual(["sonnet"])
    expect(event.language).toEqual({ id: "sonnet" })
  })

  test("the aisdk language hook ignores other providers", async () => {
    const { ctx, hooks } = fakeContext()
    await setupPlugin(ctx)

    const event: any = {
      model: { providerID: "anthropic", id: "x", modelID: "x" },
      sdk: { languageModel: () => ({}) },
      options: {},
    }
    await hooks.get("aisdk.language")!(event)
    expect(event.language).toBeUndefined()
  })

  test("retries credential resolution after a first-run miss", async () => {
    // Regression: on a fresh install setup() runs before /connect, so the first
    // token resolution necessarily fails. Memoizing that failure pinned the
    // plugin to "no credentials" for the whole process and models never loaded,
    // even after a successful login — a restart was required.
    const { ctx } = fakeContext()
    let connected = false
    let activeCalls = 0
    ctx.integration.connection.active = async () => {
      activeCalls++
      return connected ? { type: "credential", id: "c1", label: "Cursor" } : undefined
    }
    ctx.integration.connection.resolve = async () => ({ type: "key", key: "example-already-token" })

    await setupPlugin(ctx)
    await new Promise((r) => setTimeout(r, 10))
    const beforeLogin = activeCalls
    expect(beforeLogin).toBeGreaterThan(0)

    // Simulate the user completing /connect, then any host activity.
    connected = true
    await new Promise((r) => setTimeout(r, 10))

    // The failed lookup must not have been cached: a later attempt re-resolves.
    const connection = await ctx.integration.connection.active("cursor")
    expect(connection).toBeDefined()
    expect(activeCalls).toBeGreaterThan(beforeLogin)
  })

  test("credential updates replace a fresh cache with the selected account's inventory", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "cursor-oc2-account-switch-"))
    const previousApiBase = process.env.CURSOR_API_BASE_URL
    const previousVersion = process.env.CURSOR_CLIENT_VERSION
    setHostCacheDirOverride(cacheDir)
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname.endsWith("/AvailableModels")) {
          return Response.json({
            models: [{
              name: "new-account",
              client_display_name: "New Account Model",
              supports_agent: true,
              variants: [],
            }],
          })
        }
        return Response.json({})
      },
    })
    process.env.CURSOR_API_BASE_URL = server.url.origin
    process.env.CURSOR_CLIENT_VERSION = "cli-test"
    resetClientVersionCache()
    try {
      await writeCache(cacheDir, {
        models: [{ ...baseModel, id: "old-account", displayName: "Old Account Model" }],
        fetchedAt: Date.now(),
        schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
      })
      const { ctx, inventory } = fakeContext([{
        type: "credential.updated",
        data: { integrationID: "cursor" },
      }])
      ctx.integration.connection.active = async () => ({
        type: "credential",
        id: "new-account-credential",
        label: "Cursor",
      })
      ctx.integration.connection.resolve = async () => ({
        type: "key",
        key: "new.account.jwt",
      })

      const cleanup = await setupPlugin(ctx)
      try {
        for (let i = 0; i < 100 && !inventory.models.has("cursor/new-account"); i++) {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        expect(inventory.models.has("cursor/new-account")).toBe(true)
        expect(inventory.models.has("cursor/old-account")).toBe(false)
      } finally {
        await cleanup()
      }
    } finally {
      setHostCacheDirOverride(undefined)
      if (previousApiBase === undefined) delete process.env.CURSOR_API_BASE_URL
      else process.env.CURSOR_API_BASE_URL = previousApiBase
      if (previousVersion === undefined) delete process.env.CURSOR_CLIENT_VERSION
      else process.env.CURSOR_CLIENT_VERSION = previousVersion
      resetClientVersionCache()
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("setup publishes the first discovery before returning when no cache exists", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "cursor-oc2-cold-cache-"))
    const previousApiBase = process.env.CURSOR_API_BASE_URL
    const previousVersion = process.env.CURSOR_CLIENT_VERSION
    setHostCacheDirOverride(cacheDir)
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname.endsWith("/AvailableModels")) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          return Response.json({
            models: [{ name: "cold-model", client_display_name: "Cold Model", supports_agent: true, variants: [] }],
          })
        }
        return Response.json({})
      },
    })
    process.env.CURSOR_API_BASE_URL = server.url.origin
    process.env.CURSOR_CLIENT_VERSION = "cli-test"
    resetClientVersionCache()
    try {
      const { ctx, inventory } = fakeContext()
      ctx.integration.connection.active = async () => ({ type: "credential", id: "c", label: "Cursor" })
      ctx.integration.connection.resolve = async () => ({ type: "key", key: "cold.start.jwt" })

      const cleanup = await setupPlugin(ctx)
      try {
        expect(inventory.models.has("cursor/cold-model")).toBe(true)
      } finally {
        await cleanup()
      }
    } finally {
      setHostCacheDirOverride(undefined)
      if (previousApiBase === undefined) delete process.env.CURSOR_API_BASE_URL
      else process.env.CURSOR_API_BASE_URL = previousApiBase
      if (previousVersion === undefined) delete process.env.CURSOR_CLIENT_VERSION
      else process.env.CURSOR_CLIENT_VERSION = previousVersion
      resetClientVersionCache()
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("keeps a parent lease active while a child form or permission prompt is open", async () => {
    sessionActivity.clear()
    const start = Date.now()
    const { ctx } = fakeContext([
      { type: "session.updated", data: { info: { id: "child", parentID: "parent" } } },
      { type: "form.created", data: { form: { id: "frm_1", sessionID: "child", title: "Pick", fields: [] } } },
      { type: "permission.asked", data: { id: "per_1", sessionID: "child", action: "bash", resources: [] } },
      { type: "permission.replied", data: { sessionID: "child", requestID: "per_1", reply: "once" } },
    ])
    const cleanup = await setupPlugin(ctx)
    try {
      for (let i = 0; i < 100 && sessionActivity.lastActivityAt("parent") === undefined; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
      setSystemTime(new Date(start + 3_600_000))
      // The form is still open; the permission was answered.
      expect(sessionActivity.lastActivityAt("parent")).toBe(start + 3_600_000)
    } finally {
      setSystemTime()
      await cleanup()
      sessionActivity.clear()
    }
  })

  test("reports a stopped execution to the model, and a shutdown again from cleanup", async () => {
    const heard: Array<[string | undefined, string, number | "now"]> = []
    const before = Date.now()
    const stop = onHostInterrupt((sessionID, reason, at) => {
      heard.push([sessionID, reason, sessionID ? at : at >= before ? "now" : at])
    })
    const { ctx } = fakeContext([
      { type: "session.execution.succeeded", data: { sessionID: "ses_done" } },
      { type: "session.execution.failed", data: { sessionID: "ses_failed", error: { type: "unknown", message: "x" } } },
      { type: "session.execution.interrupted", created: 1_790_000_000_000, data: { sessionID: "ses_restart", reason: "shutdown" } },
      { type: "session.execution.interrupted", created: 1_790_000_000_001, data: { sessionID: "ses_stop", reason: "user" } },
    ])
    const cleanup = await setupPlugin(ctx)
    try {
      for (let i = 0; i < 100 && heard.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(heard).toEqual([
        ["ses_restart", "shutdown", 1_790_000_000_000],
        ["ses_stop", "user", 1_790_000_000_001],
      ])
      await cleanup()
      expect(heard[heard.length - 1]).toEqual([undefined, "shutdown", "now"])
    } finally {
      stop()
      await cleanup()
      sessionActivity.clear()
    }
  })

  test("the session hook records the compaction agent", async () => {
    clearCompactionSessions()
    const { ctx, hooks, sessionLocations } = fakeContext()
    sessionLocations.set("s-compact", "/proj")
    sessionLocations.set("s-normal", "/proj")
    await setupPlugin(ctx)

    const hook = hooks.get("session.context")!
    await hook({ sessionID: "s-compact", agent: "compaction", model: { providerID: "cursor" } })
    await hook({ sessionID: "s-normal", agent: "build", model: { providerID: "cursor" } })

    expect(isCompactionSession("s-compact")).toBe(true)
    expect(isCompactionSession("s-normal")).toBe(false)
  })

  test("the session context carries the active host agent into provider options", async () => {
    const { ctx, hooks, sessionLocations } = fakeContext()
    sessionLocations.set("s-plan-agent", "/proj")
    await setupPlugin(ctx)

    const event: any = {
      sessionID: "s-plan-agent",
      agent: "plan",
      model: { providerID: "cursor" },
      options: {},
    }
    await hooks.get("session.context")!(event)
    expect(event.options.opencodeHostAgent).toBe("plan")

    // The provider's `followHostPlanAgent` follows the agent on both
    // generations; the hook only reports it and never changes the mode.
    setActiveCursorMode("s-plan-agent", "debug")
    await hooks.get("session.context")!(event)
    expect(getActiveCursorMode("s-plan-agent")).toBe("debug")
    event.agent = "build"
    setActiveCursorMode("s-plan-agent", "plan")
    await hooks.get("session.context")!(event)
    expect(event.options.opencodeHostAgent).toBe("build")
    expect(getActiveCursorMode("s-plan-agent")).toBe("plan")
  })

  test("the session context sets the edit-deny option from session permissions", async () => {
    const { ctx, hooks, sessionLocations, sessionPermissions } = fakeContext()
    sessionLocations.set("s-deny", "/proj")
    sessionLocations.set("s-allow", "/proj")
    sessionLocations.set("s-plain", "/proj")
    sessionPermissions.set("s-deny", [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "/plans/*", effect: "allow" },
    ])
    sessionPermissions.set("s-allow", [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "allow" },
    ])
    await setupPlugin(ctx)

    const denied: any = { sessionID: "s-deny", agent: "plan", model: { providerID: "cursor" }, options: {} }
    await hooks.get("session.context")!(denied)
    expect(denied.options.opencodeSessionEditsDenied).toBe(true)

    sessionPermissions.set("s-deny", [{ action: "edit", resource: "*", effect: "allow" }])
    await hooks.get("session.context")!(denied)
    expect(denied.options.opencodeSessionEditsDenied).toBe(false)

    const allowed: any = { sessionID: "s-allow", agent: "build", model: { providerID: "cursor" }, options: {} }
    await hooks.get("session.context")!(allowed)
    expect(allowed.options.opencodeSessionEditsDenied).toBe(false)

    const plain: any = { sessionID: "s-plain", agent: "build", model: { providerID: "cursor" }, options: {} }
    await hooks.get("session.context")!(plain)
    expect(plain.options.opencodeSessionEditsDenied).toBe(false)
    expect(plain.options.opencodeHostAgent).toBe("build")
  })

  test("session context retries permissions and marks unavailable evidence without aborting requests", async () => {
    const { ctx, hooks } = fakeContext()
    let reads = 0
    ctx.session.get = async () => {
      if (++reads === 1) throw new Error("not ready")
      return { id: "s-retry", location: { directory: "/proj" }, permissions: [{ action: "edit", resource: "*", effect: "deny" }] }
    }
    await setupPlugin(ctx)
    const event = { sessionID: "s-retry", agent: "plan", options: {} as Record<string, unknown> }
    await hooks.get("session.context")!(event)
    expect(reads).toBe(2)
    expect(event.options.opencodeSessionEditsDenied).toBe(true)
    ctx.session.get = async () => { throw new Error("session unavailable") }
    await hooks.get("session.context")!(event)
    expect(event.options.opencodeSessionPermissionsUnavailable).toBe(true)
    expect(event.options.opencodeSessionEditsDenied).toBeUndefined()
    ctx.session.get = async () => ({ id: "s-retry", location: { directory: "/proj" }, permissions: [] })
    await hooks.get("session.context")!(event)
    expect(event.options.opencodeSessionPermissionsUnavailable).toBeUndefined()
    expect(event.options.opencodeSessionEditsDenied).toBe(false)
  })

  test("a compaction context survives an unreadable session and carries no edit-deny option", async () => {
    const { ctx, hooks } = fakeContext()
    ctx.session.get = async () => { throw new Error("session unavailable") }
    await setupPlugin(ctx)
    const event = {
      sessionID: "s-compact",
      agent: "compaction",
      options: { opencodeSessionEditsDenied: true } as Record<string, unknown>,
    }
    await hooks.get("session.context")!(event)
    expect(event.options.opencodeCompaction).toBe(true)
    expect(event.options.opencodeSessionEditsDenied).toBeUndefined()
  })

  test("the session hook records the session's real directory, not the daemon cwd", async () => {
    clearSessionDirectories()
    const { ctx, hooks, sessionLocations } = fakeContext()
    sessionLocations.set("s1", "/home/user/projects/my-app")
    await setupPlugin(ctx)

    const hook = hooks.get("session.context")!
    await hook({ sessionID: "s1", agent: "build", model: { providerID: "cursor" } })

    expect(getSessionDirectory("s1")).toBe("/home/user/projects/my-app")
  })

  const modelRequest = (sessionID: string, providerID = "cursor", headers: Record<string, string> = {}) => ({
    sessionID,
    agent: "build",
    model: { providerID, id: "auto" },
    kind: "primary" as const,
    headers,
  })

  test("model.request carries the session directory as x-opencode-directory", async () => {
    clearSessionDirectories()
    const { ctx, hooks, sessionLocations } = fakeContext()
    sessionLocations.set("s-dir", "/home/user/a b")
    await setupPlugin(ctx)

    const event = modelRequest("s-dir", "cursor", { "x-session-id": "s-dir" })
    await hooks.get("session.model.request")!(event)

    expect(event.headers["x-session-id"]).toBe("s-dir")
    expect(event.headers["x-opencode-directory"]).toBe("%2Fhome%2Fuser%2Fa%20b")
    expect(opencodeDirectoryHeader(event.headers)).toBe("/home/user/a b")
    expect(getSessionDirectory("s-dir")).toBe("/home/user/a b")
  })

  test("model.request header overrides a stale session mark in the language model", async () => {
    clearSessionDirectories()
    const { ctx, hooks, sessionLocations } = fakeContext()
    sessionLocations.set("s-moved", "/home/user/new-project")
    await setupPlugin(ctx)

    const event = modelRequest("s-moved")
    await hooks.get("session.model.request")!(event)
    // Another module copy still holds the pre-move directory.
    markSessionDirectory("s-moved", "/home/user/old-project")

    expect(
      resolveSessionWorkspaceRoot({ sessionKey: "s-moved", headers: event.headers, workspaceRoot: "/workspace" }),
    ).toBe(resolve("/home/user/new-project"))
  })

  test("model.request keeps the last known session directory when the lookup fails", async () => {
    clearSessionDirectories()
    const { ctx, hooks } = fakeContext()
    await setupPlugin(ctx)
    markSessionDirectory("s-known", "/home/user/known")

    const event = modelRequest("s-known")
    await hooks.get("session.model.request")!(event)

    expect(opencodeDirectoryHeader(event.headers)).toBe("/home/user/known")
    expect(getSessionDirectory("s-known")).toBe("/home/user/known")
  })

  test("model.request falls back to the plugin location when the session is unknown", async () => {
    clearSessionDirectories()
    const { ctx, hooks } = fakeContext()
    await setupPlugin(ctx)

    const event = modelRequest("s-missing")
    await hooks.get("session.model.request")!(event)

    expect(opencodeDirectoryHeader(event.headers)).toBe("/workspace")
    // The fallback is not a session fact; do not record it as one.
    expect(getSessionDirectory("s-missing")).toBeUndefined()
  })

  test("model.request records the host's skill files for RequestContext agent_skills", async () => {
    clearSessionDirectories()
    resetHostSkillFilesForTests()
    const root = mkdtempSync(join(tmpdir(), "cursor-oc2-skills-"))
    const file = join(root, "review", "SKILL.md")
    mkdirSync(join(root, "review"))
    writeFileSync(file, "---\nname: review\ndescription: Review code\n---\nReview.\n")
    try {
      const { ctx, hooks, sessionLocations } = fakeContext()
      sessionLocations.set("s-skills", root)
      ctx.skill = {
        list: async () => ({
          location: { directory: root },
          data: [
            { id: "review", name: "review", description: "Review code", path: file, content: "Review." },
            { id: "opencode", name: "OpenCode", description: "Builtin", path: "/builtin/opencode.md", content: "x" },
          ],
        }),
      }
      await setupPlugin(ctx)

      // A compaction can be the first request after a restart; its Run carries the catalog too.
      await hooks.get("session.model.request")!({ ...modelRequest("s-skills"), kind: "compaction" })

      expect([...(hostSkillFiles(root) ?? [])]).toEqual([["review", file]])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("model.request survives a failing skill list", async () => {
    clearSessionDirectories()
    resetHostSkillFilesForTests()
    const { ctx, hooks, sessionLocations } = fakeContext()
    sessionLocations.set("s-skills-fail", "/proj-skills")
    ctx.skill = { list: async () => { throw new Error("boom") } }
    await setupPlugin(ctx)

    const event = modelRequest("s-skills-fail")
    await hooks.get("session.model.request")!(event)

    expect(opencodeDirectoryHeader(event.headers)).toBe("/proj-skills")
    expect(hostSkillFiles("/proj-skills")).toBeUndefined()
  })

  test("model.request does not attribute another location's skills to the session", async () => {
    clearSessionDirectories()
    resetHostSkillFilesForTests()
    const root = mkdtempSync(join(tmpdir(), "cursor-oc2-skill-scope-"))
    const file = join(root, "SKILL.md")
    writeFileSync(file, "Skill")
    try {
      const { ctx, hooks, sessionLocations } = fakeContext()
      sessionLocations.set("s-moved", join(root, "moved"))
      ctx.skill = { list: async () => ({ location: { directory: root }, data: [{ id: "same-id", path: file }] }) }
      const cleanup = await setupPlugin(ctx)
      try {
        await hooks.get("session.model.request")!(modelRequest("s-moved"))
        expect(hostSkillFiles(join(root, "moved"))).toBeUndefined()
        expect(hostSkillFiles(root)?.get("same-id")).toBe(file)
      } finally { await cleanup() }
    } finally {
      resetHostSkillFilesForTests()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("model.request leaves other providers' headers alone", async () => {
    clearSessionDirectories()
    const { ctx, hooks, sessionLocations } = fakeContext()
    sessionLocations.set("s-other", "/proj")
    await setupPlugin(ctx)

    const event = modelRequest("s-other", "openai")
    await hooks.get("session.model.request")!(event)

    expect(event.headers).toEqual({})
    expect(getSessionDirectory("s-other")).toBeUndefined()
  })

  test("a failed permission lookup leaves ordinary context usable and the directory unset", async () => {
    clearSessionDirectories()
    const { ctx, hooks } = fakeContext()
    await setupPlugin(ctx)

    const hook = hooks.get("session.context")!
    const event = { sessionID: "s-unknown", agent: "build", model: { providerID: "cursor" }, options: {} as Record<string, unknown> }
    await hook(event)
    expect(event.options.opencodeSessionPermissionsUnavailable).toBe(true)

    expect(getSessionDirectory("s-unknown")).toBeUndefined()
  })

  test("maps Cursor modes onto the native OpenCode 2 plan and build agents", async () => {
    const { ctx } = fakeContext()
    const switched: string[] = []
    const continued: string[] = []
    ctx.session.switchAgent = async ({ sessionID, agent }: { sessionID: string; agent: string }) => {
      switched.push(`${sessionID}:${agent}`)
    }
    ctx.session.synthetic = async ({ sessionID, text }: { sessionID: string; text: string }) => {
      continued.push(`${sessionID}:${text.slice(0, 24)}`)
      return {}
    }
    const cleanup = await setupPlugin(ctx)

    expect(queueHostAgentModeSwitch({
      sessionID: "s-mode",
      targetModeID: "spec",
      cursorSessionID: "run-plan",
    })).toBe(true)
    expect(isHostPlanEntryPending("s-mode")).toBe(true)
    expect(await flushHostAgentModeSwitch("s-mode", {
      cursorSessionID: "run-plan",
      terminal: true,
    })).toBe(true)
    expect(isHostPlanEntryPending("s-mode")).toBe(false)

    expect(queueHostAgentModeSwitch({
      sessionID: "s-mode",
      targetModeID: "agent",
      cursorSessionID: "run-build",
    })).toBe(true)
    expect(await flushHostAgentModeSwitch("s-mode", {
      cursorSessionID: "run-build",
      terminal: true,
    })).toBe(true)
    expect(switched).toEqual(["s-mode:plan", "s-mode:build"])
    expect(continued).toHaveLength(2)

    await cleanup()
    expect(queueHostAgentModeSwitch({ sessionID: "s-mode", targetModeID: "plan" })).toBe(false)
  })

  test("does not cancel and resume a Run for an already selected native agent", async () => {
    const { ctx } = fakeContext()
    const calls: string[] = []
    ctx.session.switchAgent = async () => { calls.push("switch") }
    ctx.session.synthetic = async () => { calls.push("continue"); return {} }
    await setupPlugin(ctx)
    const accepted: boolean[] = []
    for (const [hostAgent, targetModeID] of [["plan", "plan"], ["plan", "spec"], ["build", "agent"], ["build", "debug"]]) {
      accepted.push(queueHostAgentModeSwitch({ sessionID: "s-same-agent", hostAgent, targetModeID, cursorSessionID: "run" }))
      await flushHostAgentModeSwitch("s-same-agent", { cursorSessionID: "run", terminal: true })
    }
    expect(accepted).toEqual([false, false, false, false])
    expect(calls).toEqual([])
  })

  // A host event stream the test feeds while the plugin runs.
  function liveEvents() {
    const queue: unknown[] = []
    let wake: (() => void) | undefined
    return {
      subscribe: ({ signal }: { signal?: AbortSignal } = {}) => (async function* () {
        const aborted = new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
        while (!signal?.aborted) {
          while (queue.length) yield queue.shift()
          await Promise.race([new Promise<void>((resolve) => { wake = resolve }), aborted])
        }
      })(),
      push(event: unknown) {
        queue.push(event)
        wake?.()
      },
    }
  }

  test.each(["plan", "agent"])("waits for the matching switch note despite unrelated synthetic items (mode=%s)", async mode => {
    const { ctx } = fakeContext()
    const events = liveEvents()
    ctx.event.subscribe = events.subscribe
    const order: string[] = []
    ctx.session.switchAgent = async ({ sessionID, agent }: { sessionID: string; agent: string }) => {
      order.push(`switch:${agent}`)
      order.push("unrelated-note")
      const nativeNote = (target: string) => target === "plan"
        ? "<system-reminder>\nYou are in Plan mode. Discuss the plan with the user directly in the conversation.\n</system-reminder>"
        : "<system-reminder>\nYou are NO LONGER in Plan mode. The previous Plan restrictions no longer apply.\n</system-reminder>"
      const pushNote = (text: string) => events.push({
        type: "session.inbox.enqueued",
        data: { sessionID, inboxID: "msg_note", item: { type: "synthetic", delivery: "steer", payload: { text } } },
      })
      pushNote("A background task completed.")
      pushNote(nativeNote(agent === "plan" ? "build" : "plan"))
      // OpenCode's plan agent enqueues its note from an event subscriber, after the switch returns.
      setTimeout(() => {
        order.push("host-note")
        pushNote(nativeNote(agent))
      }, 30)
    }
    ctx.session.synthetic = async () => {
      order.push("continue")
      return {}
    }
    await setupPlugin(ctx)

    expect(queueHostAgentModeSwitch({ sessionID: "s-note", targetModeID: mode, cursorSessionID: "run" })).toBe(true)
    expect(await flushHostAgentModeSwitch("s-note", { cursorSessionID: "run", terminal: true })).toBe(true)
    expect(order).toEqual([`switch:${mode === "plan" ? "plan" : "build"}`, "unrelated-note", "host-note", "continue"])
  })

  test("continues a native switch when the host enqueues no note", async () => {
    const { ctx } = fakeContext()
    ctx.event.subscribe = liveEvents().subscribe
    const continued: number[] = []
    ctx.session.switchAgent = async () => {}
    ctx.session.synthetic = async () => {
      continued.push(Date.now())
      return {}
    }
    await setupPlugin(ctx)

    const started = Date.now()
    expect(queueHostAgentModeSwitch({ sessionID: "s-quiet", targetModeID: "agent", cursorSessionID: "run" })).toBe(true)
    expect(await flushHostAgentModeSwitch("s-quiet", { cursorSessionID: "run", terminal: true })).toBe(true)
    expect(continued).toHaveLength(1)
    expect(continued[0]! - started).toBeLessThan(3_000)
  })

  test("cancels its reminder wait and does not continue after a failed native switch", async () => {
    const { ctx } = fakeContext()
    ctx.event.subscribe = liveEvents().subscribe
    ctx.session.switchAgent = async () => { throw new Error("switch refused") }
    let continued = false
    ctx.session.synthetic = async () => { continued = true; return {} }
    await setupPlugin(ctx)
    expect(queueHostAgentModeSwitch({ sessionID: "s-failed-switch", targetModeID: "plan", cursorSessionID: "run" })).toBe(true)
    expect(await flushHostAgentModeSwitch("s-failed-switch", { cursorSessionID: "run", terminal: true })).toBe(false)
    expect(continued).toBe(false)
  })

  test("disposing an older setup keeps the switch and Plan directory of a newer one", async () => {
    // OpenCode 2.0 sets the plugin up per location instance and again on a
    // plugin reload, then disposes the older setup while the newer one runs.
    const switched: string[] = []
    const setupWith = async (label: string) => {
      const { ctx } = fakeContext()
      ctx.session.switchAgent = async ({ sessionID, agent }: { sessionID: string; agent: string }) => {
        switched.push(`${label}:${sessionID}:${agent}`)
      }
      ctx.session.synthetic = async () => ({})
      return setupPlugin(ctx)
    }
    const older = await setupWith("older")
    const newer = await setupWith("newer")

    await older()
    expect(hostPlansDir()).toBe(opencode2PlanDir())
    expect(queueHostAgentModeSwitch({
      sessionID: "s-reload",
      targetModeID: "agent",
      cursorSessionID: "run",
    })).toBe(true)
    expect(await flushHostAgentModeSwitch("s-reload", { cursorSessionID: "run", terminal: true })).toBe(true)
    expect(switched).toEqual(["newer:s-reload:build"])

    await newer()
    expect(hostPlansDir()).not.toBe(opencode2PlanDir())
    expect(queueHostAgentModeSwitch({ sessionID: "s-reload", targetModeID: "agent" })).toBe(false)
  })

  test("shell create.before preserves the approved command and selected shell grammar", async () => {
    const { ctx, hooks } = fakeContext()
    await setupPlugin(ctx)
    const executionID = "cursor_shell_env"
    registerCursorShellCall(executionID, {
      background_shell_spawn: true,
      command: "echo hello",
      working_directory: "/tmp",
    })
    const input = { command: "echo hello" }
    await hooks.get("tool.execute.before")!({
      tool: "shell",
      sessionID: "session",
      agent: "agent",
      messageID: "message",
      id: executionID,
      input,
    })
    const event = { command: "echo hello", cwd: "/tmp", timeout: 0, shell: "/bin/bash", env: {} as Record<string, string | undefined> }
    await hooks.get("shell.create.before")!(event)
    expect(event.command).toBe("echo hello")
    expect(event.shell.endsWith("/bash")).toBe(true)
    expect(event.shell).not.toBe("/bin/bash")
    expect(readFileSync(event.shell, "utf8")).toContain("CURSOR_SHELL_EXECUTABLE='/bin/bash'")
    expect(event.env).toEqual({})
  })

  test("a shell whose command a later hook rewrote does not hold back identical shells", async () => {
    const { ctx, hooks } = fakeContext()
    await setupPlugin(ctx)
    const event = (id: string, command: string) => ({
      tool: "shell", sessionID: "session", agent: "agent", messageID: "message", id, input: { command } as unknown,
    })
    registerCursorShellCall("cursor_shell_rewritten", {
      background_shell_spawn: true, command: "echo original", working_directory: "/tmp",
    })
    const rewrittenCall = event("cursor_shell_rewritten", "echo original")
    await hooks.get("tool.execute.before")!(rewrittenCall)
    // A plugin hooked after this one replaces the input, as OpenCode's own
    // input repair does; OpenCode creates the shell from the replacement.
    rewrittenCall.input = { command: "echo rewritten" }
    const rewritten = { command: "echo rewritten", cwd: "/tmp", timeout: 0, shell: "/bin/bash", env: {} as Record<string, string | undefined> }
    await hooks.get("shell.create.before")!(rewritten)
    // Not the call's wrapper: only the tool-nice adapter around the host's shell.
    const adapter = readFileSync(rewritten.shell, "utf8")
    expect(adapter).toContain(`'/bin/bash' "$@"`)
    expect(adapter).not.toContain("CURSOR_SHELL_EXECUTABLE")

    const identical = await Promise.race([
      Promise.resolve(hooks.get("tool.execute.before")!(event("cursor_shell_identical", "echo original"))).then(() => "armed"),
      Bun.sleep(1_000).then(() => "blocked"),
    ])
    expect(identical).toBe("armed")
  })

  test("shell execute.after sanitizes structured output and content blocks", async () => {
    const { ctx, hooks } = fakeContext()
    await setupPlugin(ctx)
    const executionID = "cursor_shell_blocks"
    registerCursorShellCall(executionID, {
      background_shell_spawn: true,
      command: "sleep 60",
      working_directory: "/tmp",
    })
    const raw = "started\n__CURSOR_BACKGROUND_SHELL__43210:/tmp/cursor-bg.log\n"
    const result: any = {
      output: { output: raw, status: "completed", truncated: false },
      content: [{ type: "text", text: raw }, { type: "file", uri: "file:///tmp/log", mime: "text/plain" }],
      metadata: {},
    }
    await hooks.get("tool.execute.after")!({
      tool: "shell",
      sessionID: "session",
      agent: "agent",
      messageID: "message",
      id: executionID,
      input: { command: "sleep 60" },
      status: "completed",
      result,
    })
    expect(result.output.output).not.toContain("__CURSOR_BACKGROUND_SHELL__")
    expect(result.content[0].text).not.toContain("__CURSOR_BACKGROUND_SHELL__")
    expect(result.content[1]).toEqual({ type: "file", uri: "file:///tmp/log", mime: "text/plain" })
  })

  test("shell execute.after keeps timeout-shaped successful stdout in every projection", async () => {
    const { ctx, hooks } = fakeContext()
    await setupPlugin(ctx)
    const id = "cursor_shell_timeout_text"
    const raw = "feature/cp16\r\n\r\n<shell_metadata>\nshell tool terminated command after exceeding timeout 60000 ms.\n</shell_metadata>"
    const result = {
      output: { output: raw }, content: [{ type: "text", text: raw }],
      metadata: { exit: 0, output: raw },
    }
    await hooks.get("tool.execute.after")!({ tool: "shell", id, status: "completed", result })
    expect(result.output.output).toBe(raw)
    expect(result.content[0]?.text).toBe(raw)
    expect(result.metadata.output).toBe(raw)
    expect(consumeCursorShellResult(id, result.content[0]!.text)).toEqual({ output: raw, outcome: { kind: "exit", code: 0 } })
  })

  test("shell execute.after keeps a wrapped command's real exit beside the host's own notice", async () => {
    const { ctx, hooks } = fakeContext()
    await setupPlugin(ctx)
    const id = "cursor_shell_wrapped_exit"
    registerCursorShellCall(id, { shell_stream: true, command: "make", working_directory: "/tmp", timeout_ms: 30_000, timeout_behavior: CURSOR_TIMEOUT_BACKGROUND })
    const raw = "make: *** No rule\n\n__CURSOR_SHELL_EXIT__2\n"
    const result = {
      output: { output: raw, exit: 2, truncated: false, status: "completed" },
      content: [{ type: "text", text: raw }, { type: "text", text: "Exited with code 2" }],
      metadata: { exit: 2, truncated: false, status: "completed" },
    }
    await hooks.get("tool.execute.after")!({ tool: "shell", id, status: "completed", input: { command: "make" }, result })
    expect(result.output).toMatchObject({ output: "make: *** No rule\n", exit: 2 })
    expect(result.content.map(part => part.text)).toEqual(["make: *** No rule\n", "Exited with code 2"])
    expect(result.metadata.exit).toBe(2)
    expect(consumeCursorShellResult(id, "make: *** No rule\n")).toEqual({ output: "make: *** No rule\n", outcome: { kind: "exit", code: 2 } })
  })

  test("shell execute.after preserves an error status that the native SDK turns into text", async () => {
    const { ctx, hooks } = fakeContext()
    await setupPlugin(ctx)
    const executionID = "cursor_shell_denied"
    registerCursorShellCall(executionID, { background_shell_spawn: true, command: "echo denied", working_directory: "/tmp" })
    await hooks.get("tool.execute.after")!({
      tool: "shell", id: executionID, status: "error", error: new Error("Permission denied: shell"),
    })
    expect(consumeCursorShellResult(executionID, '{"error":{"type":"permission.rejected","message":"Permission denied: shell"},"content":[]}').error).toBe("Permission denied: shell")
  })

  test.each(["reject", "failed", "deleted", "disconnected"])("releases unstarted reservations on %s without execute.after or a next turn", async kind => {
    const root = mkdtempSync(join(tmpdir(), "cursor-rejected-tool-"))
    const callID = "cursor_reject_cleanup_1"
    const terminal = createManagedTerminal({ command: "true", workingDirectory: root, timeoutMs: 0, timeoutBehavior: 0, backgroundSpawn: true }, root)
    registerCursorShellCall(callID, { background_shell_spawn: true, command: "true", working_directory: root, managed_command: terminal.command, managed_job_directory: terminal.directory })
    const asked = { type: "permission.asked", data: { id: "per_cleanup", sessionID: "s-cleanup", source: { type: "tool", id: callID, messageID: "m" } } }
    const end = kind === "reject" ? { type: "permission.replied", data: { requestID: "per_cleanup", sessionID: "s-cleanup", reply: "reject" } }
      : kind === "failed" ? { type: "session.tool.failed", data: { id: callID, sessionID: "s-cleanup", error: { type: "aborted", message: "Interrupted" } } }
      : { type: "session.deleted", data: { sessionID: "s-cleanup" } }
    try {
      const { ctx } = fakeContext(kind === "disconnected" ? [asked] : [asked, end])
      await setupPlugin(ctx)
      for (let i = 0; i < 50 && existsSync(terminal.file); i++) await Bun.sleep(1)
      expect(existsSync(terminal.file)).toBe(false)
      expect(existsSync(terminal.directory)).toBe(false)
      expect(existsSync(join(root, "terminals", ".jobs", `${terminal.shellId}.json`))).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("a rejected permission also releases the session's other pending shell reservations", async () => {
    const root = mkdtempSync(join(tmpdir(), "cursor-rejected-siblings-"))
    const first = createManagedTerminal({ command: "true", workingDirectory: root, timeoutMs: 0, timeoutBehavior: 0, backgroundSpawn: true }, root)
    const second = createManagedTerminal({ command: "true", workingDirectory: root, timeoutMs: 0, timeoutBehavior: 0, backgroundSpawn: true }, root)
    registerCursorShellCall("cursor_reject_a", { background_shell_spawn: true, command: "true", working_directory: root, managed_command: first.command, managed_job_directory: first.directory })
    registerCursorShellCall("cursor_reject_b", { background_shell_spawn: true, command: "true", working_directory: root, managed_command: second.command, managed_job_directory: second.directory })
    const asked = (id: string, callID: string) => ({ type: "permission.asked", data: { id, sessionID: "s-siblings", source: { type: "tool", id: callID, messageID: "m" } } })
    try {
      const { ctx } = fakeContext([
        asked("per_a", "cursor_reject_a"),
        asked("per_b", "cursor_reject_b"),
        { type: "permission.replied", data: { requestID: "per_a", sessionID: "s-siblings", reply: "reject" } },
      ])
      await setupPlugin(ctx)
      for (let i = 0; i < 50 && (existsSync(first.file) || existsSync(second.file)); i++) await Bun.sleep(1)
      expect(existsSync(first.file)).toBe(false)
      expect(existsSync(second.file)).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  describe("pending shell asks across Locations", () => {
    const setupAt = async (bus: ReturnType<typeof fakeEventBus>, directory: string, implementation = plugin) => {
      const fake = fakeContext()
      fake.ctx.location = { directory }
      fake.ctx.event.subscribe = bus.subscribe
      return { ...fake, cleanup: await setupPlugin(fake.ctx, implementation) }
    }
    const askShell = async (
      bus: ReturnType<typeof fakeEventBus>,
      hooks: Map<string, (input: any) => any>,
      callID: string,
      cwd: string,
    ) => {
      const command = `echo ran-${callID}`
      registerCursorShellCall(callID, {
        shell_stream: true, command, working_directory: cwd, timeout_ms: 5_000, timeout_behavior: CURSOR_TIMEOUT_BACKGROUND,
      })
      await hooks.get("tool.execute.before")!({ tool: "shell", sessionID: `ses_${callID}`, agent: "build", messageID: "m", id: callID, input: { command } })
      const create = { command, cwd, timeout: 0, shell: "/bin/sh", env: {} as Record<string, string | undefined> }
      await hooks.get("shell.create.before")!(create)
      expect(create.shell).not.toBe("/bin/sh")
      await bus.publish({ type: "permission.asked", data: { id: `per_${callID}`, sessionID: `ses_${callID}`, source: { type: "tool", id: callID, messageID: "m" } } })
      return { command, shell: create.shell, sessionID: `ses_${callID}`, requestID: `per_${callID}` }
    }

    test("disposing another Location's setup keeps a pending ask's shell, which runs once approved", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "cursor-pending-ask-"))
      try {
        const bus = fakeEventBus()
        const a = await setupAt(bus, "/project-a")
        const b = await setupAt(bus, "/project-b")
        const ask = await askShell(bus, a.hooks, "cursor_pending_a", cwd)

        await b.cleanup()
        await bus.publish({ type: "permission.replied", data: { requestID: ask.requestID, sessionID: ask.sessionID, reply: "once" } })

        expect(existsSync(ask.shell)).toBe(true)
        const ran = Bun.spawnSync([ask.shell, "-c", ask.command], { cwd })
        expect(ran.exitCode).toBe(0)
        expect(ran.stdout.toString()).toContain("ran-cursor_pending_a")
        await a.hooks.get("tool.execute.after")!({ tool: "shell", id: "cursor_pending_a", status: "completed", input: { command: ask.command }, result: { output: ran.stdout.toString(), metadata: {} } })
        expect(existsSync(ask.shell)).toBe(false)
      } finally { rmSync(cwd, { recursive: true, force: true }) }
    })

    test("a setup reloaded while another Location stays open takes over pending asks, and the last setup to go releases them", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "cursor-pending-reload-"))
      try {
        const bus = fakeEventBus()
        const first = await setupAt(bus, "/project")
        const other = await setupAt(bus, "/project-other")
        const rejected = await askShell(bus, first.hooks, "cursor_reload_rejected", cwd)
        // OpenCode closes the old activation before it loads the replacement.
        await first.cleanup()
        const reloaded = await setupAt(bus, "/project")
        expect(existsSync(rejected.shell)).toBe(true)

        await bus.publish({ type: "permission.replied", data: { requestID: rejected.requestID, sessionID: rejected.sessionID, reply: "reject" } })
        expect(existsSync(rejected.shell)).toBe(false)
        const event: any = { sessionID: rejected.sessionID, agent: "build", model: { providerID: "cursor" }, options: {}, messages: [{ role: "tool", content: [{ type: "tool-result", id: "cursor_reload_rejected", name: "shell", result: { type: "error", value: { error: { type: "aborted", message: "Interrupted" }, content: [] } } }] }] }
        reloaded.sessionLocations.set(rejected.sessionID, "/project")
        await reloaded.hooks.get("session.context")!(event)
        expect(toolResultFailure(event.messages[0].content[0].providerMetadata, "cursor_reload_rejected")?.refusal).toBe("rejected")

        const abandoned = await askShell(bus, reloaded.hooks, "cursor_reload_abandoned", cwd)
        await other.cleanup()
        expect(existsSync(abandoned.shell)).toBe(true)
        await reloaded.cleanup()
        expect(existsSync(abandoned.shell)).toBe(false)
      } finally { rmSync(cwd, { recursive: true, force: true }) }
    })

    test("a replacement setup preserves a rejection received during its reload gap", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "cursor-refusal-reload-"))
      let replacementCleanup: (() => Promise<void>) | undefined
      try {
        const bus = fakeEventBus()
        const first = await setupAt(bus, "/project")
        await setupAt(bus, "/project-other")
        const ask = await askShell(bus, first.hooks, "cursor_reload_gap", cwd)
        await first.cleanup()
        await bus.publish({ type: "permission.replied", data: { requestID: ask.requestID, sessionID: ask.sessionID, reply: "reject" } })
        const graph = mkdtempSync(join(cwd, "cursor-module-graph-"))
        cpSync(resolve(import.meta.dir, "../src"), join(graph, "src"), { recursive: true })
        symlinkSync(resolve(import.meta.dir, "../node_modules"), join(graph, "node_modules"), "dir")
        const copy: typeof import("../src/plugin-opencode2.js") = await import(pathToFileURL(join(graph, "src/plugin-opencode2.ts")).href)
        expect(copy.default.setup).not.toBe(plugin.setup)
        const replacement = await setupAt(bus, "/project", copy.default)
        replacementCleanup = replacement.cleanup
        replacement.sessionLocations.set(ask.sessionID, "/project")
        const event = { sessionID: ask.sessionID, agent: "build", model: { providerID: "cursor" }, options: {}, messages: [{ role: "tool", content: [{
          type: "tool-result", id: "cursor_reload_gap", name: "shell", providerMetadata: {},
          result: { type: "error", value: { error: { type: "aborted", message: "Interrupted" }, content: [] } },
        }] }] }
        await replacement.hooks.get("session.context")!(event)
        expect(toolResultFailure(event.messages[0]!.content[0]!.providerMetadata, "cursor_reload_gap")?.refusal).toBe("rejected")
      } finally {
        await replacementCleanup?.()
        rmSync(cwd, { recursive: true, force: true })
      }
    })

    test("an iterator that fails synchronously does not count as a live permission observer", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "cursor-failed-observer-"))
      try {
        const broken = fakeContext()
        broken.ctx.event.subscribe = () => ({
          [Symbol.asyncIterator]() { throw new Error("event stream unavailable") },
        })
        await setupPlugin(broken.ctx)
        const bus = fakeEventBus()
        const active = await setupAt(bus, "/project")
        const ask = await askShell(bus, active.hooks, "cursor_failed_observer", cwd)
        await active.cleanup()
        expect(existsSync(ask.shell)).toBe(false)
      } finally { rmSync(cwd, { recursive: true, force: true }) }
    })
  })

  test.each(["context", "compaction", "generate", "title"])("%s preserves authoritative non-shell status and the typed denial", async hook => {
    const { ctx, hooks, sessionLocations } = fakeContext()
    sessionLocations.set("s-results", "/workspace")
    await setupPlugin(ctx)
    const id = "cursor_results_1"
    await hooks.get("tool.execute.after")!({ tool: "write", id, status: "error", error: { _tag: "Tool.Error", error: { _tag: "Permission.BlockedError" } } })
    const event: any = { sessionID: "s-results", agent: "build", model: { providerID: "cursor" }, options: {}, messages: [{ role: "tool", content: [{ type: "tool-result", id, name: "write", result: { type: "error", value: { error: { type: "permission.rejected", message: "Denied" }, content: [] } } }] }] }
    await hooks.get(`session.${hook}`)!(event)
    expect(toolResultFailure(event.messages[0].content[0].providerMetadata, id)).toEqual({ type: "permission.rejected", text: "Denied", refusal: "permission_denied" })
  })

  test("session.compaction flags the compaction option", async () => {
    clearCompactionSessions()
    const { ctx, hooks, sessionLocations } = fakeContext()
    sessionLocations.set("s-c", "/proj")
    await setupPlugin(ctx)
    const event: any = {
      sessionID: "s-c",
      agent: "compaction",
      model: { providerID: "cursor" },
      system: [],
      messages: [],
      tools: {},
    }
    await hooks.get("session.compaction")!(event)
    expect(isCompactionSession("s-c")).toBe(true)
    expect(event.options.opencodeCompaction).toBe(true)
  })

  test("session.generate explicitly clears the request-local compaction option", async () => {
    const { ctx, hooks, sessionLocations } = fakeContext()
    sessionLocations.set("s-g", "/proj")
    await setupPlugin(ctx)
    const event: any = {
      sessionID: "s-g",
      agent: "build",
      model: { providerID: "cursor" },
      system: [],
      messages: [],
      tools: {},
    }
    await hooks.get("session.generate")!(event)
    expect(event.options.opencodeCompaction).toBe(false)
  })

  test("session.title explicitly clears the request-local compaction option", async () => {
    const { ctx, hooks, sessionLocations } = fakeContext()
    sessionLocations.set("s-title", "/proj")
    await setupPlugin(ctx)
    const event: any = {
      sessionID: "s-title",
      model: { providerID: "cursor", id: "model" },
      system: [],
      messages: [],
    }
    await hooks.get("session.title")!(event)
    expect(event.options.opencodeCompaction).toBe(false)
  })
})

describe("opencode2 running tool tracking", () => {
  async function withPluginEvents(events: unknown[], check: () => boolean): Promise<void> {
    const configDir = mkdtempSync(join(tmpdir(), "cursor-oc2-tools-config-"))
    const cacheDir = mkdtempSync(join(tmpdir(), "cursor-oc2-tools-cache-"))
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = configDir
    setHostCacheDirOverride(cacheDir)
    try {
      await writeCache(cacheDir, { models: [baseModel], fetchedAt: Date.now(), schemaVersion: MODEL_CACHE_SCHEMA_VERSION })
      const cleanup = await setupPlugin(fakeContext(events).ctx)
      try {
        for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
      } finally {
        await cleanup()
      }
    } finally {
      setHostCacheDirOverride(undefined)
      if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
      rmSync(configDir, { recursive: true, force: true })
      rmSync(cacheDir, { recursive: true, force: true })
    }
  }

  const toolEvent = (type: string, id: string) => ({
    type,
    data: { sessionID: "ses_tools", assistantMessageID: "msg_1", id, executed: false },
  })

  test("a tool runs from tool.called until its success or failure, and none survives the end of the execution", async () => {
    sessionActivity.clear()
    const running = () => sessionActivity.runningToolDeadline("ses_tools", Date.now(), RUNNING_TOOL_CAP_MS) !== undefined
    try {
      await withPluginEvents([
        toolEvent("session.tool.called", "cursor_run_1"),
        toolEvent("session.tool.success", "cursor_run_1"),
      ], () => sessionActivity.lastActivityAt("ses_tools") !== undefined && !running())
      expect(running()).toBe(false)

      await withPluginEvents([
        toolEvent("session.tool.called", "cursor_run_2"),
        toolEvent("session.tool.called", "cursor_run_3"),
        toolEvent("session.tool.failed", "cursor_run_2"),
      ], running)
      expect(running()).toBe(true)

      await withPluginEvents(
        [{ type: "session.execution.interrupted", data: { sessionID: "ses_tools" } }],
        () => !running(),
      )
      expect(running()).toBe(false)
    } finally {
      sessionActivity.clear()
    }
  })

  test("a stopped execution is reported to the model, a shutdown included, and a normal end is not", async () => {
    const heard: Array<[string | undefined, string, number]> = []
    const stop = onHostInterrupt((sessionID, reason, at) => { heard.push([sessionID, reason, at]) })
    try {
      await withPluginEvents([
        { type: "session.execution.succeeded", data: { sessionID: "ses_done" } },
        { type: "session.execution.failed", data: { sessionID: "ses_failed", error: { type: "unknown", message: "x" } } },
        { type: "session.execution.interrupted", created: 1_790_000_000_000, data: { sessionID: "ses_restart", reason: "shutdown" } },
        { type: "session.execution.interrupted", created: 1_790_000_000_001, data: { sessionID: "ses_stop", reason: "user" } },
        { type: "session.execution.interrupted", created: 1_790_000_000_002, data: { sessionID: "ses_idle", reason: "inactivity" } },
      ], () => heard.length >= 3)
      expect(heard).toEqual([
        ["ses_restart", "shutdown", 1_790_000_000_000],
        ["ses_stop", "user", 1_790_000_000_001],
        ["ses_idle", "inactivity", 1_790_000_000_002],
        [undefined, "shutdown", expect.any(Number)],
      ])
    } finally {
      stop()
      sessionActivity.clear()
    }
  })
})

describe("opencode2 inbox steers", () => {
  async function withPluginEvents(events: unknown[], check: () => boolean): Promise<void> {
    const configDir = mkdtempSync(join(tmpdir(), "cursor-oc2-inbox-config-"))
    const cacheDir = mkdtempSync(join(tmpdir(), "cursor-oc2-inbox-cache-"))
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = configDir
    setHostCacheDirOverride(cacheDir)
    try {
      await writeCache(cacheDir, { models: [baseModel], fetchedAt: Date.now(), schemaVersion: MODEL_CACHE_SCHEMA_VERSION })
      const cleanup = await plugin.setup(fakeContext(events).ctx)
      try {
        for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
      } finally {
        if (typeof cleanup === "function") await cleanup()
      }
    } finally {
      setHostCacheDirOverride(undefined)
      if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
      rmSync(configDir, { recursive: true, force: true })
      rmSync(cacheDir, { recursive: true, force: true })
    }
  }

  test("announces a plain-text message enqueued as a steer, or switched to one", async () => {
    const seen: string[] = []
    const stop = listenForHostSteers("ses_inbox", (steer) => { seen.push(`${steer.inboxID}:${steer.text}`); return true })
    const enqueued = (inboxID: string, delivery: string, payload: Record<string, unknown>) => ({
      type: "session.inbox.enqueued",
      data: { sessionID: "ses_inbox", inboxID, item: { type: "user", delivery, payload } },
    })
    try {
      await withPluginEvents([
        enqueued("msg_inbox_1", "steer", { text: "change of plan" }),
        enqueued("msg_inbox_2", "steer", { text: "see this", files: [{ data: "AA==", mime: "image/png", source: { type: "inline" } }] }),
        enqueued("msg_inbox_3", "queue", { text: "after the turn" }),
        { type: "session.inbox.enqueued", data: { sessionID: "ses_inbox", inboxID: "msg_inbox_4", item: { type: "synthetic", delivery: "steer", payload: { text: "note" } } } },
        enqueued("msg_inbox_5", "queue", { text: "now please" }),
        { type: "session.inbox.delivery.changed", data: { sessionID: "ses_inbox", inboxID: "msg_inbox_5", delivery: "steer" } },
      ], () => seen.length >= 2)
      expect(seen).toEqual(["msg_inbox_1:change of plan", "msg_inbox_5:now please"])
    } finally {
      stop()
      resetHostSteersForTests()
    }
  })

  test("forgets an injected steer when the host cancels its inbox message", async () => {
    recordEarlySteer({
      sessionID: "ses_inbox", inboxID: "msg_inbox_cancel", text: "yes", injectionId: "inj_cancel", run: "run_a",
      delivered: true, checkpointed: false, answered: true,
    })
    try {
      await withPluginEvents([
        { type: "session.inbox.cancelled", data: { sessionID: "ses_inbox", inboxID: "msg_inbox_cancel" } },
      ], () => matchEarlySteers("ses_inbox", ["yes"], () => true).length === 0)
      expect(matchEarlySteers("ses_inbox", ["yes"], () => true)).toEqual([])
    } finally {
      resetHostSteersForTests()
    }
  })
})
