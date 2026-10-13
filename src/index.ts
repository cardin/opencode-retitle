import { Plugin } from "@opencode/plugin"

import { loadConfig } from "./config.ts"
import { Retitle as RetitleRpc } from "./rpc.ts"
import { RetitleCoordinator, formatStatus, type ModelRef } from "./retitle.ts"
import { StateStore, type StorageLike } from "./state.ts"
import type { TranscriptMessage } from "./titles.ts"

type Context = Plugin.Context
type SessionMessage = Awaited<ReturnType<Context["session"]["context"]>>[number]
type OpenCodeEvent =
  ReturnType<Context["event"]["subscribe"]> extends AsyncIterable<infer Event> ? Event : never

/** How long a built-in title generation stays attributable to OpenCode. */
const BUILTIN_TTL_MS = 120_000

function toTranscript(messages: readonly SessionMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  for (const message of messages) {
    if (message.type === "user") {
      out.push({ role: "user", text: message.text })
      continue
    }
    if (message.type === "assistant") {
      let text = ""
      for (const part of message.content) {
        if (part.type === "text") text += part.text
      }
      out.push({ role: "assistant", text })
      continue
    }
    if (message.type === "compaction") {
      out.push({ role: "other", text: "summary" in message ? message.summary : "" })
    }
  }
  return out
}

function describe(detail: unknown): string {
  if (detail instanceof Error) return detail.message
  if (typeof detail === "string") return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

export default Plugin.define({
  id: "retitle",
  async setup(ctx) {
    const config = loadConfig({
      directory: ctx.location.directory,
      options: ctx.options,
    })

    const log = (message: string, detail?: unknown): void => {
      if (!config.debug && detail === undefined) return
      const suffix = detail === undefined ? "" : ` (${describe(detail)})`
      if (detail === undefined) console.log(`[retitle] ${message}`)
      else console.error(`[retitle] ${message}${suffix}`)
    }

    const store = new StateStore(ctx.storage as unknown as StorageLike)

    // Sessions whose built-in title generation is currently in flight, so the
    // resulting rename is not mistaken for a manual one.
    const builtinPending = new Map<string, number>()
    const isBuiltinPending = (sessionID: string): boolean => {
      const at = builtinPending.get(sessionID)
      if (at === undefined) return false
      if (Date.now() - at >= BUILTIN_TTL_MS) {
        builtinPending.delete(sessionID)
        return false
      }
      return true
    }
    const clearBuiltinPending = (sessionID: string): void => {
      builtinPending.delete(sessionID)
    }
    await ctx.session.hook("title", (event) => {
      builtinPending.set(event.sessionID, Date.now())
    })

    const coordinator = new RetitleCoordinator({
      config,
      store,
      log,
      isBuiltinPending,
      clearBuiltinPending,
      async readTranscript(sessionID) {
        return toTranscript(await ctx.session.context({ sessionID }))
      },
      async readSession(sessionID) {
        const info = await ctx.session.get({ sessionID })
        return { title: info.title, model: info.model }
      },
      async generateTitle({ model, prompt }) {
        const result = await ctx.generate.text({
          model: { providerID: model.providerID, id: model.id, variant: model.variant },
          prompt,
        })
        return result.text
      },
      async applyTitle(sessionID, title) {
        await ctx.session.update({ sessionID, title })
      },
    })

    await ctx.rpc.register(RetitleRpc, {
      status: async (input) => {
        const { sessionID } = input as { sessionID: string }
        const [state, info] = await Promise.all([
          coordinator.inspect(sessionID),
          ctx.session.get({ sessionID }),
        ])
        return { text: formatStatus(state, config, info.title) }
      },
      enable: async (input) => {
        const { sessionID } = input as { sessionID: string }
        const { wasLocked } = await coordinator.enable(sessionID)
        const info = await ctx.session.get({ sessionID })
        const title = info.title === undefined ? "" : ` — title is now "${info.title}"`
        return {
          text: wasLocked
            ? `Retitling re-enabled${title}.`
            : `Retitling was already active${title}.`,
        }
      },
    })

    void store.prune().catch(() => undefined)

    const controller = new AbortController()
    const handle = async (event: OpenCodeEvent): Promise<void> => {
      switch (event.type) {
        case "session.created":
          await coordinator.onSessionCreated(event.data.sessionID)
          break
        case "session.renamed":
          await coordinator.onRenamed(event.data.sessionID, event.data.title)
          break
        case "session.inbox.enqueued":
          if (event.data.item.type === "user") {
            await coordinator.onUserPrompt(event.data.sessionID)
          }
          break
        case "session.compaction.ended":
          await coordinator.onCompactionEnded(event.data.sessionID)
          break
        case "session.forked":
          await coordinator.onForked(event.data.sessionID)
          break
        case "session.step.ended":
          await coordinator.onStepEnded(event.data.sessionID)
          break
        default:
          break
      }
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            await handle(event)
          } catch (error) {
            log(`failed to handle ${event.type}`, error)
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) log("event stream ended", error)
      }
    })()

    return () => {
      controller.abort()
    }
  },
})
