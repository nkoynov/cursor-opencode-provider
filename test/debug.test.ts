import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  DEBUG_LOG_MAX_BYTES,
  ensureSecureDebugLog,
  resolveDebugLogMaxBytes,
  resolveDebugLogPath,
  rotateDebugLogIfOversized,
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
      expect(rotateDebugLogIfOversized(file, 1024)).toBe(false)
      expect(fs.existsSync(`${file}.1`)).toBe(false)
      expect(fs.readFileSync(file, "utf8")).toBe("keep me\n")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("moves the log to <file>.1 when it reaches the size cap", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-provider-debug-cap-over-"))
    const file = path.join(root, "debug.log")
    try {
      fs.writeFileSync(file, "x".repeat(64), { mode: 0o644 })
      expect(rotateDebugLogIfOversized(file, 32)).toBe(true)
      expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("x".repeat(64))
      expect(fs.statSync(`${file}.1`).mode & 0o777).toBe(0o600)
      const body = fs.readFileSync(file, "utf8")
      expect(body).toContain("--- cursor-provider debug (pid ")
      expect(body).toContain(`debug: size-cap rotate previous=${file}.1 file=${file}`)
      expect(body).toContain("wasBytes=64")
      expect(body).toContain("maxBytes=32")
      expect(body).not.toContain("x".repeat(64))
      expect(body.split("\n").slice(2).join("\n")).toBe("")
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("replaces an older <file>.1 on the next rotation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-provider-debug-cap-again-"))
    const file = path.join(root, "debug.log")
    try {
      fs.writeFileSync(file, "a".repeat(64), { mode: 0o600 })
      expect(rotateDebugLogIfOversized(file, 32)).toBe(true)
      fs.appendFileSync(file, "b".repeat(64))
      const secondPart = fs.readFileSync(file, "utf8")
      expect(rotateDebugLogIfOversized(file, 32)).toBe(true)
      expect(fs.readFileSync(`${file}.1`, "utf8")).toBe(secondPart)
      expect(fs.statSync(`${file}.1`).mode & 0o777).toBe(0o600)
      expect(fs.readdirSync(root).sort()).toEqual(["debug.log", "debug.log.1"])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("replaces a symlinked <file>.1 instead of writing through it", () => {
    if (process.platform === "win32") return
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-provider-debug-cap-link-"))
    const file = path.join(root, "debug.log")
    const target = path.join(root, "elsewhere")
    try {
      fs.writeFileSync(target, "untouched\n", { mode: 0o644 })
      fs.symlinkSync(target, `${file}.1`)
      fs.writeFileSync(file, "x".repeat(64), { mode: 0o600 })
      expect(rotateDebugLogIfOversized(file, 32)).toBe(true)
      expect(fs.readFileSync(target, "utf8")).toBe("untouched\n")
      expect(fs.statSync(target).mode & 0o777).toBe(0o644)
      const previous = fs.lstatSync(`${file}.1`)
      expect(previous.isSymbolicLink()).toBe(false)
      expect(previous.mode & 0o777).toBe(0o600)
      expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("x".repeat(64))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("truncates in place when the log cannot be moved aside", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-provider-debug-cap-blocked-"))
    const file = path.join(root, "debug.log")
    try {
      fs.mkdirSync(`${file}.1`)
      fs.writeFileSync(path.join(`${file}.1`, "keep"), "")
      fs.writeFileSync(file, "x".repeat(64), { mode: 0o600 })
      expect(rotateDebugLogIfOversized(file, 32)).toBe(true)
      const body = fs.readFileSync(file, "utf8")
      expect(body).toContain("debug: size-cap truncate file=")
      expect(body).not.toContain("x".repeat(64))
      expect(fs.readdirSync(`${file}.1`)).toEqual(["keep"])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("reads CURSOR_PROVIDER_DEBUG_MAX_BYTES as a positive byte count", () => {
    expect(resolveDebugLogMaxBytes("200000")).toBe(200000)
    expect(resolveDebugLogMaxBytes(" 524288000 ")).toBe(524288000)
    for (const invalid of [undefined, "", "  ", "0", "-5", "1.5", "1e6", "10MiB", "abc", "0x10", "99999999999999999999"]) {
      expect(resolveDebugLogMaxBytes(invalid)).toBe(DEBUG_LOG_MAX_BYTES)
    }
  })

  it("rotates at CURSOR_PROVIDER_DEBUG_MAX_BYTES while tracing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-provider-debug-trace-cap-"))
    const file = path.join(root, "debug.log")
    const script = `
      import { trace } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/debug.ts"))}
      for (let i = 0; i < 100; i++) trace("line " + i + " " + "y".repeat(80))
    `
    const run = (maxBytes: string) => Bun.spawnSync([process.execPath, "-e", script], {
      env: {
        ...process.env,
        CURSOR_PROVIDER_DEBUG: "1",
        CURSOR_PROVIDER_DEBUG_FILE: file,
        CURSOR_PROVIDER_DEBUG_MAX_BYTES: maxBytes,
      },
    })
    try {
      expect(run("4000").exitCode).toBe(0)
      const current = fs.readFileSync(file, "utf8")
      const previous = fs.readFileSync(`${file}.1`, "utf8")
      expect(current).toContain(`debug: size-cap rotate previous=${file}.1`)
      expect(current).toContain("maxBytes=4000")
      expect(current).toContain("line 99 ")
      expect(previous.length).toBeGreaterThanOrEqual(4000)
      expect(previous.length).toBeLessThan(4200)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(fs.statSync(`${file}.1`).mode & 0o777).toBe(0o600)

      fs.rmSync(`${file}.1`)
      fs.writeFileSync(file, "")
      expect(run("not-a-number").exitCode).toBe(0)
      expect(fs.existsSync(`${file}.1`)).toBe(false)
      expect(fs.readFileSync(file, "utf8")).toContain("line 0 ")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
