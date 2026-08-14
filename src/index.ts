/**
 * Interactive, line-oriented CLI driver over the core Agent and Session APIs.
 * It owns terminal input, live rendering, human questions, approval answers,
 * slash-command dispatch, and bounded shutdown without mounting a Web server
 * or a full-screen terminal UI.
 *
 * @module dsh-chat-cli
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  UserQuestionProvider,
} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { createProcessIo } from './process-io.ts'
import type { ChatIo, InputStream, OutputStream } from './process-io.ts'

/** Stable Cordis plugin name. */
export const name = 'chat-runner'

/** Services required before an interactive session can start. */
export const inject = ['agentDefaultModel', 'agents', 'commands', 'sessions', 'userQuestions']

/** Interactive runner config resolved by the app's command-line provider. */
export interface Config {
  /** Persisted session identity to resume, or undefined for a new session. */
  resume?: string
  /** Whether reasoning deltas are printed. */
  showReasoning?: boolean
}

export const Config: z<Config> = z.object({
  resume: z.string(),
  showReasoning: z.boolean().default(false),
})

/** Render an unknown thrown value for a process-facing diagnostic. */
function renderError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Keep output lines coherent while chunks, tools, and turn outcomes interleave. */
class ChatRenderer {
  private open: 'assistant' | 'reasoning' | undefined
  private readonly streamedSteps = new Set<string>()
  private readonly toolNames = new Map<string, string>()

  constructor(private readonly io: ChatIo, private readonly showReasoning: boolean) {}

  event(event: SessionEvent): void {
    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk
      const key = `${String(event.data.turn)}:${String(event.data.step)}`
      if (chunk.type === 'text-delta' && chunk.text !== '') {
        this.streamedSteps.add(key)
        this.chunk('assistant', 'assistant> ', chunk.text)
      } else if (this.showReasoning && chunk.type === 'reasoning-delta' && chunk.text !== '') {
        this.chunk('reasoning', 'reasoning> ', chunk.text)
      }
      return
    }
    if (event.type === 'assistant/message') {
      const key = `${String(event.data.turn)}:${String(event.data.step)}`
      if (!this.streamedSteps.has(key)) {
        const text = event.data.message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
        if (text !== '') this.chunk('assistant', 'assistant> ', text)
      }
      return
    }
    if (event.type === 'tool/call') {
      this.endLine()
      this.toolNames.set(event.data.callId, event.data.name)
      this.io.write(`[tool] ${event.data.name}\n`)
      return
    }
    if (event.type === 'tool/result') {
      this.endLine()
      const toolName = this.toolNames.get(event.data.message.source.callId) ?? 'unknown'
      this.io.write(`[tool] ${toolName} ${event.data.message.content[0].isError === true ? 'failed' : 'done'}\n`)
      return
    }
    if (event.type === 'turn/end') {
      this.endLine()
      const reason = event.data.reason
      if (reason.kind === 'error') {
        this.io.writeError(`dsh: ${reason.error.code}: ${reason.error.message}\n`)
      } else if (reason.kind === 'aborted') {
        this.io.writeError('dsh: turn cancelled\n')
      } else if (reason.kind === 'blocked') {
        this.io.writeError('dsh: turn blocked\n')
      } else if (reason.kind === 'max-tokens') {
        this.io.writeError('dsh: model output reached its token limit\n')
      }
    }
  }

  finish(): void {
    this.endLine()
  }

  private chunk(channel: 'assistant' | 'reasoning', prefix: string, text: string): void {
    if (this.open !== channel) {
      this.endLine()
      this.io.write(prefix)
      this.open = channel
    }
    this.io.write(text)
  }

  private endLine(): void {
    if (this.open !== undefined) this.io.write('\n')
    this.open = undefined
  }
}

/** Serialize all terminal questions, including parallel tool approvals. */
function questionQueue(io: ChatIo): (prompt: string, signal?: AbortSignal) => Promise<string | undefined> {
  let tail = Promise.resolve<unknown>(undefined)
  return (prompt, signal) => {
    const answer = tail.then(() => io.readLine(prompt, signal))
    tail = answer.catch(() => undefined)
    return answer
  }
}

