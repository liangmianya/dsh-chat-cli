/** Interactive input, rendering, interaction providers, commands, resume, and shutdown. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type {
  Agent,
  AgentHandle,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
} from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { apply, Config, internals } from '../src/index.ts'

interface FakeIo {
  readonly prompts: string[]
  readonly output: string[]
  readonly errors: string[]
  readLine(prompt: string, signal?: AbortSignal): Promise<string | undefined>
  write(text: string): void
  writeError(text: string): void
  onInterrupt(callback: () => void): () => void
  close(): void
  interrupt(): void
  readonly closed: boolean
}

const DEFER = Symbol('defer input')

function fakeIo(lines: Array<string | undefined | typeof DEFER>): FakeIo {
  let interrupt: (() => void) | undefined
  let releaseRead: ((line: undefined) => void) | undefined
  let closed = false
  return {
    prompts: [], output: [], errors: [],
    readLine(prompt, signal) {
      this.prompts.push(prompt)
      if (signal?.aborted === true || closed) return Promise.resolve(undefined)
      const next = lines.shift()
      if (next !== DEFER) return Promise.resolve(next)
      return new Promise((resolve) => { releaseRead = resolve })
    },
    write(text) { this.output.push(text) },
    writeError(text) { this.errors.push(text) },
    onInterrupt(callback) {
      interrupt = callback
      return () => { interrupt = undefined }
    },
    close() {
      closed = true
      releaseRead?.(undefined)
      releaseRead = undefined
    },
    interrupt() { interrupt?.() },
    get closed() { return closed },
  }
}

interface Bench {
  ctx: Context
  io: FakeIo
  exits: Promise<number>
  created: { mode?: 'create' | 'resume'; disposed: boolean; cancelled: boolean }
}

const benches: Bench[] = []
const originalCreateIo = internals.createIo

afterEach(async () => {
  for (const bench of benches.splice(0)) await bench.ctx.fiber.dispose()
  internals.createIo = originalCreateIo
})

function appendCompletedTurn(ctx: Context, session: Session, agent: Agent, message: UserMessage): Promise<void> {
  return (async () => {
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', message, { surfaceOp: 'append' })
    const approval = await ctx.approval.request({ agent, toolName: 'bash', reason: 'write a file' })
    const answer = await ctx.userQuestions.ask({
      agent,
      questions: [{
        id: 'choice', question: 'Choose a mode', header: 'Mode', detail: 'One is enough.',
        options: [{ label: 'Fast', description: 'finish sooner' }, { label: 'Safe' }],
      }],
    })
    const callId = CallId('call-1')
    session.append('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'checking' },
    })
    session.append('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'Done' },
    })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'Done' }],
        source: { provider: 'test-provider', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(approval).toBe('allowed-once')
    expect(answer).toEqual({ answers: [{ id: 'choice', selected: ['Fast'] }] })
  })()
}

async function bench(
  lines: Array<string | undefined | typeof DEFER>,
  options: {
    resume?: string
    showReasoning?: boolean
    turn?: (ctx: Context, session: Session, agent: Agent, message: UserMessage) => Promise<void>
    factoryFailure?: unknown
    registerCommands?: boolean
  } = {},
): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  const io = fakeIo(lines)
  const created: Bench['created'] = { disposed: false, cancelled: false }
  const make = async (
    ownerCtx: Context,
    sessionId: SessionId,
    setup: CreateAgentOptions['setup'] | ResumeAgentOptions['setup'],
  ): Promise<AgentHandle> => {
    const session = ctx.sessions.create(sessionId, { meta: { cwd: process.cwd() } })
    let status: Agent['status'] = 'idle'
    let idle = Promise.resolve()
    const agent = {} as Agent
    const agentCtx = ownerCtx.extend({ agent })
    Object.assign(agent, {
      id: session.id,
      options: { provider: 'test-provider', model: 'test-model' },
      session,
      inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      ctx: agentCtx,
      cancel: () => { created.cancelled = true },
      runMaintenance: () => Promise.reject(new Error('not used')),
      send: () => {},
      followup: (message: UserMessage) => {
        agent.inbox.append('next-turn', message)
        status = 'running'
        idle = (options.turn ?? appendCompletedTurn)(ctx, session, agent, message)
          .finally(() => { status = 'idle' })
      },
      steer: () => {},
      inject: () => {},
      whenIdle: () => idle,
    } satisfies Partial<Agent>)
    Object.defineProperty(agent, 'status', { get: () => status })
    await setup?.(agentCtx)
    ctx.agents.register(agent)
    return {
      agent,
      dispose: () => { created.disposed = true; return Promise.resolve() },
    }
  }
  ctx.agents.setFactory({
    createAgent: async (ownerCtx, request) => {
      if ('factoryFailure' in options) throw await options.factoryFailure
      created.mode = 'create'
      return make(ownerCtx, request.sessionId, request.setup)
    },
    resume: async (ownerCtx, request) => {
      created.mode = 'resume'
      return make(ownerCtx, request.resumeSessionId, request.setup)
    },
  })
  if (options.registerCommands !== false) {
    ctx.commands.register({
      name: 'echo', description: 'echo command input',
      handler: ({ rawInput }) => ({ kind: 'success', text: rawInput.trim() }),
    })
  }
  internals.createIo = () => io
  let exit!: (code: number) => void
  const exits = new Promise<number>((resolve) => { exit = resolve })
  ctx.provide('appExit', exit)
  apply(ctx, options)
  const value = { ctx, io, exits, created }
  benches.push(value)
  return value
}

describe('chat runner', () => {
  it('drives a multi-turn CLI with approvals, questions, rendering, and commands', async () => {
    const test = await bench([
      '', 'do it', 'yes', '1', '/echo hello', '/session', '/help', '/missing', '/exit',
    ], { showReasoning: true })
    expect(await test.exits).toBe(0)
    expect(test.created).toMatchObject({ mode: 'create', disposed: true })
    expect(test.io.output.join('')).toContain('DeepSeek Harness chat\nSession: session-')
    expect(test.io.output.join('')).toContain('reasoning> checking\nassistant> Done\n[tool] bash\n[tool] bash done\n')
    expect(test.io.output.join('')).toContain('hello\n')
    expect(test.io.output.join('')).toContain('CLI commands:\n')
    expect(test.io.output.join('')).toContain('Harness commands:\n  /echo  echo command input\n')
    expect(test.io.errors.join('')).toContain('unknown command')
    expect(test.io.closed).toBe(true)
  })

  it('resumes a session and falls back to the assembled assistant message', async () => {
    const turn = async (_ctx: Context, session: Session, _agent: Agent, message: UserMessage): Promise<void> => {
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('user/message', message, { surfaceOp: 'append' })
      session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'fallback' }],
          source: { provider: 'test-provider', model: 'test-model' },
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', {
        turn: 1, reason: { kind: 'error', error: { code: 'TEST', message: 'failed' } },
      })
    }
    const test = await bench(['again', undefined], { resume: 'persisted', turn })
    expect(await test.exits).toBe(0)
    expect(test.created.mode).toBe('resume')
    expect(test.io.output.join('')).toContain('assistant> fallback\n')
    expect(test.io.errors.join('')).toContain('dsh: TEST: failed\n')
  })

  it('returns the conventional interrupt code while waiting for input', async () => {
    const test = await bench([DEFER])
    while (!test.io.prompts.includes('you> ')) await new Promise(resolve => setTimeout(resolve, 1))
    test.io.interrupt()
    expect(await test.exits).toBe(130)
  })

  it('cancels a running turn without closing the conversation', async () => {
    let finishTurn!: () => void
    const turn = () => new Promise<void>((resolve) => { finishTurn = resolve })
    const test = await bench(['work', '/exit'], { turn })
    while (finishTurn === undefined) await new Promise(resolve => setTimeout(resolve, 1))
    test.io.interrupt()
    finishTurn()
    expect(await test.exits).toBe(0)
    expect(test.created.cancelled).toBe(true)
    expect(test.io.errors.join('')).toContain('cancelling current turn')
  })

  it('delegates approvals for another agent and ignores unrelated session events', async () => {
    const turn = async (ctx: Context, session: Session, agent: Agent, message: UserMessage): Promise<void> => {
      session.append('turn/start', { turn: 1 })
      session.append('user/message', message, { surfaceOp: 'append' })
      const otherSession = ctx.sessions.create('other-session' as SessionId, { meta: {} })
      const otherAgent = { ...agent, id: otherSession.id, session: otherSession } as Agent
      otherSession.append('turn/start', { turn: 1 })
      expect(await ctx.approval.request({ agent: otherAgent, toolName: 'foreign' })).toBe('unavailable')
      otherSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }
    const test = await bench(['work', '/exit'], { turn })
    expect(await test.exits).toBe(0)
    expect(test.io.output.join('')).not.toContain('foreign')
  })

  it('exits cleanly when required runtime services are unavailable', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(UserQuestionService)
    const io = fakeIo([])
    internals.createIo = () => io
    let exit!: (code: number) => void
    const exited = new Promise<number>((resolve) => { exit = resolve })
    ctx.provide('appExit', exit)
    apply(ctx, {})
    expect(await exited).toBe(0)
    expect(io.closed).toBe(true)
    await ctx.fiber.dispose()
  })

  it('contains startup failures and reports a process failure', async () => {
    const test = await bench([], { factoryFailure: new Error('cannot open session') })
    expect(await test.exits).toBe(1)
    expect(test.io.errors.join('')).toContain('dsh: cannot open session')
  })

  it('does not publish completion or dispose an agent after runner teardown', async () => {
    const test = await bench([DEFER])
    while (!test.io.prompts.includes('you> ')) await new Promise(resolve => setTimeout(resolve, 1))
    await test.ctx.fiber.dispose()
    expect(test.created.disposed).toBe(false)
  })

  it('contains a startup rejection that settles after runner teardown', async () => {
    let rejectFactory!: (cause: unknown) => void
    const failure = new Promise<never>((_resolve, reject) => { rejectFactory = reject })
    const test = await bench([], { factoryFailure: failure })
    await new Promise(resolve => setTimeout(resolve, 0))
    const disposal = test.ctx.fiber.dispose()
    rejectFactory('late failure')
    await disposal
    expect(test.io.errors.join('')).toContain('dsh: late failure')
  })

  it('fails loud without the launcher exit service and validates config', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, {}) }).toThrow('must provide ctx.appExit')
    expect(new Config({})).toEqual({ showReasoning: false })
    expect(new Config({ resume: 'x', showReasoning: true })).toEqual({ resume: 'x', showReasoning: true })
  })
})
