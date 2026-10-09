import type { BidiStream } from "./transport/connect.js"
import { trace } from "./debug.js"
import { CursorTransportError, toCursorProviderError } from "./errors.js"

/**
 * `write()` returned false (bytes already buffered) and the later drain failed
 * or was unavailable. Callers must not replay that frame.
 */
export class StreamWriteDrainError extends CursorTransportError {
  readonly accepted = true

  constructor(message: string, cause?: unknown) {
    super(message, {
      transient: false,
      replaySafe: false,
      code: "CURSOR_WRITE_BACKPRESSURE",
      cause,
    })
    this.name = "StreamWriteDrainError"
  }
}

const streamWriteChains = new WeakMap<BidiStream, Promise<void>>()

export async function waitForStreamWrites(stream: BidiStream): Promise<void> {
  const pending = streamWriteChains.get(stream)
  if (pending) await pending.catch(() => undefined)
}

/**
 * Keep awaited protocol writes ordered per Run stream. A large reply must
 * drain before another reply or heartbeat is queued; otherwise one writer
 * observes the backlog created by ignored `false` write() results.
 */
export async function writeStreamMessage(
  stream: BidiStream,
  message: Uint8Array,
  operation: string,
): Promise<void> {
  const previous = streamWriteChains.get(stream)
  const current = (previous ? previous.catch(() => undefined) : Promise.resolve())
    .then(() => writeStreamMessageNow(stream, message, operation))
  streamWriteChains.set(stream, current)
  try {
    await current
  } finally {
    if (streamWriteChains.get(stream) === current) streamWriteChains.delete(stream)
  }
}

async function writeStreamMessageNow(
  stream: BidiStream,
  message: Uint8Array,
  operation: string,
): Promise<void> {
  let accepted: boolean | void
  try {
    accepted = stream.write(message)
  } catch (cause) {
    throw toCursorProviderError(cause, {
      replaySafe: false,
      fallback: `Cursor ${operation} write failed`,
    })
  }
  if (accepted !== false) return
  trace(`stream write backpressured: operation=${operation} bytes=${message.length}`)
  if (!stream.waitForDrain) {
    throw new StreamWriteDrainError(`Cursor ${operation} write was backpressured`)
  }
  try {
    await stream.waitForDrain(5_000)
    trace(`stream write drained: operation=${operation} bytes=${message.length}`)
  } catch (cause) {
    throw new StreamWriteDrainError(
      `Cursor ${operation} backpressure drain failed`,
      cause,
    )
  }
}
