import open from 'open'
import { PTYServer, type ServerOptions } from '../web/server/server.ts'
import type { CommandDraft, OpencodePtyOptions } from './types.ts'

export const PTY_OPEN_CLIENT_COMMAND = 'pty-open-background-spy'
export const PTY_SHOW_SERVER_URL_COMMAND = 'pty-show-server-url'

let activeServer: PTYServer | null = null

export async function getOrCreateServer(options?: ServerOptions): Promise<PTYServer> {
  if (!activeServer) {
    activeServer = await PTYServer.createServer(options)
  }
  return activeServer
}

export function getActiveServer(): PTYServer | null {
  return activeServer
}

export function stopActiveServer(): void {
  if (activeServer) {
    activeServer[Symbol.dispose]()
    activeServer = null
  }
}

export async function handleOpenClientCommand(options?: ServerOptions): Promise<string> {
  const server = await getOrCreateServer(options)
  const url = server.server.url.origin
  open(url)
  return `PTY Sessions Web Interface opened at: ${url}`
}

export async function handleShowServerUrlCommand(options?: ServerOptions): Promise<string> {
  const server = await getOrCreateServer(options)
  return `PTY Sessions Web Interface URL: ${server.server.url.origin}`
}

/**
 * Registers the PTY slash commands with opencode v2's `CommandEditor`.
 *
 * opencode v2's `command.transform` draft exposes `add(definition)` only
 * (there is no `update`), so commands must be created with an `execute`
 * handler rather than "updated".
 */
export function registerV2Commands(draft: CommandDraft, options?: OpencodePtyOptions): void {
  if (typeof draft.add !== 'function') {
    return
  }
  const add = draft.add.bind(draft)

  add({
    name: PTY_OPEN_CLIENT_COMMAND,
    description: 'Open PTY Sessions Web Interface',
    execute: async () => {
      await handleOpenClientCommand(options)
    },
  })

  add({
    name: PTY_SHOW_SERVER_URL_COMMAND,
    description: 'Show PTY Sessions Web Interface URL',
    execute: async () => {
      await handleShowServerUrlCommand(options)
    },
  })
}
