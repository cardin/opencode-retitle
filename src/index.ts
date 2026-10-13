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
  id: "opencode-retitle",
  async setup(ctx) {
    const config = loadConfig({ options: ctx.options })

    const log = (message: string, detail?: unknown): void => {
      if (!config.debug && detail === undefined) return
      const suffix = detail === undefined ? "" : ` (${describe(detail)})`
      if (detail === undefined) console.log(`[opencode-retitle] ${message}`)
      else console.error(`[opencode-retitle] ${message}${suffix}`)
    }

    const store = new StateStore(ctx.storage as unknown as StorageLike)

    // The built-in title generator's "in flight" marker lives in shared storage,
    // never in memory. OpenCode instantiates one plugin per open location and
    // delivers every event to every instance, so an instance that did not serve
    // the title request would otherwise see the generated rename with no marker
    // and lock the session as a manual rename.
    await ctx.session.hook("title", async (event) => {
      try {
        await store.markBuiltinPending(event.sessionID)
      } catch (error) {
        log("could not record built-in title generation", error)
      }
    })

    const coordinator = new RetitleCoordinator({
      config,
      store,
      log,
      isBuiltinPending: (sessionID) => store.isBuiltinPending(sessionID),
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

    // OpenCode loads one plugin instance per open location and streams every
    // event to all of them, so ignore events that belong to another directory.
    const isOurLocation = (event: OpenCodeEvent): boolean => {
      const there = (event as { location?: { directory?: string; workspaceID?: string } }).location
      if (there?.directory === undefined) return true
      if (there.directory !== ctx.location.directory) return false
      return (
        there.workspaceID === undefined ||
        ctx.location.workspaceID === undefined ||
        there.workspaceID === ctx.location.workspaceID
      )
    }

    const handle = async (event: OpenCodeEvent): Promise<void> => {
      if (!isOurLocation(event)) return
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
