/**
 * The interactive CLI's command-line provider.
 * @module dsh-chat-cli/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'chat-startup'

/** Services required before CLI arguments can be parsed. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the interactive runner. */
export const CHAT_STARTUP_SERVICE = 'chatStartup'

/** Parsed interactive CLI options. */
export interface ChatStartupValues {
  /** Persisted session identity to resume, or undefined for a new session. */
  resume?: string
  /** Whether reasoning deltas are printed. */
  showReasoning: boolean
}

/**
 * Parse and publish the interactive CLI options.
 * @param ctx - plugin context carrying the launcher's immutable arguments.
 */
export function apply(ctx: Context): void {
  const program = new Command()
    .name('dsh --profile chat-cli')
    .description('Start an interactive command-line conversation.')
    .helpOption('-h, --help', 'show this help')
    .option('--resume <session>', 'resume a persisted session')
    .option('--show-reasoning', 'print model reasoning deltas', false)
    .addHelpText('after', `
Examples:
  dsh --profile chat-cli
  dsh --profile chat-cli --resume session-123
`)

  program.action(() => {
    const options = program.opts<{ resume?: string; showReasoning: boolean }>()
    if (options.resume !== undefined && options.resume.trim() === '') {
      program.error('error: --resume needs a non-empty session id')
    }
    ctx.provide(CHAT_STARTUP_SERVICE, {
      ...options.resume === undefined ? {} : { resume: options.resume },
      showReasoning: options.showReasoning,
    } satisfies ChatStartupValues)
  })
  parseCmdline(ctx, program)
}
