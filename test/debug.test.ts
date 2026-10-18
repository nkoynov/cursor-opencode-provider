import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  DEBUG_LOG_MAX_BYTES,
  ensureSecureDebugLog,
  resolveDebugLogPath,
  truncateDebugLogIfOversized,
} from "../src/debug.js"

const originalDebugFile = process.env.CURSOR_PROVIDER_DEBUG_FILE

afterEach(() => {
  if (originalDebugFile === undefined) delete process.env.CURSOR_PROVIDER_DEBUG_FILE
  else process.env.CURSOR_PROVIDER_DEBUG_FILE = originalDebugFile
})

describe("debug log paths / modes (F9)", () => {
  it("defaults under per-uid cursor-provider-logs dir", () => {
    delete process.env.CURSOR_PROVIDER_DEBUG_FILE
    const uid = typeof process.getuid === "function" ? process.getuid() : process.pid
    const resolved = resolveDebugLogPath()
    expect(resolved).toBe(
      path.join(os.tmpdir(), `cursor-provider-logs-${uid}`, `debug-${process.pid}.log`),
    )
  })

  it("honors CURSOR_PROVIDER_DEBUG_FILE override", () => {
    process.env.CURSOR_PROVIDER_DEBUG_FILE = "/tmp/custom-cursor-provider.debug"
    expect(resolveDebugLogPath()).toBe("/tmp/custom-cursor-provider.debug")
  })

  it("creates per-user dir 0o700 and log file 0o600", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-provider-debug-test-"))
    const dir = path.join(root, "cursor-provider-logs-test")
    const file = path.join(dir, "debug.log")
    try {
      ensureSecureDebugLog(file)
      const dirMode = fs.statSync(dir).mode & 0o777
      const fileMode = fs.statSync(file).mode & 0o777
      expect(dirMode).toBe(0o700)
      expect(fileMode).toBe(0o600)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("does not change permissions on an override path's parent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-provider-debug-override-test-"))
    const file = path.join(root, "debug.log")
    try {
      fs.chmodSync(root, 0o755)
      ensureSecureDebugLog(file, { secureParent: false })
      expect(fs.statSync(root).mode & 0o777).toBe(0o755)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects a symlink in place of the managed debug directory", () => {
    if (process.platform === "win32") return
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-provider-debug-symlink-test-"))
    const target = path.join(root, "target")
    const linkedDir = path.join(root, "managed")
    try {
      fs.mkdirSync(target)
      fs.symlinkSync(target, linkedDir)
      expect(() => ensureSecureDebugLog(path.join(linkedDir, "debug.log"))).toThrow(
        "not a real directory",
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("does not wipe an existing log on ensureSecureDebugLog", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-provider-debug-preserve-"))
    const file = path.join(root, "debug.log")
    try {
      fs.writeFileSync(file, "prior EMITTED tool-call\n", { mode: 0o600 })
      ensureSecureDebugLog(file, { secureParent: false })
      expect(fs.readFileSync(file, "utf8")).toBe("prior EMITTED tool-call\n")
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("exports a 10 MiB size cap", () => {
    expect(DEBUG_LOG_MAX_BYTES).toBe(10 * 1024 * 1024)
  })

  it("leaves undersized logs alone", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-provider-debug-cap-under-"))
    const file = path.join(root, "debug.log")
    try {
      fs.writeFileSync(file, "keep me\n", { mode: 0o600 })
      expect(truncateDebugLogIfOversized(file, 1024)).toBe(false)
      expect(fs.readFileSync(file, "utf8")).toBe("keep me\n")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("truncates when the log reaches the size cap", () => {
    // The truncation notice includes the path; it may itself contain old log bytes.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-provider-debug-cap-over-xxxxx-"))
    const file = path.join(root, "debug.log")
    try {
      fs.writeFileSync(file, "x".repeat(64), { mode: 0o600 })
      expect(truncateDebugLogIfOversized(file, 32)).toBe(true)
      const body = fs.readFileSync(file, "utf8")
      expect(body).toContain("--- cursor-provider debug (pid ")
      expect(body).toContain("debug: size-cap truncate")
      expect(body).toContain("wasBytes=64")
      expect(body).toContain("maxBytes=32")
      expect(body.split("\n").slice(2).join("\n")).toBe("")
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
