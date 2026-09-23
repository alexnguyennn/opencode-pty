import { createV2Adapter } from '../adapters/v2/index.ts'
import { installHostAdapter } from '../adapters/index.ts'
import type { SessionNotifier } from '../adapters/types.ts'
import { manager } from '../plugin/pty/manager.ts'
import { getOrCreateServer, registerV2Commands, stopActiveServer } from './commands.ts'
import { V2SessionNotifier } from './notifier.ts'
import { registerV2Tools } from './tools.ts'
import {
  define,
  type OpencodePtyOptions,
  type PluginContextV2,
  type PluginV2,
  type Registration,
  type V2Event,
} from './types.ts'

export * from './commands.ts'
export * from './notifier.ts'
export * from './tools.ts'
export * from './types.ts'

const activeNotifiers: V2SessionNotifier[] = []
let displacedNotifier: SessionNotifier | null | undefined

/**
 * OpenCode V2 Plugin definition for opencode-pty.
 * Conforms to the V2 Plugin.define({ id, setup }) contract.
 */
export const Plugin: PluginV2 = define({
  id: 'opencode-pty',
  setup: async (ctx: PluginContextV2) => {
    const abortController = new AbortController()
    const registrations: Registration[] = []
    let eventConsumer: Promise<void> | undefined
    let cleanupPromise: Promise<void> | undefined

    // opencode v2 plugin contexts are server clients: `ctx.session.prompt`
    // wakes a session with a user prompt, preserving the session's current
    // model by construction. Pre-2.0 hosts without the session domain still
    // load the plugin, but exit notifications are disabled with a visible
    // warning instead of silently never arriving.
    const notifier =
      typeof ctx.session?.prompt === 'function' ? new V2SessionNotifier(ctx.session) : undefined
    if (!notifier) {
      console.warn(
        '[opencode-pty] host does not expose ctx.session.prompt — exit notifications disabled'
      )
    }

    const adapter = createV2Adapter({ notifier })

    if (ctx.tool && typeof ctx.tool.transform === 'function') {
      const registration = await ctx.tool.transform((draft) => {
        registerV2Tools(draft)
      })
      if (registration) registrations.push(registration)
    }

    if (ctx.command && typeof ctx.command.transform === 'function') {
      const registration = await ctx.command.transform((draft) => {
        registerV2Commands(draft, ctx.options as OpencodePtyOptions | undefined)
      })
      if (registration) registrations.push(registration)
    }

    if (ctx.event && typeof ctx.event.subscribe === 'function') {
      eventConsumer = (async () => {
        try {
          const events = ctx.event?.subscribe({ signal: abortController.signal })
          if (!events) return

          const eventIterator: AsyncIterator<V2Event> = events[Symbol.asyncIterator]()
          while (true) {
            const result = await eventIterator.next()
            if (result.done) break

            const event = result.value
            if (event.type === 'session.deleted' && typeof event.data?.sessionID === 'string') {
              adapter.onSessionDeleted?.(event.data.sessionID)
            }
          }
        } catch (error) {
          if (!abortController.signal.aborted && !isAbortError(error)) {
            console.error('[opencode-pty] V2 event subscription failed', error)
          }
        }
      })()
    }

    if (ctx.options?.autostart) {
      await getOrCreateServer({
        port: ctx.options.port,
        hostname: ctx.options.hostname,
      })
    }

    if (notifier) activateNotifier(notifier)
    installHostAdapter(adapter)

    return () => {
      if (cleanupPromise) return cleanupPromise

      cleanupPromise = (async () => {
        abortController.abort()

        const cleanupTasks: Promise<unknown>[] = []
        if (eventConsumer) cleanupTasks.push(eventConsumer)
        for (const registration of registrations) {
          cleanupTasks.push(Promise.resolve().then(() => registration.dispose()))
        }

        try {
          if (notifier) {
            deactivateNotifier(notifier)
          }
        } catch (error) {
          console.error('[opencode-pty] failed to reset notifier during cleanup', error)
        }
        try {
          manager.clearAllSessions()
        } catch (error) {
          console.error('[opencode-pty] failed to clear PTY sessions during cleanup', error)
        }
        try {
          stopActiveServer()
        } catch (error) {
          console.error('[opencode-pty] failed to stop web server during cleanup', error)
        }

        const results = await Promise.allSettled(cleanupTasks)
        for (const result of results) {
          if (result.status === 'rejected' && !isAbortError(result.reason)) {
            console.error('[opencode-pty] V2 registration cleanup failed', result.reason)
          }
        }
      })()

      return cleanupPromise
    }
  },
})

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function activateNotifier(notifier: V2SessionNotifier): void {
  if (activeNotifiers.length === 0) displacedNotifier = manager.getNotifier()
  activeNotifiers.push(notifier)
}

function deactivateNotifier(notifier: V2SessionNotifier): void {
  const notifierIndex = activeNotifiers.lastIndexOf(notifier)
  if (notifierIndex !== -1) activeNotifiers.splice(notifierIndex, 1)

  if (manager.getNotifier() === notifier) {
    manager.setNotifier(activeNotifiers.at(-1) ?? displacedNotifier ?? null)
  }
  if (activeNotifiers.length === 0) displacedNotifier = undefined
}

export default Plugin
