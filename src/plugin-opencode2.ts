import {
  CURSOR_PROVIDER_ID,
  CURSOR_COMPACTION_OPTION,
  CURSOR_HOST_AGENT_OPTION,
} from "./shared.js"
import { createSdk, cursorApiBaseURL, cursorGetServerConfigTelemetryEnabled, isCursorPackage } from "./plugin-core.js"
import { opencode2PlanDir, opencodeGlobalCacheDir, setNativePlansDir } from "./context/paths.js"
import { discoverModels, isCacheFresh, readCache, type ModelInfo } from "./models.js"
import { resolveAgentUrl } from "./agent-url.js"
import { sessionActivity } from "./activity.js"
import { notifyHostInterrupt } from "./host-interrupt.js"
import { takeFinalFailure } from "./host-retry.js"
import {
  announceHostSteer,
  forgetEarlySteers,
  forgetQueuedSteer,
  rememberQueuedSteer,
  takeQueuedSteer,
  type HostSteer,
} from "./host-steer.js"
import {
  fetchOpenCodeWebSearchText,
  parseExaWebSearchResults,
} from "./web-tools.js"
import {
  captureCursorShellResult,
  capturedCursorShellOutcome,
  cursorShellEnvForCommand,
  prepareCursorShellArgs,
  releaseCursorShellEnv,
  sanitizeRegisteredCursorShellOutput,
} from "./shell-timeout.js"
import {
  forgetBackgroundShells,
  noteSessionExecution,
  registerBackgroundShellNotifier,
  watchBackgroundShell,
  type BackgroundShellNotifier,
} from "./background-shell-notice.js"
import { applyCursorProviderInventory, CURSOR_INTEGRATION_ID } from "./opencode2/catalog.js"
import {
  applyCursorIntegration,
  requireCursorAccessToken,
  resolveCursorAccessToken,
} from "./opencode2/integration.js"
import { createDirectMcpPlacement } from "./opencode2/mcp-direct.js"
import { registerTodoTools } from "./opencode2/todo-tools.js"
import { registerCursorImageSaveTool } from "./opencode2/image-save-tool.js"
import { OPENCODE_2_TOOL_DIALECT } from "./protocol/tools.js"
import { clearSessionTodos } from "./todo-store.js"
import { markCompactionSession } from "./compaction-marker.js"
import { getSessionDirectory, markSessionDirectory } from "./session-directory.js"
import { rememberHostSkillFiles } from "./context/skills.js"
import { trace } from "./debug.js"
import {
  cancelHostAgentModeSwitch,
  hostAgentSwitchPromptText,
  setHostAgentModeSwitch,
} from "./host-agent-mode.js"
import {
  clearActiveCursorMode,
  getActiveCursorMode,
  normalizeSwitchModeId,
  setActiveCursorMode,
} from "./protocol/switch-mode.js"
import { CursorPlugin } from "./plugin.js"
import type { CreateCursorOptions } from "./index.js"
import type {
  Cleanup,
  ConnectionInfo,
  PluginContext,
  Plugin2,
  SessionContext,
} from "./opencode2/types.js"

/**
 * OpenCode 2.0 plugin.
 *
 * Separate from `plugin-v2.ts` on purpose: the OpenCode 1.18 `/v2/promise` API
 * and the 2.0 API are source-incompatible (hook signatures, OAuth value type,
 * provider schema), so they cannot share an entrypoint. Shared behavior lives in
 * `plugin-core.ts`, `model-config.ts`, and `opencode2/*`.
 *
 * Models register in memory via `ctx.provider.transform` + `editor.add` +
 * `reload()`. Nothing is written into `opencode.json`.
 *
 * Dual export: `{ id, setup, server: CursorPlugin }`. OpenCode 2.0 Host.resolve
 * loads `./server` then `setup()`. OpenCode 1.18 also prefers `exports["./server"]`
 * and then calls `server()` so classic 1.x hooks still run.
 *
 * Load with:  { "plugin": ["cursor-opencode-provider/plugin/opencode2"] }
 * or a local package directory under `$OPENCODE_CONFIG_DIR/plugins/` that
 * re-exports `dist/plugin-opencode2.js` (OpenCode 2.0 requires a directory,
 * not a .js path).
 */

