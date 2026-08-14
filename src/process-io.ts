/* v8 ignore file -- built-process and PTY acceptance exercise readline, EOF, signals, and process streams. */

/**
 * Node readline adapter for the interactive CLI's process streams.
 * @module dsh-chat-cli/process-io
 */

import { createInterface } from 'node:readline/promises'
import type { Interface as ReadlineInterface } from 'node:readline/promises'

/** Terminal operations consumed by the session driver. */
export interface ChatIo {
  readLine(prompt: string, signal?: AbortSignal): Promise<string | undefined>
  write(text: string): void
  writeError(text: string): void
  onInterrupt(callback: () => void): () => void
  close(): void
}

/** Minimal readable stream fields needed by readline. */
export interface InputStream extends NodeJS.ReadableStream {
  isTTY?: boolean
}

/** Minimal writable stream fields needed by readline. */
export interface OutputStream extends NodeJS.WritableStream {
  isTTY?: boolean
}

/** A readline-backed adapter that keeps prompts out of redirected output. */
class ProcessChatIo implements ChatIo {
  private readonly readline: ReadlineInterface
  private readonly interruptCallbacks = new Set<() => void>()
  private readonly closed: Promise<undefined>
  private didClose = false

  constructor(
    private readonly input: InputStream,
    private readonly output: OutputStream,
    private readonly error: OutputStream,
  ) {
    this.readline = createInterface({ input, output, terminal: input.isTTY === true && output.isTTY === true })
    this.closed = new Promise((resolve) => {
      this.readline.once('close', () => {
        this.didClose = true
        resolve(undefined)
      })
    })
    this.readline.on('SIGINT', () => {
      for (const callback of this.interruptCallbacks) {
        try {
          callback()
        } catch (cause: unknown) {
          this.writeError(`dsh: interrupt handler failed: ${cause instanceof Error ? cause.message : String(cause)}\n`)
        }
      }
    })
  }

  async readLine(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
    const aborted = (): boolean => signal?.aborted === true
    if (this.didClose || aborted()) return undefined
    if (this.input.isTTY === true && this.output.isTTY === true) this.write(prompt)
    try {
      return await Promise.race([
        this.readline.question('', { signal }),
        this.closed,
      ])
    } catch (cause: unknown) {
      if (this.didClose || aborted()
        || (typeof cause === 'object' && cause !== null && 'name' in cause
          && (cause as { name?: unknown }).name === 'AbortError')) return undefined
      throw cause
    }
  }

  write(text: string): void {
    this.output.write(text)
  }

  writeError(text: string): void {
    this.error.write(text)
  }

  onInterrupt(callback: () => void): () => void {
    this.interruptCallbacks.add(callback)
    return () => { this.interruptCallbacks.delete(callback) }
  }

  close(): void {
    if (!this.didClose) this.readline.close()
  }
}

/**
 * Create one process-stream terminal adapter.
 * @param input - process input or a test stream.
 * @param output - ordinary CLI output.
 * @param error - diagnostics output.
 * @returns a line-oriented terminal adapter.
 */
export function createProcessIo(input: InputStream, output: OutputStream, error: OutputStream): ChatIo {
  return new ProcessChatIo(input, output, error)
}