/** Render and collect one structured `ask_user_question` item. */
async function askQuestion(
  io: ChatIo,
  ask: (prompt: string, signal?: AbortSignal) => Promise<string | undefined>,
  question: AskUserQuestionItem,
  signal?: AbortSignal,
): Promise<AskUserQuestionAnswerItem> {
  io.write(`\n${question.header === undefined ? 'Question' : question.header}: ${question.question}\n`)
  if (question.detail !== undefined) io.write(`${question.detail}\n`)
  for (const [index, option] of (question.options ?? []).entries()) {
    io.write(`  ${String(index + 1)}. ${option.label}${option.description === undefined ? '' : ` - ${option.description}`}\n`)
  }
  const prompt = question.multiSelect === true ? 'Select one or more (comma-separated): ' : 'Answer: '
  const line = await ask(prompt, signal)
  if (line === undefined) throw new Error('terminal input closed before the question was answered')
  return parseQuestionAnswer(question, line)
}

/** Convert labels, one-based option numbers, and free text into the service answer format. */
function parseQuestionAnswer(question: AskUserQuestionItem, line: string): AskUserQuestionAnswerItem {
  const options = question.options ?? []
  const tokens = question.multiSelect === true ? line.split(',').map(token => token.trim()) : [line.trim()]
  const selected: string[] = []
  const custom: string[] = []
  for (const token of tokens.filter(token => token !== '')) {
    const numeric = /^\d+$/.test(token) ? Number(token) : Number.NaN
    const byNumber = Number.isSafeInteger(numeric) ? options[numeric - 1] : undefined
    const byLabel = options.find(option => option.label.toLocaleLowerCase() === token.toLocaleLowerCase())
    const matched = byNumber ?? byLabel
    if (matched === undefined) custom.push(token)
    else if (!selected.includes(matched.label)) selected.push(matched.label)
  }
  return {
    id: question.id,
    selected,
    ...custom.length === 0 ? {} : { custom: custom.join(', ') },
  }
}

/** Prompt for one tool approval owned by the active root agent. */
async function askApproval(
  ask: (prompt: string, signal?: AbortSignal) => Promise<string | undefined>,
  request: ApprovalRequest,
): Promise<ApprovalOutcome> {
  const reason = request.reason === undefined ? '' : `: ${request.reason}`
  const answer = await ask(`Approve ${request.toolName}${reason}? [y/N] `, request.signal)
  if (request.signal?.aborted === true) return 'cancelled'
  return answer !== undefined && /^(?:y|yes)$/i.test(answer.trim()) ? 'allowed-once' : 'rejected'
}

/** Show local commands and the effective Harness command registry. */
function showHelp(ctx: Context, agent: Agent, io: ChatIo): void {
  io.write([
    'CLI commands:',
    '  /help       show this help',
    '  /session    print the current session id',
    '  /exit       save and exit',
  ].join('\n') + '\n')
  const commands = ctx.commands.list(agent)
  if (commands.length === 0) return
  io.write('Harness commands:\n')
  for (const command of commands) io.write(`  /${command.name}  ${command.description}\n`)
}

/** Create or resume the one Agent owned by this CLI process. */
async function openAgent(ctx: Context, config: Config): Promise<AgentHandle | undefined> {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  if (agents === undefined || defaultModel === undefined || ctx.get('sessions') === undefined) return undefined
  const selection = defaultModel.currentSelection()
  const setup = (agentCtx: Context): void => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }
  const agentOptions = { provider: selection.provider, model: selection.model }
  if (config.resume !== undefined) {
    return agents.resume({
      resumeSessionId: SessionId(config.resume),
      agentOptions,
      setup,
    })
  }
  return agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions,
    setup,
  })
}

/** Dispatch a local or registered slash command. */
async function dispatchCommand(ctx: Context, agent: Agent, line: string, io: ChatIo, signal: AbortSignal): Promise<boolean> {
  const name = line.trim().toLocaleLowerCase()
  if (name === '/help') {
    showHelp(ctx, agent, io)
    return true
  }
  if (name === '/session') {
    io.write(`${agent.id}\n`)
    return true
  }
  const execution = await ctx.commands.execute(agent, line, signal)
  if (execution === undefined) {
    io.writeError(`dsh: unknown command ${JSON.stringify(line.split(/\s/u, 1)[0])}; use /help\n`)
    return true
  }
  if (execution.result.text !== undefined) {
    const output = execution.result.kind === 'error' ? io.writeError.bind(io) : io.write.bind(io)
    output(execution.result.text + '\n')
  }
  return true
}