async function loadModels(
  cacheDir: string,
  accessToken: string | undefined,
  forceRefresh = false,
): Promise<ModelInfo[]> {
  const cached = await readCache(cacheDir)
  if (!forceRefresh && cached?.models.length && isCacheFresh(cached)) return cached.models

  if (accessToken) {
    try {
      return await discoverModels(accessToken, cacheDir, {
        baseURL: cursorApiBaseURL(),
        forceRefresh,
      })
    } catch {
      // A forced refresh follows a credential switch. Do not bind a cache
      // produced by the prior account to the new connection on failure.
      if (forceRefresh) return []
    }
  }
  if (forceRefresh) return []
  // Preserve offline / stale-cache behavior rather than emptying the picker.
  return cached?.models ?? []
}

function toolExecutionID(event: { readonly id?: string; readonly callID?: string }): string {
  const id = event.id ?? event.callID
  if (!id) throw new Error("OpenCode 2.0 tool hook did not provide an execution id")
  return id
}

function isShellTool(name: string | undefined): boolean {
  return name === "bash" || name === "shell"
}

function eventPayload(event: any): any {
  if (event?.data && typeof event.data === "object") return event.data
  if (event?.properties && typeof event.properties === "object") return event.properties
  return event
}

function markCompactionAndOptions(
  event: Pick<SessionContext, "sessionID" | "options">,
  isCompaction: boolean,
): void {
  markCompactionSession(event.sessionID, isCompaction)
  // Keep the request-local flag authoritative. Explicit false prevents a
  // concurrent title/generate/primary request for the same session from
  // inheriting the process-wide fallback marker.
  event.options ??= {}
  event.options[CURSOR_COMPACTION_OPTION] = isCompaction
}

