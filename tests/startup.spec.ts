/** The chat command-line provider over the launcher's real command-line host. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { apply, CHAT_STARTUP_SERVICE, type ChatStartupValues } from '../src/startup.ts'

const contexts: Context[] = []

afterEach(async () => {
  internals.stdout = process.stdout
  internals.stderr = process.stderr
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function parse(args: string[]): { value: ChatStartupValues | undefined; exits: number[]; output: () => string } {
  const ctx = new Context()
  contexts.push(ctx)
  const exits: number[] = []
  let text = ''
  const capture = { write: (chunk: string) => { text += chunk; return true } }
  internals.stdout = capture
  internals.stderr = capture
  provideCmdline(ctx, { args, exit: code => void exits.push(code) })
  apply(ctx)
  return {
    value: ctx.get(CHAT_STARTUP_SERVICE) as ChatStartupValues | undefined,
    exits,
    output: () => text,
  }
}

describe('chat command-line provider', () => {
  it('publishes defaults and resume options', () => {
    expect(parse([]).value).toEqual({ showReasoning: false })
    expect(parse(['--resume', 'session-1', '--show-reasoning']).value).toEqual({
      resume: 'session-1', showReasoning: true,
    })
  })

  it('prints app help without publishing startup values', () => {
    const result = parse(['--help'])
    expect(result.value).toBeUndefined()
    expect(result.exits).toEqual([0])
    expect(result.output()).toContain('dsh chat')
  })

  it('rejects a whitespace-only resume identity', () => {
    const result = parse(['--resume', '   '])
    expect(result.value).toBeUndefined()
    expect(result.exits).toEqual([1])
    expect(result.output()).toContain('non-empty session id')
  })
})
