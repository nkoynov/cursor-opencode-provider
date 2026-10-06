import type { Hooks, PluginInput, AuthOAuthResult, Config } from "@opencode-ai/plugin"
import type { Auth } from "@opencode-ai/sdk"
import {
  CURSOR_API_HOST,
  CURSOR_COMPACTION_OPTION,
  CURSOR_HOST_AGENT_OPTION,
  CURSOR_PROVIDER_ID,
  CURSOR_WEBSITE_HOST,
} from "./shared.js"
import { cursorApiBaseURL, cursorGetServerConfigTelemetryEnabled } from "./plugin-core.js"
import { pollForTokens, exchangeApiKey, isExpiringSoon, generatePkceParams, generatePkceChallenge, buildLoginUrl, decodeJwtExpiryMs, isExchangeableApiKey } from "./auth.js"
import {
  renewSessionIfDue,
  resolveApiKeyToken,
  type AccessTokenProvider,
  type SessionRenewal,
} from "./auth-renewal.js"
import { CursorAuthError } from "./errors.js"
import { errorMessage, trace } from "./debug.js"
import { readCache, discoverModels, isCacheFresh } from "./models.js"
import { modelsToConfig } from "./model-config.js"
import { loadClassicTools } from "./classic-tools.js"
import { opencodeGlobalCacheDir } from "./context/paths.js"
import { readStoredAuth, type StoredAuth } from "./context/auth-store.js"
import { resolveAgentUrl } from "./agent-url.js"
import {
  captureCursorShellResult,
  cursorShellEnvForCall,
  cursorShellOriginalCommand,
  prepareCursorShellArgs,
  releaseCursorShellEnv,
  sanitizeRegisteredCursorShellOutput,
  setCursorShellPath,
} from "./shell-timeout.js"
import { sessionActivity } from "./activity.js"
import {
  createPlanExecutionKickoffText,
  setPlanExecutionKickoff,
} from "./plan-execution-kickoff.js"
import { dispatchHostEventBridge } from "./host-event-bridge.js"

const MODULE_URL = new URL("./index.js", import.meta.url).href

// OpenCode 1.x calls every export of a plugin module as a plugin
// (`getLegacyPlugins`), so a `file://…/dist/plugin.js` load requires this
// module to export `CursorPlugin` and nothing else. Helpers live in their own
// modules (`model-config.ts`, `classic-tools.ts`).

type CursorAuth = Auth | StoredAuth
type ApiCredential = { type: "api"; key: string; metadata?: Record<string, string> }
type SessionCredential = Extract<CursorAuth, { type: "oauth" }>

/**
 * Raw `crsr_` key behind an API-key login: under `metadata.apiKey` (saved at
 * login, and merged there from the prompt inputs by OpenCode's CLI), or as
 * `key` itself when OpenCode stored the typed key without our exchange.
 */
function storedApiKey(auth: ApiCredential): string | undefined {
  const fromMetadata = auth.metadata?.apiKey
  if (typeof fromMetadata === "string" && isExchangeableApiKey(fromMetadata)) return fromMetadata
  return isExchangeableApiKey(auth.key) ? auth.key : undefined
}

function sessionTokens(auth: SessionCredential) {
  // Cursor's IDE refreshes with the stored refresh token and then stores the
  // new access token as both; an empty refresh field means the same.
  return { accessToken: auth.access, refreshToken: auth.refresh || auth.access }
}

/** Whether `latest` is still the credential a renewal started from. */
function isSameCredential(latest: CursorAuth, started: CursorAuth): boolean {
  if (latest.type === "oauth" && started.type === "oauth") {
    return latest.access === started.access && latest.refresh === started.refresh
  }
  if (latest.type === "api" && started.type === "api") {
    return latest.key === started.key && storedApiKey(latest) === storedApiKey(started)
  }
  return false
}