const plugin: Plugin2 & { server: typeof CursorPlugin } = {
  id: "cursor.provider",
  server: CursorPlugin,

  setup: async (ctx: PluginContext): Promise<Cleanup> => {
    const cacheDir = opencodeGlobalCacheDir()
    const workspaceRoot = ctx.location?.directory || process.cwd()
    // CreatePlan writes where OpenCode 2.0's Plan agent keeps plan files.
    // OpenCode 2.0 sets a plugin up once per location instance and again on a
    // plugin reload, then disposes older setups: each cleanup removes only
    // what its own setup installed.
    const disposeNativePlansDir = setNativePlansDir(opencode2PlanDir())
    let disposeHostAgentModeSwitch: (() => void) | undefined
    trace(`opencode2 plugin: setup directory=${workspaceRoot}`)
    const hasShellEnvHook = typeof ctx.shell?.hook === "function"
    const synthetic = ctx.session.synthetic
    const shellNotifier: BackgroundShellNotifier | undefined = synthetic ? (note) => synthetic(note) : undefined
    const disposeShellNotifier = shellNotifier && registerBackgroundShellNotifier(shellNotifier)

    if (typeof ctx.session.switchAgent === "function") {
      const switchAgent = ctx.session.switchAgent
      const continueTurn =
        typeof ctx.session.synthetic === "function"
          ? ctx.session.synthetic
          : typeof ctx.session.prompt === "function"
            ? ctx.session.prompt
            : undefined
      disposeHostAgentModeSwitch = setHostAgentModeSwitch(
        async ({ sessionID, targetModeID }) => {
          const agent = normalizeSwitchModeId(targetModeID) === "plan"
            || normalizeSwitchModeId(targetModeID) === "spec"
            ? "plan"
            : "build"
          await switchAgent({ sessionID, agent })
          // switchAgent only publishes AgentSelected and leaves the session idle.
          // Continue under the new agent the same way OpenCode 1.x promptAsync does.
          if (continueTurn) {
            await continueTurn({
              sessionID,
              text: hostAgentSwitchPromptText(agent),
            })
          }
        },
        continueTurn ? { resumesTurn: true } : {},
      )
    }

    const registrations: Array<{ dispose: () => Promise<void> }> = []
    const track = async (p: Promise<{ dispose: () => Promise<void> }>) => {
      registrations.push(await p)
    }

    let models: ModelInfo[] = []
    let sourceConnection: ConnectionInfo | undefined

    // ── Credentials ─────────────────────────────────────────
    await track(ctx.integration.transform(applyCursorIntegration))

    let tokenInflight: Promise<string | undefined> | undefined
    /**
     * Current token for model discovery and endpoint warmup, or undefined.
     *
     * Resolved every time (concurrent callers share one attempt) and never
     * memoized: on a fresh install `setup()` runs before the user has
     * connected, and a long-running daemon outlives any single token. Both
     * the host resolve and the renewal layer are cheap until a renewal is due.
     */
    const accessToken = async (): Promise<string | undefined> => {
      tokenInflight ??= resolveCursorAccessToken(ctx.integration).finally(() => {
        tokenInflight = undefined
      })
      return tokenInflight
    }

    const refreshSourceConnection = async (): Promise<void> => {
      try {
        sourceConnection = await ctx.integration.connection.active(CURSOR_INTEGRATION_ID)
      } catch {
        sourceConnection = undefined
      }
    }

    // ── Provider inventory (in-memory `editor.add`) ─────────────────────
    // Transform replays on provider.reload(). Skip while `models` is empty so
    // the first registration is a no-op; discovery/cache then reload.
    await track(
      ctx.provider.transform((editor) => {
        applyCursorProviderInventory(editor, models, sourceConnection)
      }),
    )

    try {
      const cached = await readCache(cacheDir)
      if (cached?.models?.length) {
        models = cached.models
        await refreshSourceConnection()
        await ctx.provider.reload()
      }
    } catch {
      // Cache seed is best-effort; auth/aisdk still work without it.
    }

    const publishModels = async (next: ModelInfo[]): Promise<boolean> => {
      const previousModels = models
      const previousConnection = sourceConnection
      models = next
      await refreshSourceConnection()
      try {
        await ctx.provider.reload()
        return true
      } catch {
        // Keep the transform backed by the last inventory that actually
        // reloaded. A later host replay must not publish a failed account
        // refresh merely because the candidate remained in this closure.
        models = previousModels
        sourceConnection = previousConnection
        return false
      }
    }

    // ── AI SDK wiring ────────────────────────────────────────
    await track(
      ctx.aisdk.hook("sdk", async (event) => {
        if (event.sdk) return
        if (!isCursorPackage(event.package, event.model.providerID)) return
        event.sdk = createSdk({
          name: event.model.providerID || CURSOR_PROVIDER_ID,
          // Resolved per Run open: this SDK lives as long as the daemon, so
          // a token captured here would outlive its expiry.
          getAccessToken: (request) => requireCursorAccessToken(ctx.integration, request),
          // Static fallback only. This hook fires once per model/package, not
          // per session, and 2.0 runs one daemon across many projects — the
          // real per-request directory comes from `x-opencode-directory`
          // (set on `session.model.request`) and the session-directory mark.
          workspaceRoot,
          cacheDir,
          ...event.options,
          // Keep after `event.options` so the OC2 plugin always selects the
          // `path`/`shell` dialect when advertised schemas are opaque.
          defaultDialect: OPENCODE_2_TOOL_DIALECT,
        } as CreateCursorOptions)
      }),
    )

    await track(
      ctx.aisdk.hook("language", (event) => {
        if (event.language) return
        if (event.model.providerID !== CURSOR_PROVIDER_ID) return
        if (typeof event.sdk?.languageModel !== "function") return
        // `modelID` is the Cursor wire id; `id` may be a synthetic long-context entry.
        event.language = event.sdk.languageModel(event.model.modelID || event.model.id)
      }),
    )

    // ── Web search ───────────────────────────────────────────
    // Publish an OpenCode 2.0 `websearch` provider (`{url,title,content,time}`).
    // The classic entrypoint owns the permission-aware `custom_websearch`
    // fallback; 2.0's public plugin tool context cannot request permission.
    if (ctx.websearch) {
      await track(
        ctx.websearch.transform((draft) => {
          draft.add({
            id: "cursor-exa",
            name: "Exa",
            execute: async (input, context) => {
              const output = await fetchOpenCodeWebSearchText(
                { query: input.query },
                context.signal,
              )
              return parseExaWebSearchResults(output)
            },
          })
        }),
      )
    }

    // Namespaces whose tools belong on the direct catalog. Recorded by the MCP
    // transform (config is not written) and read when tool transforms replay,
    // including after a later MCP discovery reload.
    const directMcp = createDirectMcpPlacement(() => ctx.tool.reload())
    if (ctx.mcp) {
      await track(
        ctx.mcp.transform((editor) => {
          directMcp.rememberServers(editor.list())
        }),
      )
    }

    await track(
      ctx.tool.transform((draft) => {
        // OpenCode 2 dropped host todowrite/todoread. Off by default
        // (`CURSOR_OPENCODE2_TODOS=1`/`true` force-enables). When on, register
        // them as direct catalog tools (`codemode: false` + output schema) if
        // the host does not already own those names. When off, register none.
        registerTodoTools(draft)
        registerCursorImageSaveTool(draft, ctx)
        // MCP tools default into Code Mode. Move every server that did not
        // explicitly opt in onto the direct catalog so this provider can
        // advertise them to Cursor (issue #29 still routes via CallDynamicTool).
        // See `opencode2/mcp-direct.ts`.
        directMcp.expose(draft)
      }),
    )

    // ── Shell timeout wrapper ────────────────────────────────
    await track(
      ctx.tool.hook("execute.before", (event) => {
        if (!isShellTool(event.tool)) return
        const executionID = toolExecutionID(event)
        prepareCursorShellArgs(executionID, event.input as Record<string, unknown>, {
          // OpenCode 2.0 `shell.create.before` can inject env for bash/zsh.
          preferWrapperCommand: !hasShellEnvHook,
        })
      }),
    )

    await track(
      ctx.tool.hook("execute.after", (event) => {
        if (!isShellTool(event.tool)) return
        const executionID = toolExecutionID(event)
        try {
          if (event.status !== "completed") return
          const result = event.result as Record<string, any>
          // V1: `output` is the model-facing string. V2: `output` is structured
          // per-tool output (shell: `{ output: string, ... }`) and the
          // model-facing text lives on `content`. Sanitize every string
          // location; non-strings pass through via the guards in shell-timeout.
          if (typeof result.output === "string") {
            result.output = captureCursorShellResult(
              executionID,
              result.output,
              result.metadata as Record<string, unknown> | undefined,
            )
          } else if (result.output && typeof result.output === "object") {
            const structured = result.output as Record<string, unknown>
            if (typeof structured.output === "string") {
              structured.output = captureCursorShellResult(
                executionID,
                structured.output,
                result.metadata as Record<string, unknown> | undefined,
              )
            }
          }
          if (typeof result.content === "string") {
            result.content = sanitizeRegisteredCursorShellOutput(executionID, result.content)
          } else if (Array.isArray(result.content)) {
            result.content = result.content.map((item: unknown) => {
              if (!item || typeof item !== "object") return item
              const content = item as Record<string, unknown>
              if (content.type !== "text" || typeof content.text !== "string") return item
              return {
                ...content,
                text: sanitizeRegisteredCursorShellOutput(executionID, content.text),
              }
            })
          } else if (typeof result.output === "string" && result.content === undefined) {
            result.content = result.output
          }
          if (result.metadata && typeof result.metadata === "object") {
            const metadata = result.metadata as Record<string, unknown>
            if (typeof metadata.output === "string") {
              metadata.output = sanitizeRegisteredCursorShellOutput(executionID, metadata.output)
            }
          }
          if (shellNotifier) watchCursorBackgroundShell(executionID, event.sessionID, shellNotifier)
        } finally {
          releaseCursorShellEnv(executionID)
        }
      }),
    )

    if (ctx.shell) {
      await track(
        ctx.shell.hook("create.before", (event) => {
          const env = cursorShellEnvForCommand(event.command, event.cwd)
          if (!env) return
          event.env = { ...event.env, ...env }
        }),
      )
    }

    const rememberSessionDirectory = async (sessionID: string) => {
      try {
        const info = await ctx.session.get({ sessionID })
        markSessionDirectory(sessionID, info.location.directory)
      } catch (error) {
        // Best effort — falls back to the static workspaceRoot above.
        trace(`session directory: session.get failed sessionID=${sessionID}: ${String(error)}`)
      }
    }

    await track(
      ctx.session.hook("context", async (event) => {
        markCompactionAndOptions(event, event.agent === "compaction")
        event.options ??= {}
        event.options[CURSOR_HOST_AGENT_OPTION] = event.agent
        if (event.agent !== "compaction") {
          const activeMode = getActiveCursorMode(event.sessionID)
          if (event.agent === "plan") {
            if (activeMode !== "plan" && activeMode !== "spec") {
              setActiveCursorMode(event.sessionID, "plan")
            }
          } else if (activeMode === "plan" || activeMode === "spec") {
            // A direct OpenCode UI switch away from Plan is authoritative. Do
            // not overwrite other Cursor-only modes (chat/debug/etc.) merely
            // because their closest native primary agent is `build`.
            setActiveCursorMode(event.sessionID, "agent")
          }
        }
        await rememberSessionDirectory(event.sessionID)
      }),
    )

    // The session mark lives in module state, and OpenCode re-evaluates a local
    // plugin's module graph per Location, so the copy running the model may not
    // hold it. The header travels with the request (AI SDK
    // `callOptions.headers` → `resolveSessionWorkspaceRoot`) and never reaches
    // Cursor. Only a successful lookup updates the mark; on failure keep the
    // last known session directory ahead of this Location's static root.
    // Scoped by the host to this provider: other providers' requests never
    // reach the callback, so the header cannot leak to their endpoints.
    // Skill files for RequestContext path-desc `agent_skills` (see context/skills.ts).
    const rememberSkillFiles = async () => {
      if (!ctx.skill) return
      try {
        const listed = await ctx.skill.list()
        // skill.list is bound to this plugin Location. A session may have
        // moved; never relabel this catalog with the session's new directory.
        rememberHostSkillFiles(listed.location.directory, listed.data)
      } catch (error) {
        trace(`model.request: skill.list failed: ${String(error)}`)
      }
    }

    await track(
      ctx.session.hook(
        "model.request",
        async (event) => {
          const current = await ctx.session
            .get({ sessionID: event.sessionID })
            .then((info) => info.location.directory)
            .catch((error: unknown) => {
              trace(`model.request: session.get failed sessionID=${event.sessionID}: ${String(error)}`)
              return undefined
            })
          markSessionDirectory(event.sessionID, current)
          const directory = current ?? getSessionDirectory(event.sessionID) ?? ctx.location?.directory
          if (!directory) return
          await rememberSkillFiles()
          event.headers = {
            ...event.headers,
            "x-opencode-directory": encodeURIComponent(directory),
          }
        },
        { providerID: CURSOR_PROVIDER_ID },
      ),
    )

    await track(
      ctx.session.hook(
        "retry",
        (event) => {
          if (!event.decision.retry || !takeFinalFailure(event.sessionID, event.error?.message)) return
          trace(`retry: not retrying sessionID=${event.sessionID} attempt=${event.attempt}: ${event.error.message}`)
          event.decision = { retry: false }
        },
        { providerID: CURSOR_PROVIDER_ID },
      ),
    )

    await track(
      ctx.session.hook("compaction", async (event) => {
        markCompactionAndOptions(event, true)
        await rememberSessionDirectory(event.sessionID)
      }),
    )

    await track(
      ctx.session.hook("generate", async (event) => {
        markCompactionAndOptions(event, false)
        await rememberSessionDirectory(event.sessionID)
      }),
    )

    await track(
      ctx.session.hook("title", async (event) => {
        markCompactionAndOptions(event, false)
        await rememberSessionDirectory(event.sessionID)
      }),
    )

    // ── Model discovery ────────────────────────────────────────
    let modelsLoaded = false
    let credentialGeneration = 0
    let loadedCredentialGeneration = 0
    let ensureInflight: Promise<void> | undefined
    const ensureModels = (): Promise<void> => {
      if (modelsLoaded && loadedCredentialGeneration === credentialGeneration) {
        return Promise.resolve()
      }
      // If credentials change during an existing discovery, wait for that
      // attempt and immediately run again. The generation check prevents the
      // older attempt from suppressing the account-scoped refresh.
      if (ensureInflight) return ensureInflight.then(() => ensureModels())

      const attemptGeneration = credentialGeneration
      const forceRefresh = loadedCredentialGeneration !== attemptGeneration
      ensureInflight = (async () => {
        try {
          const token = await accessToken()
          const discovered = await loadModels(cacheDir, token, forceRefresh)
          if (!discovered.length) return
          if (credentialGeneration !== attemptGeneration) return
          if (!await publishModels(discovered)) return
          // A newer credential event arrived while this request was in flight.
          // Keep the state dirty so the chained ensure uses the latest token.
          if (credentialGeneration !== attemptGeneration) return
          modelsLoaded = true
          loadedCredentialGeneration = attemptGeneration
          if (token) {
            await resolveAgentUrl(token, {
              apiBaseURL: cursorApiBaseURL(),
              telemetryEnabled: cursorGetServerConfigTelemetryEnabled(),
            }).catch(() => {})
          }
        } finally {
          ensureInflight = undefined
        }
      })()
      return ensureInflight
    }

    const RETRY_INTERVAL_MS = 3_000
    const RETRY_WINDOW_MS = 300_000
    const startedAt = Date.now()
    const retry = setInterval(() => {
      if (modelsLoaded || Date.now() - startedAt > RETRY_WINDOW_MS) {
        clearInterval(retry)
        return
      }
      void ensureModels().catch(() => {})
    }, RETRY_INTERVAL_MS)
    ;(retry as unknown as { unref?: () => void }).unref?.()

    void ensureModels().catch(() => {})

    const onCredentialSwitch = () => {
      modelsLoaded = false
      credentialGeneration++
    }

    const unsubscribe = subscribeSessionActivity(ctx, ensureModels, onCredentialSwitch)

    return async () => {
      clearInterval(retry)
      unsubscribe?.()
      disposeShellNotifier?.()
      disposeHostAgentModeSwitch?.()
      disposeNativePlansDir()
      trace(`opencode2 plugin: cleanup directory=${workspaceRoot}`)
      for (const registration of registrations.reverse()) {
        await registration.dispose().catch(() => {})
      }
    }
  },
}

