import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { trace } from "../debug.js"

export type HostPathEnv = NodeJS.ProcessEnv

/** Structural host-path capability installed before an unchanged provider loads. */
export const HOST_PATH_BRIDGE = Symbol.for("opencode.host.path-bridge")
export type OpenCodePathBridge = {
  projectConfigDirs: (workspaceRoot: string) => string[]
  globalConfigDirs: () => string[]
  /** Optional host-owned durable data root; absent means native OpenCode defaults. */
  globalDataDir?: () => string
  /** Optional host-owned cache root; absent means native OpenCode defaults. */
  globalCacheDir?: () => string
  configFileNames?: string[]
  /**
   * Optional host plan file for a session (the host's own plan location, which
   * its `plan_exit` review reads). Absent on an installed bridge means the host
   * defines none; without a bridge OpenCode's own location applies.
   */
  planFile?: (input: { worktree: string; vcs: boolean; created: number; slug: string }) => string | undefined
}

function pathBridge(): OpenCodePathBridge | undefined {
  const value = (globalThis as Record<PropertyKey, unknown>)[HOST_PATH_BRIDGE]
  if (!value || typeof value !== "object") return undefined
  const bridge = value as Partial<OpenCodePathBridge>
  return typeof bridge.projectConfigDirs === "function" && typeof bridge.globalConfigDirs === "function"
    ? bridge as OpenCodePathBridge
    : undefined
}

function openCodeGlobalDataDir(env: HostPathEnv = process.env): string {
  if (env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0) {
    return path.join(env.XDG_DATA_HOME, "opencode")
  }
  return path.join(resolveHome(env), ".local", "share", "opencode")
}

function openCodeGlobalCacheDir(env: HostPathEnv = process.env): string {
  return path.join(xdgCacheHome(env), "opencode")
}

function bridgeGlobalDataDir(): string | undefined {
  const value = pathBridge()?.globalDataDir?.()
  return typeof value === "string" && value.length > 0 ? path.resolve(value) : undefined
}

/**
 * The plan file of a session: OpenCode's own `Session.plan` location
 * (`<worktree>/.opencode/plans` in a VCS project, else `<data>/plans`, named
 * `<created>-<slug>.md`), which its plan agent and `plan_exit` use. An injected
 * host path bridge owns host paths, so with one installed only its `planFile`
 * defines the location.
 */
export function hostPlanFilePath(
  input: { worktree: string; vcs: boolean; created: number; slug: string },
  env: HostPathEnv = process.env,
): string | undefined {
  const bridge = pathBridge()
  if (bridge) {
    if (typeof bridge.planFile !== "function") return undefined
    const value = bridge.planFile(input)
    return typeof value === "string" && value.length > 0 ? path.resolve(value) : undefined
  }
  const slug = input.slug.trim()
  if (!slug || slug.includes("/") || slug.includes("\\") || slug.startsWith(".")) return undefined
  if (!Number.isSafeInteger(input.created) || input.created <= 0) return undefined
  const base = input.vcs
    ? path.join(path.resolve(input.worktree), ".opencode", "plans")
    : path.join(openCodeGlobalDataDir(env), "plans")
  return path.join(base, `${input.created}-${slug}.md`)
}

function bridgeGlobalCacheDir(): string | undefined {
  const value = pathBridge()?.globalCacheDir?.()
  return typeof value === "string" && value.length > 0 ? path.resolve(value) : undefined
}

export function opencodeProjectConfigDirs(workspaceRoot: string): string[] {
  return pathBridge()?.projectConfigDirs(path.resolve(workspaceRoot)) ?? [
    path.join(path.resolve(workspaceRoot), ".opencode"),
  ]
}

export function opencodeGlobalConfigDirs(): string[] {
  return pathBridge()?.globalConfigDirs() ?? [opencodeGlobalConfigDir()]
}

export function opencodeConfigFileNames(): string[] {
  return pathBridge()?.configFileNames?.length
    ? [...pathBridge()!.configFileNames!]
    : ["opencode.json", "opencode.jsonc"]
}


/** Explicit host cache root (e.g. Effect v2 `Path.cache`, or `createCursor({ cacheDir })`). */
let hostCacheDirOverride: string | undefined

function resolveHome(env: HostPathEnv = process.env): string {
  return env.HOME || env.USERPROFILE || homedir()
}

function xdgCacheHome(env: HostPathEnv = process.env): string {
  if (env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0) return env.XDG_CACHE_HOME
  return path.join(resolveHome(env), ".cache")
}

/**
 * Pin the process-wide cache root. Highest precedence for {@link opencodeGlobalCacheDir}.
 * Use for host-injected `Path.cache` or an explicit `createCursor({ cacheDir })`.
 */
export function setHostCacheDirOverride(dir: string | undefined): void {
  hostCacheDirOverride = dir && dir.length > 0 ? path.resolve(dir) : undefined
}

export function getHostCacheDirOverride(): string | undefined {
  return hostCacheDirOverride
}

/** Resolve the native OpenCode cache root when no host bridge is installed. */
export function resolveHostCacheDir(env: HostPathEnv = process.env): string {
  return bridgeGlobalCacheDir() ?? openCodeGlobalCacheDir(env)
}

function xdgConfigHome(env: HostPathEnv = process.env): string {
  if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0) return env.XDG_CONFIG_HOME
  return path.join(resolveHome(env), ".config")
}