export async function CursorPlugin(input: PluginInput): Promise<Hooks> {
  const cacheDir = opencodeGlobalCacheDir()
  const apiBaseURL = cursorApiBaseURL()
  const classicTools = await loadClassicTools()

  // Install the OpenCode plan-exit-shaped kickoff only when the OpenCode client
  // exposes that structural API. Without it, no synthetic kickoff is registered.
  const sessionClient = (input as unknown as {
    client?: { session?: { promptAsync?: (args: unknown) => Promise<unknown> } }
  }).client?.session
  const promptAsync = sessionClient?.promptAsync
  setPlanExecutionKickoff(
    typeof promptAsync === "function"
      ? async ({ sessionID, planPath }) => {
          await promptAsync.call(sessionClient, {
            path: { id: sessionID },
            body: {
              agent: "build",
              parts: [{
                type: "text",
                text: createPlanExecutionKickoffText(planPath),
                synthetic: true,
              }],
            },
          })
        }
      : undefined,
  )

  let lastPersistAttempt: string | undefined

  async function persistAuth(body: Auth): Promise<void> {
    await input.client.auth.set({
      path: { id: CURSOR_PROVIDER_ID },
      body,
    })
  }

  /** Persist refreshed credentials without failing the caller that already holds a live token. */
  async function persistAuthBestEffort(body: Auth): Promise<void> {
    try {
      await persistAuth(body)
    } catch {
      // ignore — token is still usable for this process
    }
  }

  /**
   * Durable credentials OpenCode stores on disk (same file getAuth() reads in
   * the normal path). Used from `config`, which has no getAuth() callback.
   */
  async function authFromStore(): Promise<Auth | StoredAuth | undefined> {
    return readStoredAuth(CURSOR_PROVIDER_ID)
  }

  /**
   * Prefer OpenCode's live getAuth(); fall back to the durable store so loader
   * and config share the same underlying credentials when possible.
   */
  async function authForLoader(
    getAuth: () => Promise<Auth | undefined>,
  ): Promise<CursorAuth | undefined> {
    // getAuth is also called long after the loader returned (per-Run token
    // resolution); never let a host-side failure there hide the durable store.
    return (await getAuth().catch(() => undefined)) ?? (await authFromStore())
  }

  /**
   * Persist a renewed credential unless the stored one changed meanwhile (a
   * re-login, or another process's renewal): never overwrite newer state.
   */
  async function persistRenewal(
    started: CursorAuth,
    next: Auth,
    readCurrent: () => Promise<CursorAuth | undefined>,
  ): Promise<void> {
    // One attempt per renewed token: when the write fails (read-only store,
    // injected OPENCODE_AUTH_CONTENT) later Runs keep the in-memory token
    // instead of re-reading and re-writing the store on every turn.
    const token = next.type === "oauth" ? next.access : next.type === "api" ? next.key : undefined
    if (token === undefined || token === lastPersistAttempt) return
    lastPersistAttempt = token
    const latest = await readCurrent().catch(() => undefined)
    if (!latest || !isSameCredential(latest, started)) {
      trace("auth: stored Cursor credential changed during renewal; keeping the stored one")
      return
    }
    await persistAuthBestEffort(next)
  }

  /** Browser-login session: renew when due (or forced) and persist the result. */
  async function resolveSession(
    auth: SessionCredential,
    readCurrent: () => Promise<CursorAuth | undefined>,
    force = false,
  ): Promise<SessionRenewal> {
    const renewal = await renewSessionIfDue(sessionTokens(auth), { baseUrl: apiBaseURL, force })
    if (renewal.renewed) {
      // Preserve optional OAuth fields (v2 Auth / plugin may carry these).
      const extras = auth as { accountId?: string; enterpriseUrl?: string }
      await persistRenewal(auth, {
        type: "oauth",
        access: renewal.accessToken,
        refresh: renewal.accessToken,
        expires: decodeJwtExpiryMs(renewal.accessToken) ?? Date.now(),
        ...(extras.accountId !== undefined ? { accountId: extras.accountId } : {}),
        ...(extras.enterpriseUrl !== undefined ? { enterpriseUrl: extras.enterpriseUrl } : {}),
      }, readCurrent)
    }
    return renewal
  }

  /** API-key login: re-exchange the stored raw key when the JWT nears expiry. */
  async function resolveApiKeyLogin(
    auth: ApiCredential,
    readCurrent: () => Promise<CursorAuth | undefined>,
    force = false,
  ): Promise<string> {
    const apiKey = storedApiKey(auth)
    if (!apiKey) {
      // Saved by an older version that kept only the exchanged JWT and its
      // refresh token. Cursor renews API-key logins only by exchanging the key.
      if (!isExpiringSoon(auth.key, 30)) return auth.key
      throw new CursorAuthError(
        "This Cursor API-key login was saved without the key, so it cannot be renewed; sign in again with the API key",
        { code: "api_key_missing" },
      )
    }
    const token = await resolveApiKeyToken(apiKey, {
      baseUrl: apiBaseURL,
      ...(isExchangeableApiKey(auth.key) ? {} : { seed: auth.key }),
      force,
    })
    if (token.renewed) {
      const { refreshToken: _unused, ...metadata } = auth.metadata ?? {}
      await persistRenewal(auth, {
        type: "api",
        key: token.accessToken,
        metadata: { ...metadata, apiKey },
      }, readCurrent)
    }
    return token.accessToken
  }

  /**
   * Current access token for the stored credential. The two credential kinds
   * are handled by separate paths and never substitute for each other.
   */
  async function resolveAccessToken(
    auth: CursorAuth,
    readCurrent: () => Promise<CursorAuth | undefined>,
    force = false,
  ): Promise<string | undefined> {
    if (auth.type === "oauth") return (await resolveSession(auth, readCurrent, force)).accessToken
    if (auth.type === "api") return resolveApiKeyLogin(auth, readCurrent, force)
    return undefined
  }

  /** Best-effort token for startup work (model discovery, endpoint warmup). */
  async function startupAccessToken(
    auth: CursorAuth,
    readCurrent: () => Promise<CursorAuth | undefined>,
  ): Promise<string | undefined> {
    try {
      return await resolveAccessToken(auth, readCurrent)
    } catch (error) {
      // Surfaced again, with the same message, when a Run asks for a token.
      trace(`auth: no usable Cursor token at startup (${errorMessage(error)})`)
      return undefined
    }
  }

  async function loadModels(): Promise<Record<string, any>> {
    const cached = await readCache(cacheDir)
    if (cached?.models.length && isCacheFresh(cached)) {
      return modelsToConfig(cached.models)
    }

    // Config runs before auth.loader and has no getAuth(); read the durable
    // store (normally the same source getAuth() uses). Refresh missing, expired,
    // or old-schema caches here so this process materializes the new model set.
    const auth = await authFromStore()
    if (auth) {
      const accessToken = await startupAccessToken(auth, authFromStore)
      if (accessToken) {
        try {
          const models = await discoverModels(accessToken, cacheDir, { baseURL: apiBaseURL })
          return modelsToConfig(models)
        } catch {
          // No usable cache and discovery failed — leave the list empty.
        }
      }
    }

    // Preserve stale-on-failure/offline behavior for an existing cache.
    return cached?.models.length ? modelsToConfig(cached.models) : {}
  }

  return {
    tool: {
      // `websearch` is a reserved OpenCode id and is filtered for third-party
      // providers after plugin tools are merged. Use the collision-safe id
      // Cursor already sees so this host-side fallback survives that filter.
      custom_websearch: classicTools.webSearch,
      // Commits Cursor-generated image bytes, which cannot travel through the
      // host's text `write`. Handle-only, so its presence in the catalog does
      // not give any model a way to write arbitrary files — see image-save.ts.
      cursor_image_save: classicTools.imageSave,
    },

    async event({ event }) {
      switch (event.type) {
        case "session.created":
          sessionActivity.linkSession(event.properties.info.id, event.properties.info.parentID)
          sessionActivity.recordActivity(event.properties.info.id)
          break
        case "session.updated":
          sessionActivity.linkSession(event.properties.info.id, event.properties.info.parentID)
          break
        case "session.deleted":
          sessionActivity.removeSession(event.properties.info.id)
          break
        case "message.updated":
          sessionActivity.recordActivity(event.properties.info.sessionID)
          break
        case "message.part.updated": {
          const part = event.properties.part
          sessionActivity.recordActivity(part.sessionID)
          if (part.type === "tool") {
            if (part.state.status === "running") sessionActivity.toolStarted(part.sessionID, part.callID)
            else if (part.state.status === "completed" || part.state.status === "error") sessionActivity.toolEnded(part.callID)
          }
          break
        }
        case "session.idle":
          sessionActivity.endSessionTools(event.properties.sessionID)
          break
      }
      await dispatchHostEventBridge({
        event,
        client: input.client,
        directory: input.directory,
        serverUrl: input.serverUrl,
      })
    },

    async "tool.execute.before"(hookInput, output) {
      if (hookInput.tool !== "bash") return
      // bash/zsh retain the original display/permission command and wrap via
      // shell.env. sh/dash need a short wrapper-file command because their
      // non-interactive `-c` path ignores BASH_ENV / ZDOTDIR.
      prepareCursorShellArgs(hookInput.callID, output.args as Record<string, unknown>)
    },

    async "shell.env"(hookInput, output) {
      const env = cursorShellEnvForCall(hookInput.callID)
      if (!env) return
      Object.assign(output.env, env)
    },

    async "tool.execute.after"(hookInput, output) {
      if (hookInput.tool !== "bash") return
      try {
        output.title = cursorShellOriginalCommand(hookInput.callID) ?? output.title
        output.output = captureCursorShellResult(
          hookInput.callID,
          output.output,
          output.metadata as Record<string, unknown> | undefined,
        )
        // OpenCode's bash GUI falls back to metadata.output when output is empty
        // (`props.output || props.metadata.output`), so strip private markers there too.
        if (output.metadata && typeof output.metadata === "object") {
          const metadata = output.metadata as Record<string, unknown>
          if (typeof metadata.output === "string") {
            metadata.output = sanitizeRegisteredCursorShellOutput(hookInput.callID, metadata.output)
          }
        }
      } finally {
        releaseCursorShellEnv(hookInput.callID)
      }
    },

    async "chat.params"(hookInput, output) {
      if (hookInput.model.providerID !== CURSOR_PROVIDER_ID) return
      // Agent changes can replace the host system prompt and mode contract.
      // Carry the canonical OpenCode id so an incompatible Cursor checkpoint
      // is rotated instead of resuming the prior agent's prompt.
      output.options[CURSOR_HOST_AGENT_OPTION] = hookInput.agent
      // OpenCode's compaction pipeline invokes the LLM with agent="compaction".
      // Carry that stable runtime fact into LanguageModelV3 providerOptions so
      // the provider never has to guess from an empty tool list.
      if (hookInput.agent === "compaction") {
        output.options[CURSOR_COMPACTION_OPTION] = true
      }
    },

    async config(cfg: Config) {
      setCursorShellPath((cfg as Config & { shell?: string }).shell)
      cfg.provider ??= {}
      const models = await loadModels()
      const existing = cfg.provider[CURSOR_PROVIDER_ID]
      if (existing) {
        // Provider already declared (e.g. README stub with models: {}) —
        // still inject the cached model list when the user hasn't filled it in.
        const existingModels = (existing as { models?: Record<string, unknown> }).models
        if (!existingModels || Object.keys(existingModels).length === 0) {
          ;(existing as { models: Record<string, unknown> }).models = models
        }
        return
      }
      cfg.provider[CURSOR_PROVIDER_ID] = {
        name: "Cursor Integration",
        npm: MODULE_URL,
        models,
      }
    },

    auth: {
      provider: CURSOR_PROVIDER_ID,
      methods: [
        {
          type: "oauth",
          label: "Cursor account (browser login)",
          async authorize(): Promise<AuthOAuthResult> {
            const params = generatePkceParams()
            const challenge = await generatePkceChallenge(params.verifier)
            const websiteUrl = process.env.CURSOR_WEBSITE_URL ?? `https://${CURSOR_WEBSITE_HOST}`
            const apiBaseUrl = process.env.CURSOR_API_BASE_URL ?? `https://${CURSOR_API_HOST}`
            const url = buildLoginUrl(challenge, params.uuid, websiteUrl)

            return {
              url,
              instructions: "Open this URL in a browser to sign in to Cursor",
              method: "auto",
              async callback() {
                const result = await pollForTokens(params.uuid, params.verifier, apiBaseUrl)
                return {
                  type: "success",
                  provider: CURSOR_PROVIDER_ID,
                  access: result.accessToken,
                  refresh: result.refreshToken,
                  expires: decodeJwtExpiryMs(result.accessToken) ?? Date.now(),
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "API key (cursor.com/settings)",
          prompts: [
            {
              type: "text",
              key: "apiKey",
              message: "Cursor API key",
              placeholder: "crsr_...",
              validate(value: string) {
                if (!value.startsWith("crsr_")) return "API key should start with crsr_"
                return undefined
              },
            },
          ],
          async authorize(inputs) {
            const apiKey = inputs?.apiKey
            if (!apiKey) return { type: "failed" }
            try {
              const result = await exchangeApiKey(apiKey, apiBaseURL)
              return {
                type: "success",
                key: result.accessToken,
                provider: CURSOR_PROVIDER_ID,
                // Keep the raw key: Cursor renews an API-key login only by
                // exchanging the key again (its refresh token is never used).
                metadata: { apiKey },
              }
            } catch {
              return { type: "failed" }
            }
          },
        },
      ],
      async loader(getAuth) {
        const readCurrent = () => authForLoader(getAuth as () => Promise<Auth | undefined>)
        const auth = await readCurrent()
        // Model discovery and endpoint warmup need a token: like any request,
        // that renews a due session (or expiring API-key JWT) first.
        const accessToken = auth ? await startupAccessToken(auth, readCurrent) : undefined
        if (accessToken) {
          // Skip when config already filled a fresh cache (avoids a second
          // AvailableModels round-trip + background refresh on cold start).
          const cached = await readCache(cacheDir)
          if (!cached || cached.models.length === 0 || !isCacheFresh(cached)) {
            // Await so an empty/missing cache is written before the loader returns
            // (fire-and-forget often loses the race on short-lived CLI commands).
            await discoverModels(accessToken, cacheDir, { baseURL: apiBaseURL }).catch(() => { /* non-fatal */ })
          }
          // Resolve the region-specific Run stream origin so the first turn
          // does not spend time on GetServerConfig. Best-effort: a failure is
          // surfaced by startSession, which can fail the actual model call with
          // a clear endpoint-resolution error instead of using global fallback.
          await resolveAgentUrl(accessToken, {
            apiBaseURL,
            telemetryEnabled: cursorGetServerConfigTelemetryEnabled(),
          }).catch(() => { /* non-fatal warmup */ })
        }

        // Asked for on every Run open: reads the live credential (so a
        // re-login applies without a restart), renews it when due, persists the
        // renewal. This is how OpenCode's own OAuth providers hand over
        // credentials (codex, xai, copilot: a `fetch` that calls getAuth() per
        // request): no token is placed in the options, which OpenCode serves
        // unredacted from /provider; a function is dropped there.
        const getAccessToken: AccessTokenProvider = async (request) => {
          const current = await readCurrent()
          const token = current
            ? await resolveAccessToken(current, readCurrent, request?.forceRefresh === true)
            : undefined
          if (!token) throw new CursorAuthError("No Cursor login found; sign in to Cursor", { code: "no_credential" })
          return token
        }

        return {
          getAccessToken,
          workspaceRoot: input.directory,
          cacheDir,
        }
      },
    },
  }
}