function subscribeSessionActivity(
  ctx: PluginContext,
  onEvent?: () => void,
  onCredentialSwitch?: () => void,
): (() => void) | undefined {
  try {
    const stream = ctx.event.subscribe()
    if (!stream || typeof stream[Symbol.asyncIterator] !== "function") return undefined
    let stopped = false
    void (async () => {
      for await (const event of stream as AsyncIterable<any>) {
        if (stopped) break
        applySessionActivity(event, onCredentialSwitch)
        applyBackgroundShellLifecycle(event)
        onEvent?.()
      }
    })().catch(() => {})
    return () => {
      stopped = true
    }
  } catch {
    return undefined
  }
}

const EXECUTION_PHASES = ["started", "succeeded", "failed", "interrupted"] as const
type ExecutionPhase = (typeof EXECUTION_PHASES)[number]

function applyBackgroundShellLifecycle(event: any): void {
  const type = typeof event?.type === "string" ? event.type : ""
  const payload = eventPayload(event)
  const sessionID = payload?.sessionID ?? payload?.info?.id
  if (typeof sessionID !== "string" || !sessionID) return
  if (type === "session.deleted") {
    forgetBackgroundShells(sessionID)
    return
  }
  const phase = type.slice("session.execution.".length) as ExecutionPhase
  if (type.startsWith("session.execution.") && EXECUTION_PHASES.includes(phase)) noteSessionExecution(sessionID, phase)
}

