/** Pure terminal rendering, structured answers, approval prompts, and process IO construction. */

import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore from '@deepseek-ai/dsh-session'
import { CallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { internals } from '../src/index.ts'

interface CaptureIo {
  output: string
  error: string
  lines: Array<string | undefined | Error>
  prompts: string[]
  readLine(prompt: string, signal?: AbortSignal): Promise<string | undefined>
  write(text: string): void
  writeError(text: string): void
  onInterrupt(callback: () => void): () => void
  close(): void
}

function capture(lines: Array<string | undefined | Error> = []): CaptureIo {
  return {
    output: '', error: '', lines, prompts: [],
    readLine(prompt, signal) {
      this.prompts.push(prompt)
      if (signal?.aborted === true) return Promise.resolve(undefined)
      const next = this.lines.shift()
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
    },
    write(text) { this.output += text },
    writeError(text) { this.error += text },
    onInterrupt: () => () => {},
    close: () => {},
  }
}

const originalInternals = { ...internals }
afterEach(() => { Object.assign(internals, originalInternals) })

function event(type: string, data: unknown, seq = 0): SessionEvent {
  return { type, data, seq, time: seq } as SessionEvent
}

describe('chat presentation', () => {
  it('keeps streamed channels coherent and handles every terminal turn outcome', () => {
    const io = capture()
    const renderer = internals.renderer(io, true)
    renderer.event(event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '' } }))
    renderer.event(event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'A' } }))
    renderer.event(event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'B' } }))
    renderer.event(event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 1, text: 'think' } }))
    renderer.event(event('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'must not duplicate' }],
        source: { provider: 'p', model: 'm' },
      }),
    }))
    renderer.event(event('assistant/message', {
      turn: 2, step: 1,
      message: createAssistantMessage({ content: [], source: { provider: 'p', model: 'm' } }),
    }))
    const callId = CallId('missing-call')
    renderer.event(event('tool/result', {
      turn: 2, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'bad' }], isError: true }),
    }))
    renderer.event(event('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }))
    renderer.event(event('turn/end', { turn: 3, reason: { kind: 'blocked' } }))
    renderer.event(event('turn/end', { turn: 4, reason: { kind: 'max-tokens' } }))
    renderer.event(event('turn/end', { turn: 5, reason: { kind: 'completed' } }))
    renderer.event(event('todo/write', { todos: [] }))
    renderer.finish()
    expect(io.output).toBe('assistant> AB\nreasoning> think\n[tool] unknown failed\n')
    expect(io.error).toBe('dsh: turn cancelled\ndsh: turn blocked\ndsh: model output reached its token limit\n')
  })

  it('suppresses reasoning unless requested and renders an unstreamed message', () => {
    const io = capture()
    const renderer = internals.renderer(io, false)
    renderer.event(event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'hidden' } }))
    renderer.event(event('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'visible' }],
        source: { provider: 'p', model: 'm' },
      }),
    }))
    renderer.finish()
    renderer.finish()
    expect(io.output).toBe('assistant> visible\n')
  })
})

describe('chat questions', () => {
  it('parses option numbers, labels, duplicates, custom values, and empty answers', () => {
    const question = {
      id: 'q', question: 'Pick', multiSelect: true,
      options: [{ label: 'Alpha' }, { label: 'Beta' }],
    }
    expect(internals.parseQuestionAnswer(question, '1, beta, Alpha, 9, custom')).toEqual({
      id: 'q', selected: ['Alpha', 'Beta'], custom: '9, custom',
    })
    expect(internals.parseQuestionAnswer({ id: 'empty', question: 'Say' }, '  ')).toEqual({
      id: 'empty', selected: [],
    })
  })

  it('renders generic and multi-select questions and reports EOF', async () => {
    const io = capture(['custom', undefined])
    const ask = internals.questionQueue(io)
    await expect(internals.askQuestion(io, ask, {
      id: 'q1', question: 'Say something', multiSelect: true,
    })).resolves.toEqual({ id: 'q1', selected: [], custom: 'custom' })
    expect(io.output).toBe('\nQuestion: Say something\n')
    expect(io.prompts).toEqual(['Select one or more (comma-separated): '])
    await expect(internals.askQuestion(io, ask, { id: 'q2', question: 'Again' }))
      .rejects.toThrow('terminal input closed')
  })

  it('serializes questions after a rejected read', async () => {
    const io = capture([new Error('read failed'), 'answer'])
    const ask = internals.questionQueue(io)
    await expect(ask('first')).rejects.toThrow('read failed')
    await expect(ask('second')).resolves.toBe('answer')
  })
})

describe('chat approvals and process errors', () => {
  const request = (signal?: AbortSignal) => ({
    agent: {} as Agent,
    toolName: 'bash',
    ...signal === undefined ? {} : { signal },
  })

  it('accepts yes and rejects EOF or any other answer', async () => {
    await expect(internals.askApproval(() => Promise.resolve('YES'), request())).resolves.toBe('allowed-once')
    await expect(internals.askApproval(() => Promise.resolve(undefined), request())).resolves.toBe('rejected')
    await expect(internals.askApproval(() => Promise.resolve('no'), request())).resolves.toBe('rejected')
  })

  it('reports cancellation after the owning signal aborts', async () => {
    const controller = new AbortController()
    const answer = internals.askApproval(async () => {
      controller.abort()
      return 'yes'
    }, request(controller.signal))
    await expect(answer).resolves.toBe('cancelled')
  })

  it('renders Error and non-Error failures', () => {
    expect(internals.renderError(new Error('broken'))).toBe('broken')
    expect(internals.renderError('broken')).toBe('broken')
  })

  it('constructs the process adapter from replaceable streams', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const error = new PassThrough()
    internals.input = input
    internals.output = output
    internals.error = error
    const io = internals.createIo()
    const line = io.readLine('hidden> ')
    input.write('hello\n')
    await expect(line).resolves.toBe('hello')
    io.close()
  })
})

describe('chat command dispatch and agent setup', () => {
  it('shows local help without registered Harness commands', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    const io = capture()
    await internals.dispatchCommand(ctx, { id: SessionId('session') } as Agent, '/help', io, new AbortController().signal)
    expect(io.output).toContain('CLI commands:')
    expect(io.output).not.toContain('Harness commands:')
    await ctx.fiber.dispose()
  })

  it('renders error command output and accepts commands without text', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    ctx.commands.register({ name: 'fail', description: 'fail', handler: () => ({ kind: 'error', text: 'failed' }) })
    ctx.commands.register({ name: 'silent', description: 'silent', handler: () => ({ kind: 'success' }) })
    const io = capture()
    const session = ctx.sessions.create(SessionId('session'), { meta: {} })
    const agent = { id: session.id, session } as Agent
    await internals.dispatchCommand(ctx, agent, '/fail', io, new AbortController().signal)
    await internals.dispatchCommand(ctx, agent, '/silent', io, new AbortController().signal)
    expect(io.error).toBe('failed\n')
    expect(io.output).toBe('')
    await ctx.fiber.dispose()
  })

  it('returns no handle when the Agent runtime is absent', async () => {
    await expect(internals.openAgent(new Context(), {})).resolves.toBeUndefined()
  })
})
