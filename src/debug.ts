import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { processShared } from "./process-shared.js"

// Wire-level diagnostics. Opt in with CURSOR_PROVIDER_DEBUG=1 (or "true").
// Default path mirrors Cursor CLI: $TMPDIR/cursor-provider-logs-<uid>/debug-<pid>.log
// with directory mode 0o700 and file mode 0o600. Override with CURSOR_PROVIDER_DEBUG_FILE.
// First init in a fresh file writes a header; later inits (module reload / second
// isolate sharing CURSOR_PROVIDER_DEBUG_FILE) append another header instead of
// wiping earlier EMITTED lines. Operators who want a clean run should truncate
// the override path before starting the host. Independently, when the file reaches
// its size cap (DEBUG_LOG_MAX_BYTES, or CURSOR_PROVIDER_DEBUG_MAX_BYTES) it is
// renamed to `<file>.1`, replacing an older one, and a fresh file starts with a
// new header, so the log stays bounded at about twice the cap. Tokens /
// checksums: redact in callers.
const DEBUG_ENABLED =
  process.env.CURSOR_PROVIDER_DEBUG === "1" ||
  process.env.CURSOR_PROVIDER_DEBUG === "true"

/** Default soft cap for the debug log file; reaching it rotates the file to `<file>.1`. */
export const DEBUG_LOG_MAX_BYTES = 10 * 1024 * 1024

/** `CURSOR_PROVIDER_DEBUG_MAX_BYTES` as a positive integer byte count, else the default cap. */
export function resolveDebugLogMaxBytes(
  value: string | undefined = process.env.CURSOR_PROVIDER_DEBUG_MAX_BYTES,
): number {
  const trimmed = value?.trim() ?? ""
  if (!/^\d+$/.test(trimmed)) return DEBUG_LOG_MAX_BYTES
  const bytes = Number(trimmed)
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : DEBUG_LOG_MAX_BYTES
}

// A host can load this package more than once in one process (a plugin and an
// AI SDK package import, or one plugin import per location). Count the copies so
// each banner names its copy and, once there are several, every line says which.
const moduleCopies = processShared("debug.module-copies.v1", () => ({ count: 0 }))
const MODULE_COPY = ++moduleCopies.count

let _traceInitialized = false
let _debugFile: string | undefined
let _debugFileUsesManagedDirectory = false
let _debugLogMaxBytes = DEBUG_LOG_MAX_BYTES
let _announcedLogPath = false

/** Message of an unknown thrown value, for log lines and error text. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether `CURSOR_PROVIDER_DEBUG` is enabled for this process. */
export function isDebugEnabled(): boolean {
  return DEBUG_ENABLED
}