function watchCursorBackgroundShell(executionID: string, sessionID: string, notifier: BackgroundShellNotifier): void {
  const outcome = capturedCursorShellOutcome(executionID)
  if (outcome?.kind !== "backgrounded" || !outcome.logPath) return
  watchBackgroundShell({ sessionID, pid: outcome.pid, file: outcome.logPath, command: outcome.command, notifier })
}

function applySessionActivity(event: any, onCredentialSwitch?: () => void): void {
  const payload = eventPayload(event)
  const info = payload?.info
  switch (event?.type) {
    case "credential.switched":
    case "credential.updated": {
      const integrationID = payload?.integrationID
      if (!integrationID || integrationID === CURSOR_INTEGRATION_ID || integrationID === CURSOR_PROVIDER_ID) {
        onCredentialSwitch?.()
      }
      break
    }
    case "session.created":
    case "session.updated":
    case "session.forked": {
      const id = payload?.sessionID ?? info?.id
      const parentID = payload?.parentID ?? info?.parentID
      if (id) {
        sessionActivity.linkSession(id, parentID)
        if (event.type === "session.created") sessionActivity.recordActivity(id)
      }
      break
    }
    case "session.deleted": {
      const id = payload?.sessionID ?? info?.id
      if (id) {
        sessionActivity.removeSession(id)
        clearSessionTodos(id)
        forgetEarlySteers(id)
        clearActiveCursorMode(id)
        cancelHostAgentModeSwitch(id)
      }
      break
    }
    case "message.updated": {
      const id = payload?.sessionID ?? info?.sessionID
      if (id) sessionActivity.recordActivity(id)
      break
    }
    case "message.part.updated": {
      const id = payload?.sessionID ?? payload?.part?.sessionID ?? info?.sessionID
      if (id) sessionActivity.recordActivity(id)
      break
    }
    case "session.usage.updated":
    case "session.usage.recorded": {
      const id = payload?.sessionID
      if (id) sessionActivity.recordActivity(id)
      break
    }
    case "session.tool.called":
    case "session.tool.success":
    case "session.tool.failed": {
      const id = payload?.sessionID
      const callID = typeof payload?.id === "string" ? payload.id : undefined
      if (id) sessionActivity.recordActivity(id)
      if (id && callID) {
        if (event.type === "session.tool.called") sessionActivity.toolStarted(id, callID)
        else sessionActivity.toolEnded(callID)
      }
      break
    }
    case "session.inbox.enqueued": {
      const id = payload?.sessionID
      if (id) sessionActivity.recordActivity(id)
      const steer = inboxSteer(id, payload?.inboxID, payload?.item)
      if (!steer) break
      if (payload.item.delivery === "steer") announceInboxSteer(steer)
      else rememberQueuedSteer(steer)
      break
    }
    case "session.inbox.delivery.changed": {
      const id = payload?.sessionID
      if (id) sessionActivity.recordActivity(id)
      if (payload?.delivery !== "steer" || typeof payload?.inboxID !== "string") break
      const steer = takeQueuedSteer(payload.inboxID)
      if (steer) announceInboxSteer(steer)
      break
    }
    case "session.inbox.delivered":
    case "session.inbox.cancelled": {
      const id = payload?.sessionID
      if (id) sessionActivity.recordActivity(id)
      if (typeof payload?.inboxID === "string") forgetQueuedSteer(payload.inboxID)
      break
    }
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted": {
      const id = payload?.sessionID
      if (id) {
        sessionActivity.recordActivity(id)
        sessionActivity.endSessionTools(id)
        // A shutdown keeps the turn for the next server start to resume.
        if (event.type === "session.execution.interrupted" && payload?.reason !== "shutdown") {
          notifyHostInterrupt(
            id,
            typeof payload?.reason === "string" ? payload.reason : "user",
            typeof event.created === "number" ? event.created : Date.now(),
          )
        }
      }
      break
    }
    default: {
      // OpenCode 2.0 emits granular `session.*` progress events instead of
      // the V1 `message.updated` family (`session.tool.called/success/failed`,
      // `session.step.*`, `session.text.*`, `session.execution.*`, ...). Any of
      // them proves the session is alive and renews a pending-tool lease.
      const type = typeof event?.type === "string" ? event.type : ""
      if (type.startsWith("session.") && type !== "session.deleted") {
        const id = payload?.sessionID ?? info?.sessionID ?? info?.id
        if (id) sessionActivity.recordActivity(id)
      }
      break
    }
  }
}

/** A plain-text user message; one with files or skill text reaches the prompt in another shape. */
function inboxSteer(sessionID: unknown, inboxID: unknown, item: any): HostSteer | undefined {
  if (typeof sessionID !== "string" || !sessionID || typeof inboxID !== "string" || !inboxID) return undefined
  if (item?.type !== "user" || (item.delivery !== "steer" && item.delivery !== "queue")) return undefined
  const prompt = item.payload
  if (typeof prompt?.text !== "string" || !prompt.text.trim()) return undefined
  if (prompt.files?.length || prompt.skills?.length) return undefined
  return { sessionID, inboxID, text: prompt.text }
}

function announceInboxSteer(steer: HostSteer): void {
  const taken = announceHostSteer(steer)
  if (taken === undefined) return
  trace(
    `steer: OpenCode enqueued a mid-step message sessionID=${steer.sessionID} inboxID=${steer.inboxID} ` +
      `chars=${steer.text.length} ${taken ? "injected into the pumping Run" : "left for the next step"}`,
  )
}

export default plugin