/** Process adapters and focused pure helpers exposed for package-owned tests. */
export const internals: {
  input: InputStream
  output: OutputStream
  error: OutputStream
  createIo(): ChatIo
  renderer(io: ChatIo, showReasoning: boolean): { event(event: SessionEvent): void; finish(): void }
  questionQueue: typeof questionQueue
  askQuestion: typeof askQuestion
  parseQuestionAnswer: typeof parseQuestionAnswer
  askApproval: typeof askApproval
  renderError: typeof renderError
  openAgent: typeof openAgent
  dispatchCommand: typeof dispatchCommand
} = {
  input: process.stdin,
  output: process.stdout,
  error: process.stderr,
  createIo: () => createProcessIo(internals.input, internals.output, internals.error),
  renderer: (io, showReasoning) => new ChatRenderer(io, showReasoning),
  questionQueue,
  askQuestion,
  parseQuestionAnswer,
  askApproval,
  renderError,
  openAgent,
  dispatchCommand,
}

/** Drive the interactive input loop and return its process exit code. */
async function run(ctx: Context, config: Config, io: ChatIo, lifecycle: AbortController): Promise<number> {
  let handle: AgentHandle | undefined
  let agent: Agent | undefined
  let disposeSessionEvents: (() => void) | undefined
  let disposeApproval: (() => void) | undefined
  let disposeQuestions: (() => void) | undefined
  let disposeInterrupt: (() => void) | undefined
  const ask = questionQueue(io)
  const renderer = new ChatRenderer(io, config.showReasoning === true)
  let requestedExitCode = 0
  try {
    const activeSession: { value?: Session } = {}
    disposeSessionEvents = ctx.on('session/event', (session, event: SessionEvent) => {
      if (session === activeSession.value) renderer.event(event)
    })
    disposeApproval = ctx.on('approval/request', (request, next) => {
      if (request.agent !== agent) return next()
      return askApproval(ask, request)
    }, { prepend: true })
    const provider: UserQuestionProvider = {
      async ask(request): Promise<AskUserQuestionAnswer> {
        const answers: AskUserQuestionAnswerItem[] = []
        for (const question of request.questions) {
          answers.push(await askQuestion(io, ask, question, request.signal))
        }
        return { answers }
      },
    }
    disposeQuestions = ctx.userQuestions.registerProvider(provider)

    handle = await openAgent(ctx, config)
    if (handle === undefined) return 0
    agent = handle.agent
    activeSession.value = agent.session
    await agent.whenIdle()
    io.write(`DeepSeek Harness chat\nSession: ${agent.id}\nType /help for commands.\n`)

    disposeInterrupt = io.onInterrupt(() => {
      if (agent?.status === 'running') {
        io.writeError('\ndsh: cancelling current turn\n')
        agent.cancel({ kind: 'user' })
      } else {
        requestedExitCode = 130
        io.close()
      }
    })

    while (!lifecycle.signal.aborted) {
      const line = await ask('you> ', lifecycle.signal)
      if (line === undefined) break
      if (line.trim() === '') continue
      const normalized = line.trim().toLocaleLowerCase()
      if (normalized === '/exit' || normalized === '/quit') break
      if (line.trimStart().startsWith('/')) {
        await dispatchCommand(ctx, agent, line, io, lifecycle.signal)
      } else {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: line }],
          source: { kind: 'user' },
        }))
      }
      await agent.whenIdle()
      await ctx.sessions.flush(agent.session)
    }
    renderer.finish()
    await ctx.sessions.flush(agent.session)
    return requestedExitCode
  } finally {
    disposeInterrupt?.()
    disposeQuestions?.()
    disposeApproval?.()
    disposeSessionEvents?.()
    renderer.finish()
    if (!lifecycle.signal.aborted && handle !== undefined) await handle.dispose()
    io.close()
  }
}

/**
 * Mount the interactive CLI driver.
 * @param ctx - plugin context carrying the Agent, Session, commands, interaction services, and launcher exit request.
 * @param config - validated startup options.
 */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('chat-runner: the launcher must provide ctx.appExit before the tree mounts')
  ctx.effect(() => {
    const lifecycle = new AbortController()
    const io = internals.createIo()
    const task = run(ctx, config, io, lifecycle).then(
      (code) => {
        /* v8 ignore else -- Cordis disposal owns process settlement after aborting this lifecycle. */
        if (!lifecycle.signal.aborted) exit(code)
      },
      (cause: unknown) => {
        io.writeError(`dsh: ${renderError(cause)}\n`)
        if (!lifecycle.signal.aborted) exit(1)
      },
    )
    return async () => {
      lifecycle.abort(new Error('chat runner disposed'))
      io.close()
      await task
    }
  }, 'chat.run()')
}