/** Resolve the debug log path (env override or per-uid tmpdir default). */
export function resolveDebugLogPath(): string {
  if (process.env.CURSOR_PROVIDER_DEBUG_FILE) {
    return process.env.CURSOR_PROVIDER_DEBUG_FILE
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : process.pid
  return path.join(os.tmpdir(), `cursor-provider-logs-${uid}`, `debug-${process.pid}.log`)
}

/**
 * Ensure the log directory is 0o700 and the log file exists as 0o600.
 * Does **not** truncate an existing file — mid-run re-init must keep prior lines.
 * Exported for tests; callers normally go through `trace`.
 */
export function ensureSecureDebugLog(
  filePath: string,
  options: { secureParent?: boolean } = {},
): void {
  const dir = path.dirname(filePath)
  const secureParent = options.secureParent ?? true
  fs.mkdirSync(dir, secureParent
    ? { recursive: true, mode: 0o700 }
    : { recursive: true })
  if (secureParent) {
    const stat = fs.lstatSync(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Debug log directory is not a real directory: ${dir}`)
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`Debug log directory is not owned by the current user: ${dir}`)
    }
    fs.chmodSync(dir, 0o700)
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "", { mode: 0o600 })
  }
  fs.chmodSync(filePath, 0o600)
}

function announceLogPath(filePath: string): void {
  if (_announcedLogPath) return
  _announcedLogPath = true
  try {
    // Visible in the OpenCode / terminal session so operators know where to look.
    console.error(`[cursor-provider] CURSOR_PROVIDER_DEBUG logging to ${filePath}`)
  } catch {
    /* ignore */
  }
}

function debugBannerLine(): string {
  return `--- cursor-provider debug (pid ${process.pid}) ${new Date().toISOString()} ` +
    `copy=#${MODULE_COPY} module=${import.meta.url} ---\n`
}

/** `#N` on each line once a second copy of this module exists in the process. */
function copyTag(): string {
  return moduleCopies.count > 1 ? `#${MODULE_COPY} ` : ""
}

/** Move a regular log file to `previous`; false when it is not one or cannot be moved. */
function moveDebugLogAside(filePath: string, previous: string): boolean {
  try {
    if (!fs.lstatSync(filePath).isFile()) return false
    fs.chmodSync(filePath, 0o600)
    // rename replaces whatever `previous` is (even a symlink) without following it.
    fs.renameSync(filePath, previous)
    return true
  } catch {
    return false
  }
}

/**
 * If `filePath` is at least `maxBytes`, move it to `<filePath>.1` (replacing an
 * older one) and start a fresh file with a size-cap header. A path that is not a
 * regular file, or cannot be moved, is truncated in place instead. Returns true
 * when the cap was applied. Exported for tests.
 */
export function rotateDebugLogIfOversized(
  filePath: string,
  maxBytes: number = DEBUG_LOG_MAX_BYTES,
): boolean {
  if (!fs.existsSync(filePath)) return false
  const size = fs.statSync(filePath).size
  if (size < maxBytes) return false
  const previous = `${filePath}.1`
  const action = moveDebugLogAside(filePath, previous)
    ? `rotate previous=${previous}`
    : "truncate"
  fs.writeFileSync(
    filePath,
    debugBannerLine() +
      `[${new Date().toISOString()}] debug: size-cap ${action} file=${filePath} ` +
      `wasBytes=${size} maxBytes=${maxBytes}\n`,
    { mode: 0o600 },
  )
  fs.chmodSync(filePath, 0o600)
  return true
}

export function trace(msg: string): void {
  if (!DEBUG_ENABLED) return
  try {
    if (!_debugFile) {
      _debugFileUsesManagedDirectory = !process.env.CURSOR_PROVIDER_DEBUG_FILE
      _debugFile = resolveDebugLogPath()
      _debugLogMaxBytes = resolveDebugLogMaxBytes()
    }
    if (!_traceInitialized) {
      ensureSecureDebugLog(_debugFile, { secureParent: _debugFileUsesManagedDirectory })
      // Rotate oversized leftovers from a prior run before appending a reinit banner.
      rotateDebugLogIfOversized(_debugFile, _debugLogMaxBytes)
      const banner = debugBannerLine()
      const preexisting =
        fs.existsSync(_debugFile) && fs.statSync(_debugFile).size > 0
      if (preexisting) {
        fs.appendFileSync(_debugFile, banner)
      } else {
        fs.writeFileSync(_debugFile, banner, { mode: 0o600 })
      }
      _traceInitialized = true
      announceLogPath(_debugFile)
      fs.appendFileSync(
        _debugFile,
        `[${new Date().toISOString()}] debug: enabled file=${_debugFile} ` +
          `xdg_cache_home=${process.env.XDG_CACHE_HOME ?? "(unset)"} ` +
          `cwd=${process.cwd()}` +
          (preexisting ? " reinit=append" : "") +
          `\n`,
      )
    }
    rotateDebugLogIfOversized(_debugFile, _debugLogMaxBytes)
    fs.appendFileSync(_debugFile, `[${new Date().toISOString()}] ${copyTag()}${msg}\n`)
  } catch {
    /* ignore */
  }
}

/**
 * Compact path-advertising summary for RequestContext troubleshooting.
 * Safe: no tokens / file contents — only workspace vs metadata roots.
 */
export function traceRequestContextPaths(
  label: string,
  requestContext: Record<string, unknown> | undefined,
): void {
  if (!DEBUG_ENABLED) return
  const env =
    requestContext?.env && typeof requestContext.env === "object"
      ? (requestContext.env as Record<string, unknown>)
      : undefined
  const mcp =
    requestContext?.mcp_file_system_options &&
    typeof requestContext.mcp_file_system_options === "object"
      ? (requestContext.mcp_file_system_options as Record<string, unknown>)
      : undefined
  trace(
    `${label}: workspace_paths=${JSON.stringify(env?.workspace_paths ?? null)} ` +
      `process_working_directory=${JSON.stringify(env?.process_working_directory ?? null)} ` +
      `project_folder=${JSON.stringify(env?.project_folder ?? null)} ` +
      `terminals_folder=${JSON.stringify(env?.terminals_folder ?? null)} ` +
      `agent_transcripts_folder=${JSON.stringify(env?.agent_transcripts_folder ?? null)} ` +
      `workspace_project_dir=${JSON.stringify(mcp?.workspace_project_dir ?? null)}`,
  )
}