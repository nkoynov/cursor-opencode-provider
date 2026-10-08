import { describe, expect, it } from "bun:test"
import type { BidiStream } from "../src/transport/connect.js"
import { CursorProviderError } from "../src/errors.js"
import { StreamWriteDrainError, waitForStreamWrites, writeStreamMessage } from "../src/stream-write.js"

type FakeStream = BidiStream & { written: number[] }

function stream(options: {
  write?: (message: Uint8Array) => boolean | void
  waitForDrain?: ((timeoutMs: number) => Promise<void>) | null
} = {}): FakeStream {
  const written: number[] = []
  const fake = {
    written,
    write(message: Uint8Array) {
      written.push(message[0]!)
      return options.write ? options.write(message) : true
    },
    ...(options.waitForDrain === null ? {} : { waitForDrain: options.waitForDrain ?? (async () => {}) }),
  }
  return fake as unknown as FakeStream
}

const frame = (id: number) => Uint8Array.of(id)

describe("writeStreamMessage", () => {
  it("returns once an accepted write is buffered", async () => {
    const s = stream()
    await writeStreamMessage(s, frame(1), "test")
    expect(s.written).toEqual([1])
  })

  it("waits for drain after a backpressured write and keeps later writes behind it", async () => {
    const drains: Array<() => void> = []
    const s = stream({
      write: (message) => message[0] !== 1,
      waitForDrain: () => new Promise<void>((resolve) => { drains.push(resolve) }),
    })
    let firstDone = false
    const first = writeStreamMessage(s, frame(1), "first").then(() => { firstDone = true })
    const second = writeStreamMessage(s, frame(2), "second")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(s.written).toEqual([1])
    expect(firstDone).toBe(false)
    drains[0]!()
    await Promise.all([first, second])
    expect(s.written).toEqual([1, 2])
  })

  it("reports a write that throws as a non-replayable provider error, not a buffered one", async () => {
    const s = stream({ write: () => { throw new Error("stream destroyed") } })
    const error = await writeStreamMessage(s, frame(1), "test").catch((e) => e)

    expect(error).toBeInstanceOf(CursorProviderError)
    expect(error).not.toBeInstanceOf(StreamWriteDrainError)
    expect(error.replaySafe).toBe(false)
  })

  it("treats backpressure without a drain hook as a buffered, non-replayable write", async () => {
    const s = stream({ write: () => false, waitForDrain: null })
    const error = await writeStreamMessage(s, frame(1), "test").catch((e) => e)

    expect(error).toBeInstanceOf(StreamWriteDrainError)
    expect(error.accepted).toBe(true)
    expect(error.replaySafe).toBe(false)
    expect(error.code).toBe("CURSOR_WRITE_BACKPRESSURE")
  })

  it("keeps the cause when a drain fails after the write was buffered", async () => {
    const cause = new Error("drain timeout")
    const s = stream({ write: () => false, waitForDrain: async () => { throw cause } })
    const error = await writeStreamMessage(s, frame(1), "test").catch((e) => e)

    expect(error).toBeInstanceOf(StreamWriteDrainError)
    expect(error.cause).toBe(cause)
  })

  it("does not let a failed write block the next one", async () => {
    const s = stream({ write: (message) => { if (message[0] === 1) throw new Error("boom") } })
    const failed = writeStreamMessage(s, frame(1), "first").catch(() => "failed")
    await writeStreamMessage(s, frame(2), "second")

    expect(await failed).toBe("failed")
    expect(s.written).toEqual([1, 2])
  })
})

describe("waitForStreamWrites", () => {
  it("returns at once when nothing is in flight", async () => {
    await waitForStreamWrites(stream())
  })

  it("waits for in-flight writes, including ones that fail", async () => {
    const drains: Array<(error?: Error) => void> = []
    const s = stream({
      write: () => false,
      waitForDrain: () => new Promise<void>((resolve, reject) => {
        drains.push((error) => error ? reject(error) : resolve())
      }),
    })
    const write = writeStreamMessage(s, frame(1), "test").catch(() => "failed")
    let waited = false
    const waiting = waitForStreamWrites(s).then(() => { waited = true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(waited).toBe(false)
    drains[0]!(new Error("closed"))
    await waiting
    expect(waited).toBe(true)
    expect(await write).toBe("failed")
  })
})
