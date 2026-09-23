import { afterEach, describe, expect, it, mock } from 'bun:test'
import {
  PTY_OPEN_CLIENT_COMMAND,
  PTY_SHOW_SERVER_URL_COMMAND,
  Plugin,
  V2SessionNotifier,
  getActiveServer,
  getOrCreateServer,
  handleShowServerUrlCommand,
  ptyTools,
  stopActiveServer,
} from '../src/v2/index.ts'
import { manager } from '../src/plugin/pty/manager.ts'
import type {
  CommandDefinition,
  CommandDraft,
  PluginContextV2,
  ToolDraft,
  ToolInfoV2,
  V2Event,
} from '../src/v2/types.ts'

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(condition()).toBe(true)
}

function contextWithEvents(events: AsyncIterable<V2Event>): {
  context: PluginContextV2
  getSignal: () => AbortSignal | undefined
} {
  let signal: AbortSignal | undefined
  return {
    context: {
      options: {},
      event: {
        subscribe: (options) => {
          signal = options?.signal
          return events
        },
      },
      session: {
        prompt: async () => ({}) as never,
      },
    },
    getSignal: () => signal,
  }
}

function sessionDeletedEvent(sessionID: string): V2Event {
  return { type: 'session.deleted', data: { sessionID } }
}

describe('OpenCode V2 Plugin API', () => {
  afterEach(() => {
    stopActiveServer()
    manager.clearAllSessions()
    manager.setNotifier(null)
  })

  describe('Plugin Contract Conformance', () => {
    it('satisfies the V2 plugin structure (id and setup)', () => {
      expect(Plugin.id).toBe('opencode-pty')
      expect(typeof Plugin.setup).toBe('function')
    })

    it('exports standard PTY tools', () => {
      expect(ptyTools.pty_spawn).toBeDefined()
      expect(ptyTools.pty_write).toBeDefined()
      expect(ptyTools.pty_read).toBeDefined()
      expect(ptyTools.pty_list).toBeDefined()
      expect(ptyTools.pty_kill).toBeDefined()
    })
  })

  describe('Tool Registration via ctx.tool.transform', () => {
    it('registers every PTY tool with name, input schema and execute', async () => {
      const registeredTools: Record<string, ToolInfoV2> = {}

      const draft: ToolDraft = {
        add: (tool) => {
          registeredTools[tool.name] = tool
        },
      }

      const mockTransform = mock(async (callback: (draft: ToolDraft) => void) => {
        callback(draft)
        return undefined
      })

      const ctx: PluginContextV2 = {
        options: {},
        tool: {
          transform: mockTransform,
        },
      }

      await Plugin.setup(ctx)

      expect(mockTransform).toHaveBeenCalled()
      expect(Object.keys(registeredTools).sort()).toEqual([
        'pty_kill',
        'pty_list',
        'pty_read',
        'pty_spawn',
        'pty_write',
      ])

      for (const tool of Object.values(registeredTools)) {
        expect(typeof tool.description).toBe('string')
        expect(tool.description.length).toBeGreaterThan(0)
        expect(tool.input).toBeDefined()
        expect(typeof tool.execute).toBe('function')
      }
    })

    it('does not fail when the tool transform is unavailable', async () => {
      const ctx: PluginContextV2 = { options: {} }
      await Plugin.setup(ctx)
      expect(getActiveServer()).toBeNull()
    })
  })

  describe('Command Registration via ctx.command.transform', () => {
    it('registers slash commands with an execute handler', async () => {
      const registeredCommands: Record<string, CommandDefinition> = {}

      const draft: CommandDraft = {
        add: (command) => {
          registeredCommands[command.name] = command
        },
      }

      const mockTransform = mock(async (callback: (draft: CommandDraft) => void) => {
        callback(draft)
        return undefined
      })

      const ctx: PluginContextV2 = {
        options: {},
        command: {
          transform: mockTransform,
        },
      }

      await Plugin.setup(ctx)

      expect(mockTransform).toHaveBeenCalled()
      expect(registeredCommands[PTY_OPEN_CLIENT_COMMAND]?.description).toBe(
        'Open PTY Sessions Web Interface'
      )
      expect(typeof registeredCommands[PTY_OPEN_CLIENT_COMMAND]?.execute).toBe('function')
      expect(registeredCommands[PTY_SHOW_SERVER_URL_COMMAND]?.description).toBe(
        'Show PTY Sessions Web Interface URL'
      )
      expect(typeof registeredCommands[PTY_SHOW_SERVER_URL_COMMAND]?.execute).toBe('function')
    })
  })

  describe('Lifecycle cleanup', () => {
    it('cleans PTYs belonging to a deleted session and leaves unrelated PTYs running', async () => {
      const matching = manager.spawn({
        command: 'sh',
        args: ['-c', 'sleep 60'],
        description: 'matching V2 session',
        parentSessionId: 'session-to-delete',
        notifyOnExit: false,
      })
      const unrelated = manager.spawn({
        command: 'sh',
        args: ['-c', 'sleep 60'],
        description: 'unrelated V2 session',
        parentSessionId: 'other-session',
        notifyOnExit: false,
      })
      const events = (async function* () {
        yield sessionDeletedEvent('session-to-delete')
      })()
      const { context, getSignal } = contextWithEvents(events)

      const cleanup = await Plugin.setup(context)
      await waitFor(() => manager.get(matching.id) === null)

      expect(getSignal()).toBeInstanceOf(AbortSignal)
      expect(manager.get(unrelated.id)).not.toBeNull()
      await cleanup?.()
    })

    it('graceful cleanup clears every PTY, stops the server, and aborts the subscription', async () => {
      manager.spawn({
        command: 'sh',
        args: ['-c', 'sleep 60'],
        description: 'cleanup test',
        parentSessionId: 'cleanup-parent',
        notifyOnExit: false,
      })
      await getOrCreateServer({ port: 0, hostname: '127.0.0.1' })
      const events: AsyncIterable<V2Event> = {
        [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
      }
      const { context, getSignal } = contextWithEvents(events)
      const cleanup = await Plugin.setup(context)
      expect(manager.getNotifier()).toBeInstanceOf(V2SessionNotifier)

      await cleanup?.()

      expect(manager.list()).toEqual([])
      expect(getActiveServer()).toBeNull()
      expect(getSignal()?.aborted).toBe(true)
      expect(manager.getNotifier()).not.toBeInstanceOf(V2SessionNotifier)
    })

    it('does not let a setup without a session domain erase another live notifier', async () => {
      const firstCleanup = await Plugin.setup({
        options: {},
        session: {
          prompt: async () => ({}) as never,
        },
      })
      expect(manager.getNotifier()).toBeInstanceOf(V2SessionNotifier)

      const secondCleanup = await Plugin.setup({ options: {} })

      expect(manager.getNotifier()).toBeInstanceOf(V2SessionNotifier)
      await secondCleanup?.()
      expect(manager.getNotifier()).toBeInstanceOf(V2SessionNotifier)
      await firstCleanup?.()
      expect(manager.getNotifier()).not.toBeInstanceOf(V2SessionNotifier)
    })

    it('keeps the newest live notifier when an older plugin instance is cleaned up', async () => {
      const firstCleanup = await Plugin.setup({
        options: {},
        session: {
          prompt: async () => ({}) as never,
        },
      })
      const firstNotifier = manager.getNotifier()
      const secondCleanup = await Plugin.setup({
        options: {},
        session: {
          prompt: async () => ({}) as never,
        },
      })
      const secondNotifier = manager.getNotifier()

      expect(secondNotifier).toBeInstanceOf(V2SessionNotifier)
      expect(secondNotifier).not.toBe(firstNotifier)

      await firstCleanup?.()
      expect(manager.getNotifier()).toBe(secondNotifier)

      await secondCleanup?.()
      expect(manager.getNotifier()).not.toBeInstanceOf(V2SessionNotifier)
    })

    it('restores an older live notifier when the newest plugin instance is cleaned up', async () => {
      const firstCleanup = await Plugin.setup({
        options: {},
        session: {
          prompt: async () => ({}) as never,
        },
      })
      const firstNotifier = manager.getNotifier()
      const secondCleanup = await Plugin.setup({
        options: {},
        session: {
          prompt: async () => ({}) as never,
        },
      })

      await secondCleanup?.()
      expect(manager.getNotifier()).toBe(firstNotifier)

      await firstCleanup?.()
      expect(manager.getNotifier()).not.toBeInstanceOf(V2SessionNotifier)
    })

    it('restores the notifier that the first V2 plugin instance displaced', async () => {
      const previousNotifier = { sendExitNotification: async () => {} }
      manager.setNotifier(previousNotifier)
      const cleanup = await Plugin.setup({
        options: {},
        session: {
          prompt: async () => ({}) as never,
        },
      })

      expect(manager.getNotifier()).toBeInstanceOf(V2SessionNotifier)

      await cleanup?.()
      expect(manager.getNotifier()).toBe(previousNotifier)
    })

    it('does not publish a notifier when setup fails', async () => {
      const previousNotifier = { sendExitNotification: async () => {} }
      manager.setNotifier(previousNotifier)

      await expect(
        Plugin.setup({
          options: {},
          session: {
            prompt: async () => ({}) as never,
          },
          tool: {
            transform: async () => {
              throw new Error('transform failed')
            },
          },
        })
      ).rejects.toThrow('transform failed')

      expect(manager.getNotifier()).toBe(previousNotifier)

      const cleanup = await Plugin.setup({
        options: {},
        session: {
          prompt: async () => ({}) as never,
        },
      })
      await cleanup?.()

      expect(manager.getNotifier()).toBe(previousNotifier)
    })

    it('is safe to clean up repeatedly and disposes registrations only once', async () => {
      const dispose = mock(async () => {})
      const cleanup = await Plugin.setup({
        options: {},
        tool: {
          transform: async (callback) => {
            callback({ add: () => {} })
            return { dispose }
          },
        },
      })

      await cleanup?.()
      await cleanup?.()

      expect(dispose).toHaveBeenCalledTimes(1)
    })

    it('contains and logs unexpected event stream failures', async () => {
      const errors: unknown[][] = []
      const originalError = console.error
      console.error = (...args: unknown[]) => errors.push(args)
      const events: AsyncIterable<V2Event> = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new Error('event stream failed')
          },
        }),
      }

      try {
        const { context } = contextWithEvents(events)
        const cleanup = await Plugin.setup(context)
        await waitFor(() => errors.length === 1)
        expect(String(errors[0]?.[0])).toContain('event subscription failed')
        await cleanup?.()
      } finally {
        console.error = originalError
      }
    })

    it('does not log an abort caused by normal cleanup', async () => {
      const errors: unknown[][] = []
      let eventConsumerSettled = false
      const originalError = console.error
      console.error = (...args: unknown[]) => errors.push(args)

      try {
        const cleanup = await Plugin.setup({
          options: {},
          event: {
            subscribe: ({ signal } = {}) => ({
              [Symbol.asyncIterator]: () => ({
                next: () =>
                  new Promise<IteratorResult<V2Event>>((_, reject) => {
                    signal?.addEventListener(
                      'abort',
                      () => {
                        setTimeout(() => {
                          eventConsumerSettled = true
                          const error = new Error('subscription aborted')
                          error.name = 'AbortError'
                          reject(error)
                        }, 20)
                      },
                      { once: true }
                    )
                  }),
              }),
            }),
          },
        })

        await cleanup?.()
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(errors).toEqual([])
        expect(eventConsumerSettled).toBe(true)
      } finally {
        console.error = originalError
      }
    })

    it('continues resource cleanup when registration disposal fails', async () => {
      const errors: unknown[][] = []
      let eventConsumerSettled = false
      const originalError = console.error
      console.error = (...args: unknown[]) => errors.push(args)
      manager.spawn({
        command: 'sh',
        args: ['-c', 'sleep 60'],
        description: 'disposal failure test',
        parentSessionId: 'cleanup-parent',
        notifyOnExit: false,
      })
      await getOrCreateServer({ port: 0, hostname: '127.0.0.1' })

      try {
        const cleanup = await Plugin.setup({
          options: {},
          session: {
            prompt: async () => ({}) as never,
          },
          command: {
            transform: async (callback) => {
              callback({ add: () => {} })
              return {
                dispose: async () => {
                  throw new Error('dispose failed')
                },
              }
            },
          },
          event: {
            subscribe: ({ signal } = {}) => ({
              [Symbol.asyncIterator]: () => ({
                next: () =>
                  new Promise<IteratorResult<V2Event>>((_, reject) => {
                    signal?.addEventListener(
                      'abort',
                      () => {
                        eventConsumerSettled = true
                        const error = new Error('subscription aborted')
                        error.name = 'AbortError'
                        reject(error)
                      },
                      { once: true }
                    )
                  }),
              }),
            }),
          },
        })

        await cleanup?.()

        expect(manager.list()).toEqual([])
        expect(getActiveServer()).toBeNull()
        expect(manager.getNotifier()).not.toBeInstanceOf(V2SessionNotifier)
        expect(eventConsumerSettled).toBe(true)
        expect(errors.some((args) => String(args[0]).includes('registration cleanup failed'))).toBe(
          true
        )
      } finally {
        console.error = originalError
      }
    })
  })

  describe('Options Support (Custom Port & Hostname)', () => {
    it('creates server with custom port and hostname when specified', async () => {
      const server = await getOrCreateServer({ port: 0, hostname: '127.0.0.1' })
      expect(server).toBeDefined()
      expect(server.server.url.protocol).toBe('http:')
      expect(server.server.url.hostname).toBe('127.0.0.1')
    })

    it('autostarts server when autostart option is true in ctx.options', async () => {
      expect(getActiveServer()).toBeNull()

      const ctx: PluginContextV2 = {
        options: {
          autostart: true,
          hostname: '127.0.0.1',
        },
      }

      await Plugin.setup(ctx)

      const active = getActiveServer()
      expect(active).not.toBeNull()
      expect(active?.server.url.hostname).toBe('127.0.0.1')
    })

    it('shows server URL via handleShowServerUrlCommand', async () => {
      const message = await handleShowServerUrlCommand({ hostname: '127.0.0.1' })
      expect(message).toContain('PTY Sessions Web Interface URL: http://127.0.0.1:')
    })
  })
})