/**
 * Native OpenCode global config dir: `$XDG_CONFIG_HOME/opencode`, otherwise
 * `~/.config/opencode` — OpenCode's `Global.Path.config` (`xdg-basedir`
 * `xdgConfig`, `packages/core/src/global.ts`), the same in 1.x and 2.0.
 */
export function opencodeGlobalConfigDir(env: HostPathEnv = process.env): string {
  return path.join(xdgConfigHome(env), "opencode")
}

/**
 * Host global cache dir for Cursor project metadata + model/version caches.
 *
 * Precedence:
 * 1. {@link setHostCacheDirOverride} / `createCursor({ cacheDir })` (host `Path.cache`)
 * 2. An injected structural host path bridge
 * 3. Native OpenCode XDG defaults ({@link resolveHostCacheDir})
 */
export function opencodeGlobalCacheDir(): string {
  if (hostCacheDirOverride) return hostCacheDirOverride
  return resolveHostCacheDir()
}

/** Native OpenCode global data root. */
export function opencodeGlobalDataDir(env: HostPathEnv = process.env): string {
  return openCodeGlobalDataDir(env)
}

/** Host-portable durable data root; falls back to native OpenCode. */
export function hostGlobalDataDir(env: HostPathEnv = process.env): string {
  return bridgeGlobalDataDir() ?? openCodeGlobalDataDir(env)
}

/** Entrypoint plan directories, newest last (see {@link setNativePlansDir}). */
const nativePlansDirs: Array<{ dir: string }> = []

/**
 * Select the entrypoint's native OpenCode plan directory. OpenCode 2.0 sets its
 * Plan directory ({@link opencode2PlanDir}); OpenCode 1.x keeps the default.
 * The returned disposer removes only this selection, so an older plugin setup
 * disposed after a newer one leaves the newer selection in place. `undefined`
 * removes all.
 */
export function setNativePlansDir(dir: string | undefined): () => void {
  if (!dir) {
    nativePlansDirs.length = 0
    return () => {}
  }
  const entry = { dir: path.resolve(dir) }
  nativePlansDirs.push(entry)
  return () => {
    const index = nativePlansDirs.lastIndexOf(entry)
    if (index >= 0) nativePlansDirs.splice(index, 1)
  }
}

/**
 * OpenCode 2.0's Plan directory: `<home>/.opencode/plan`, where its Plan agent
 * may write plan files (home is `OPENCODE_TEST_HOME`, else the OS home).
 */
export function opencode2PlanDir(env: HostPathEnv = process.env): string {
  return path.join(env.OPENCODE_TEST_HOME ?? homedir(), ".opencode", "plan")
}

/**
 * Directory for a new plan file when the session's own plan file
 * ({@link hostPlanFilePath}) is not known.
 *
 * An injected host path bridge owns host paths: `<globalDataDir()>/plans`.
 * Otherwise the native OpenCode location of the running entrypoint: OpenCode
 * 2.0's Plan directory, or OpenCode 1.x's no-VCS `Session.plan` base
 * (`<data>/plans`).
 */
export function hostPlansDir(_workspaceRoot?: string, env: HostPathEnv = process.env): string {
  const bridged = bridgeGlobalDataDir()
  if (bridged) return path.join(bridged, "plans")
  return nativePlansDirs[nativePlansDirs.length - 1]?.dir ?? path.join(openCodeGlobalDataDir(env), "plans")
}

/**
 * Cursor-compatible path slug (`/workspace/a/b` → `workspace-a-b`).
 * Used for per-workspace metadata under the host cache.
 */
export function slugifyWorkspacePath(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot)
  return resolved
    .replace(/[^a-zA-Z0-9]/g, "-")
    .split("-")
    .filter(Boolean)
    .join("-")
}

/**
 * Cursor-style project metadata root for a workspace.
 * Lives at `<host-cache>/projects/<slug>/` under the resolved OpenCode/host cache root.
 *
 * This is what Cursor's RequestContextEnv.project_folder / MCP
 * workspace_project_dir point at — agent-tools, terminals, transcripts, etc.
 * Must NOT be the git workspace, or those dumps land in the repo.
 */
export function opencodeProjectDir(workspaceRoot: string): string {
  const projectsRoot = path.join(opencodeGlobalCacheDir(), "projects")
  const slug = slugifyWorkspacePath(workspaceRoot)
  let dir = path.join(projectsRoot, slug)
  // Mirror Cursor's long-path guard so nested agent-tools paths stay usable.
  if (dir.length > 92) {
    const hash = createHash("sha256").update(dir).digest("hex").slice(0, 7)
    dir = `${dir.slice(0, Math.min(84, dir.length))}-${hash}`
  }
  return dir
}

/** Ensure {@link opencodeProjectDir} exists (mode 0o700) and return it. */
export function ensureOpencodeProjectDir(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot)
  const dir = opencodeProjectDir(resolved)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  trace(
    `project-dir: workspace=${resolved} slug=${slugifyWorkspacePath(resolved)} ` +
      `dir=${dir} cache_root=${opencodeGlobalCacheDir()} ` +
      `override=${hostCacheDirOverride ?? "(none)"} ` +
      `xdg_cache_home=${process.env.XDG_CACHE_HOME ?? "(unset)"}`,
  )
  return dir
}
