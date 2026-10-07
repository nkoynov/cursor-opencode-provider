import { createSdk } from "./plugin-core.js"
import { CursorPlugin } from "./plugin.js"
import type { CursorContinuationOptions } from "./session.js"
import type { HostToolDialect } from "./protocol/tools.js"
import type { AccessTokenProvider } from "./auth-renewal.js"

export type CursorRetryOptions = {
  /** Total attempts including the initial request. Default: 3, or 6 when Cursor refuses the Run for capacity; set, it caps both. */
  maxAttempts?: number
  /** Initial full-jitter backoff ceiling; capacity refusals start at four times this. Default: 500ms. */
  baseDelayMs?: number
  /** Exponential backoff ceiling. Default: 8000ms. */
  maxDelayMs?: number
}

export type CreateCursorOptions = {
  name: string
  /**
   * Current Cursor access token, asked for every time a Run opens. Takes
   * precedence over `accessToken` and `apiKey`; hosts use it to renew the
   * login without exposing a secret in serializable options. `forceRefresh`
   * is set once after Cursor rejected the previous token.
   */
  getAccessToken?: AccessTokenProvider
  /** Access token sent as-is (no renewal). Used when `getAccessToken` is absent. */
  accessToken?: string
  /** Raw `crsr_` API key, exchanged and renewed. Used only when neither of the above is given. */
  apiKey?: string
  /** API base for auth, model discovery, and GetServerConfig. */
  apiBaseURL?: string
  /** Explicit Cursor agent Run host override. */
  agentBaseURL?: string
  /** @deprecated Use agentBaseURL. Kept as the legacy agent Run host override. */
  baseURL?: string
  headers?: Record<string, string>
  /** Opt in to telemetry on the GetServerConfig endpoint lookup. Defaults to false. */
  telemetryEnabled?: boolean
  /** OpenCode project / worktree directory for request_context collectors. */
  workspaceRoot?: string
  /**
   * Host cache root for Cursor project metadata + model/version caches.
   * Prefer the host's Path.cache (Effect v2) when available; otherwise the
   * provider resolves the native OpenCode cache dir, or an injected host path bridge.
   */
  cacheDir?: string
  /** Held-stream policy. Defaults: heartbeat 5s, semantic idle 120s, tool inactivity 10m. */
  continuation?: CursorContinuationOptions
  /** Fresh-turn retry policy. Defaults: 3 attempts, 500ms base, 8000ms cap. */
  retry?: CursorRetryOptions
  /** Fallback host dialect when schemas are omitted or ambiguous. Default: OpenCode 1.x. */
  defaultDialect?: HostToolDialect
}

export function createCursor(options: CreateCursorOptions) {
  return createSdk(options)
}

export { CursorPlugin }
export type { CursorContinuationOptions, CursorContinuationPolicy } from "./session.js"
export default CursorPlugin

// Keep root runtime exports plugin-safe. OpenCode's legacy plugin loader
// treats package-root exports as potential plugins, so extra public runtime
// APIs belong on subpaths such as "cursor-opencode-provider/errors".
//
// CursorPluginV2 is NOT re-exported here — see plugin-v2.ts.
// OpenCode's legacy plugin loader (getLegacyPlugins) iterates all exports
// and calls getServerPlugin on each; the v2 define() return is not a
// function, causing "Plugin export is not a function". Load it via
// the separate "cursor-opencode-provider/plugin/v2" export path.
