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
      // The summary is often the only content left after compaction. Keep it in
      // the transcript so the post-compaction retitle still has something to
      // work with; it never counts as user text.
      out.push({ role: "compaction", text: "summary" in message ? message.summary : "" })
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

    const store = new StateStore(ctx.storage as unknown as StorageLike, config.builtinGraceMs)

    // The built-in title generator's "in flight" marker lives in shared storage,
    // never in memory. OpenCode instantiates one plugin per open location and
    // delivers every event to every instance, so an instance that did not serve
    // the title request would otherwise see the generated rename with no marker
    // and lock the session as a manual rename.
    //
    // The marker is refreshed when the title request's response arrives, which
    // is what lets the grace window stay short: a slow or rate-limited model
    // can take minutes, but the rename follows the response, not the start.
    const markBuiltin = async (sessionID: string, phase: string): Promise<void> => {
      try {
        await store.markBuiltinPending(sessionID)
      } catch (error) {
        log(`could not record built-in title ${phase}`, error)
      }
    }
    await ctx.session.hook("title", async (event) => {
      await markBuiltin(event.sessionID, "generation")
    })
    try {
      await ctx.session.hook("http.response", async (event) => {
        // A failed title request cannot publish a rename; only a successful
        // response starts the short window that ends with the rename.
        if (event.kind !== "title" || !event.response.ok) return
        await markBuiltin(event.sessionID, "response")
      })
    } catch (error) {
      // Older hosts do not expose this hook; the title-start marker remains.
      log("could not record built-in title completion", error)
    }

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
        return { title: info.title, model: info.model, parentID: info.parentID }
      },
      async generateTitle({ model, prompt }) {
        // OpenCode 2.2 deprecates `ctx.generate` in favour of
        // `ctx.experimental.generate`. Prefer the new location when the running
        // build provides it, and keep the old one as an optional fallback for
        // 2.0/2.1. Neither is assumed to exist at runtime.
        type GenerateText = (input: {
          model: { providerID: string; id: string; variant?: string }
          prompt: string
        }) => Promise<{ text: string }>
        const experimental = (
          ctx as unknown as {
            experimental?: { generate?: { text?: GenerateText } }
          }
        ).experimental
        const legacy = (ctx as unknown as { generate?: { text?: GenerateText } }).generate
        const generateText = experimental?.generate?.text ?? legacy?.text
        if (!generateText) throw new Error("no title generation API is available")
        const result = await generateText({
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
        const { wasLocked, outcome } = await coordinator.enable(sessionID)
        const info = await ctx.session.get({ sessionID })
        const title = outcome.applied
          ? info.title === undefined
            ? ""
            : ` — title is now "${info.title}"`
          : ` — no title generated: ${outcome.reason}`
        return {
          text: wasLocked
            ? `Retitling re-enabled${title}.`
            : `Retitling was already active${title}.`,
        }
      },
    })

    void store.prune().catch(() => undefined)

    const controller = new AbortController()

    // Ignore text/tool deltas and every other event as early as possible; only
    // these types can change a title or the retitle schedule.
    const HANDLED_EVENTS = new Set<string>([
      "session.created",
      "session.renamed",
      "session.inbox.enqueued",
      "session.execution.succeeded",
      "session.compaction.ended",
      "session.forked",
    ])

    const sameLocation = (there: {
      directory?: string
      workspaceID?: string
    }): boolean => {
      if (there.directory !== ctx.location.directory) return false
      return (
        there.workspaceID === undefined ||
        ctx.location.workspaceID === undefined ||
        there.workspaceID === ctx.location.workspaceID
      )
    }

    // OpenCode loads one plugin instance per open location and streams every
    // event to all of them, so ignore events that belong to another directory.
    // Some events omit `location`; resolve the owning session instead of
    // assuming every instance owns it.
    const isOurLocation = async (event: OpenCodeEvent): Promise<boolean> => {
      const there = (event as { location?: { directory?: string; workspaceID?: string } }).location
      if (there?.directory !== undefined) return sameLocation(there)

      const data = (event as { data?: { sessionID?: unknown } }).data
      const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
      if (sessionID === undefined) return true

      try {
        const info = await ctx.session.get({ sessionID })
        const sessionLocation = info.location as
          | { directory?: string; workspaceID?: string }
          | undefined
        if (sessionLocation?.directory !== undefined) return sameLocation(sessionLocation)
      } catch (error) {
        log(`could not resolve location for session ${sessionID}`, error)
      }
      // Older servers may not expose a location; keep the previous permissive
      // behaviour rather than dropping the event entirely.
      return true
    }

    const handle = async (event: OpenCodeEvent): Promise<void> => {
      if (!HANDLED_EVENTS.has(event.type)) return
      if (!(await isOurLocation(event))) return
      switch (event.type) {
        case "session.created":
          await coordinator.onSessionCreated(event.data.sessionID, event.data.parentID)
          break
        case "session.renamed":
          await coordinator.onRenamed(event.data.sessionID, event.data.title)
          break
        case "session.inbox.enqueued":
          if (event.data.item.type === "user") {
            await coordinator.onUserPrompt(event.data.sessionID)
          }
          break
        case "session.execution.succeeded":
          await coordinator.onExecutionSucceeded(event.data.sessionID)
          break
        case "session.compaction.ended":
          await coordinator.onCompactionEnded(event.data.sessionID)
          break
        case "session.forked":
          await coordinator.onForked(event.data.sessionID)
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
