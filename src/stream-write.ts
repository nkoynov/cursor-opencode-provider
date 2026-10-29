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

const streamWriteChains = new WeakMap<BidiStream, Promise<unknown>>()
/** Streams whose current write is buffered and waiting for `drain`. */
const drainingStreams = new WeakSet<BidiStream>()

/** Streams whose current draining write is one Cursor must receive before it can answer (not a heartbeat). */
const drainingReplies = new WeakSet<BidiStream>()
const lastReplyDrainAt = new WeakMap<BidiStream, number>()
const HEARTBEAT_OPERATION = /^(exec )?heartbeat\b/

/** True while a write on `stream` waits for `drain`; anything written next queues behind it. */
export function isStreamWriteBlocked(stream: BidiStream): boolean {
  return drainingStreams.has(stream)
}

/** True while a non-heartbeat write on `stream` waits for `drain`. */
export function isStreamReplyUploading(stream: BidiStream): boolean {
  return drainingReplies.has(stream)
}

/** When the last backpressured non-heartbeat write on `stream` finished draining. */
export function lastStreamReplyDrainAt(stream: BidiStream): number | undefined {
  return lastReplyDrainAt.get(stream)
}

export async function waitForStreamWrites(stream: BidiStream): Promise<void> {
  const pending = streamWriteChains.get(stream)
  if (pending) await pending.catch(() => undefined)
}

/**
 * Keep awaited protocol writes ordered per Run stream. A large reply must
 * drain before another reply or heartbeat is queued; otherwise one writer
 * observes the backlog created by ignored `false` write() results.
 * `shouldWrite` is asked when the message's turn comes; false skips it.
 */
export async function writeStreamMessage(
  stream: BidiStream,
  message: Uint8Array,
  operation: string,
  shouldWrite?: () => boolean,
): Promise<boolean> {
  const previous = streamWriteChains.get(stream)
  const current = (previous ? previous.catch(() => undefined) : Promise.resolve())
    .then(async () => {
      if (shouldWrite && !shouldWrite()) return false
      await writeStreamMessageNow(stream, message, operation)
      return true
    })
  streamWriteChains.set(stream, current)
  try {
    return await current
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
    accepted = await stream.write(message)
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
  // No deadline: HTTP/2 emits `drain` only once the whole buffered message is
  // out, so a timeout here would cap the upload, not detect a stall. Cursor CLI
  // (connect-node) waits the same way; a closed or idle stream settles it.
  const startedAt = Date.now()
  const reply = !HEARTBEAT_OPERATION.test(operation)
  drainingStreams.add(stream)
  if (reply) drainingReplies.add(stream)
  try {
    await stream.waitForDrain()
    if (reply) lastReplyDrainAt.set(stream, Date.now())
    trace(`stream write drained: operation=${operation} bytes=${message.length} ms=${Date.now() - startedAt}`)
  } catch (cause) {
    throw new StreamWriteDrainError(
      `Cursor ${operation} backpressure drain failed`,
      cause,
    )
  } finally {
    drainingStreams.delete(stream)
    drainingReplies.delete(stream)
  }
}
