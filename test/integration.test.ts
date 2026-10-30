import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { after } from "node:test"

import plugin from "../src/index.ts"

type AnyEvent = {
  type: string
  data: Record<string, unknown>
  location?: { directory?: string; workspaceID?: string }
}

function createQueue() {
  const buffer: AnyEvent[] = []
  let wake: (() => void) | undefined
  let closed = false
  return {
    push(event: AnyEvent) {
      buffer.push(event)
      wake?.()
      wake = undefined
    },
    close() {
      closed = true
      wake?.()
      wake = undefined
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<AnyEvent> {
      while (true) {
        const next = buffer.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (closed) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    },
  }
}

interface Harness {
  push(event: AnyEvent): void
  /** Deliver all enqueued user prompts plus one assistant reply, then finish the run. */
  deliverResponse(reply?: string): void
  updates: string[]
  prompts: string[]
  synthetic: string[]
  syntheticCalls: Array<{ text: string; resume?: boolean }>
  commandNames: string[]
  rpc: {
    status(input: { sessionID: string }): Promise<{ text: string }>
    enable(input: { sessionID: string }): Promise<{ text: string }>
  }
  completeTitleHook(): Promise<void>
  completeTitleResponse(status?: number): Promise<void>
  builtinMarkerAt(): number | undefined
  settle(): Promise<void>
  dispose(): Promise<void>
}

const openHarnesses: Harness[] = []
after(async () => {
  for (const harness of openHarnesses) await harness.dispose()
})

async function settle(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function createHarness(
  options: Record<string, unknown> = {},
  setupOptions: {
    initialTitle?: string
    priorUserMessages?: number
    /** Replace the seeded delivered transcript (for compaction-only tests). */
    messages?: unknown[]
    /** Delay title generation so a test can interleave a rename. */
    generateDelayMs?: number
    /** Use only the deprecated `ctx.generate` fallback. */
    legacyGenerate?: boolean
    /** Share one storage map between harnesses to model OpenCode's per-location instances. */
    storage?: Map<string, unknown>
    sessionID?: string
    directory?: string
    /** Where the session itself lives, when it differs from the plugin location. */
    sessionDirectory?: string
    parentID?: string | null
  } = {},
): Promise<Harness> {
  const queue = createQueue()
  const updates: string[] = []
  const prompts: string[] = []
  const synthetic: string[] = []
  const syntheticCalls: Array<{ text: string; resume?: boolean }> = []
  const commandNames: string[] = []
  const rpcHandlers: Record<
    string,
    (input: unknown, context: unknown) => Promise<unknown>
  > = {}
  const storageData = setupOptions.storage ?? new Map<string, unknown>()
  const sessionID = setupOptions.sessionID ?? "ses_test"
  const priorUserMessages = setupOptions.priorUserMessages ?? 1
  const directory = setupOptions.directory ?? mkdtempSync(join(tmpdir(), "retitle-ctx-"))
  const sessionDirectory = setupOptions.sessionDirectory ?? directory

  let title = setupOptions.initialTitle ?? "New session - 2026-10-13T09:52:00.000Z"
  const hooks = new Map<string, (event: Record<string, unknown>) => unknown>()
  let titleCounter = 0

  // Only messages that have actually been delivered are visible through
  // `session.context()`. An enqueued prompt is not part of the transcript yet.
  const enqueuedTexts: string[] = []
  const delivered: unknown[] =
    setupOptions.messages === undefined
      ? [
          ...Array.from({ length: priorUserMessages }, () => ({
            type: "user",
            text: "please add a retitle plugin for sessions",
          })),
          { type: "assistant", content: [{ type: "text", text: "sure" }] },
        ]
      : [...setupOptions.messages]

  const generateText = async (input: { prompt: string }) => {
    prompts.push(input.prompt)
    if (setupOptions.generateDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, setupOptions.generateDelayMs))
    }
    titleCounter += 1
    return { text: `Generated title ${titleCounter}` }
  }

  const ctx = {
    location: {
      directory,
    },
    options,
    storage: {
      async get(key: string) {
        return storageData.get(key)
      },
      async set(key: string, value: unknown) {
        storageData.set(key, value)
      },
      async remove(key: string) {
        storageData.delete(key)
      },
      async scan(input: { prefix: string; limit?: number }) {
        const entries = [...storageData.entries()]
          .filter(([key]) => key.startsWith(input.prefix))
          .map(([key, value]) => ({ key, value }))
        return { entries }
      },
    },
    session: {
      async hook(name: string, callback: (event: Record<string, unknown>) => unknown) {
        hooks.set(name, callback)
        return { dispose: async () => undefined }
      },
      async context() {
        return delivered
      },
      async get() {
        return {
          title,
          model: { providerID: "openai", id: "gpt-5" },
          parentID: setupOptions.parentID,
          location: { directory: sessionDirectory },
        }
      },
      async update(input: { sessionID: string; title: string }) {
        title = input.title
        updates.push(input.title)
        queue.push({ type: "session.renamed", data: { sessionID, title } })
      },
      async synthetic(input: { text: string; resume?: boolean }) {
        syntheticCalls.push(input)
        synthetic.push(input.text)
      },
    },
    experimental: setupOptions.legacyGenerate ? undefined : { generate: { text: generateText } },
    generate: {
      text: setupOptions.legacyGenerate
        ? generateText
        : async () => {
            throw new Error("deprecated generate must not be used when experimental exists")
          },
    },
    command: {
      async transform(callback: (editor: { add: (definition: { name: string; execute: (input: { sessionID: string }) => Promise<void> }) => void }) => void) {
        callback({
          add: (definition) => {
            commandNames.push(definition.name)
          },
        })
        return { dispose: async () => undefined }
      },
    },
    rpc: {
      async register(
        _definition: unknown,
        handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>>,
      ) {
        Object.assign(rpcHandlers, handlers)
        return { dispose: async () => undefined, events: { emit: async () => undefined } }
      },
    },
    event: {
      subscribe(input?: { signal?: AbortSignal }) {
        const signal = input?.signal
        if (signal) {
          if (signal.aborted) queue.close()
          else signal.addEventListener("abort", () => queue.close(), { once: true })
        }
        return queue[Symbol.asyncIterator]()
      },
    },
  }

  const cleanup = await plugin.setup(ctx as never)

  const callRpc = (
    name: string,
    input: { sessionID: string },
  ): Promise<{ text: string }> => {
    const handler = rpcHandlers[name]
    if (!handler) throw new Error(`rpc method ${name} is not registered`)
    return handler(input, { signal: new AbortController().signal }) as Promise<{ text: string }>
  }

  const harness: Harness = {
    push(event) {
      if (
        event.type === "session.inbox.enqueued" &&
        (event.data.item as { type?: string } | undefined)?.type === "user"
      ) {
        const text = (event.data.item as { payload?: { text?: string } }).payload?.text
        if (typeof text === "string") enqueuedTexts.push(text)
      }
      queue.push(event)
    },
    deliverResponse(reply = "sure") {
      for (const text of enqueuedTexts.splice(0)) delivered.push({ type: "user", text })
      delivered.push({ type: "assistant", content: [{ type: "text", text: reply }] })
      queue.push({ type: "session.execution.succeeded", data: { sessionID } })
    },
    updates,
    prompts,
    synthetic,
    syntheticCalls,
    commandNames,
    rpc: {
      status: (input) => callRpc("status", input),
      enable: (input) => callRpc("enable", input),
    },
    completeTitleHook: async () => {
      await hooks.get("title")?.({ sessionID })
    },
    completeTitleResponse: async (status = 200) => {
      await hooks.get("http.response")?.({
        sessionID,
        kind: "title",
        response: new Response("{}", { status }),
      })
    },
    builtinMarkerAt: () => {
      const marker = storageData.get(`builtin/${sessionID}`) as { at?: unknown } | undefined
      return typeof marker?.at === "number" ? marker.at : undefined
    },
    async settle() {
      await new Promise((resolve) => setTimeout(resolve, 20))
    },
    async dispose() {
      await cleanup?.()
      queue.close()
    },
  }

  openHarnesses.push(harness)
  return harness
}

function userPrompt(sessionID = "ses_test"): AnyEvent {
  return {
    type: "session.inbox.enqueued",
    data: { sessionID, item: { type: "user", payload: { text: "do the thing" } } },
  }
}

test("retitles after the configured number of turns", async () => {
  const harness = await createHarness({ turns: 3, minPromptLength: 0 }, { priorUserMessages: 0 })

  harness.push(userPrompt())
  harness.deliverResponse()
  harness.push(userPrompt())
  harness.deliverResponse()
  await harness.settle()
  assert.equal(harness.updates.length, 0)

  harness.push(userPrompt())
  await harness.settle()
  assert.equal(
    harness.updates.length,
    0,
    "an enqueued prompt is not in the transcript yet; wait for its response",
  )

  harness.deliverResponse()
  await settle(() => harness.updates.length === 1)
  assert.deepEqual(harness.updates, ["Generated title 1"])
  assert.ok(harness.prompts[0]?.includes("User: do the thing"), "the triggering prompt is included")
  assert.ok(harness.prompts[0]?.includes("Assistant: sure"), "the response is included")
})

test("repeats every N turns", async () => {
  const harness = await createHarness({ turns: 2, minPromptLength: 0 }, { priorUserMessages: 0 })
  for (let i = 0; i < 2; i += 1) {
    harness.push(userPrompt())
    harness.deliverResponse()
  }
  await settle(() => harness.updates.length === 1)
  for (let i = 0; i < 2; i += 1) {
    harness.push(userPrompt())
    harness.deliverResponse()
  }
  await settle(() => harness.updates.length === 2)
  assert.deepEqual(harness.updates, ["Generated title 1", "Generated title 2"])
})

test("resets the turn interval after a retitle", async () => {
  // turns = 3, so the schedule is measured from each rename, not from session start.
  const harness = await createHarness({ turns: 3, minPromptLength: 0 }, { priorUserMessages: 0 })

  harness.push(userPrompt()) // 1
  harness.deliverResponse()
  harness.push({ type: "session.compaction.ended", data: { sessionID: "ses_test" } })
  await settle(() => harness.updates.length === 1)

  harness.push(userPrompt()) // 1 since the compaction retitle
  harness.deliverResponse()
  harness.push(userPrompt()) // 2
  harness.deliverResponse()
  await harness.settle()
  assert.equal(harness.updates.length, 1, "two prompts must not reach the interval")

  harness.push(userPrompt()) // 3
  harness.deliverResponse()
  await settle(() => harness.updates.length === 2)
})

test("locks a session whose title predates the plugin", async () => {
  const harness = await createHarness(
    { turns: 1 },
    { initialTitle: "Hand written before the plugin loaded" },
  )

  harness.push(userPrompt())
  harness.deliverResponse()
  await harness.settle()
  assert.equal(harness.updates.length, 0)

  const enabled = await harness.rpc.enable({ sessionID: "ses_test" })
  assert.match(enabled.text, /re-enabled/)
  assert.equal(harness.updates.length, 1)
})

test("does not lock a pre-existing title when lockExistingTitles is false", async () => {
  const harness = await createHarness(
    { turns: 1, lockExistingTitles: false },
    { initialTitle: "Titled before the plugin loaded" },
  )

  harness.push(userPrompt())
  harness.deliverResponse()
  await settle(() => harness.updates.length === 1)
  assert.equal(harness.updates.length, 1)
})

test("retitles after a compaction completes", async () => {
  const harness = await createHarness({})
  harness.push({ type: "session.compaction.ended", data: { sessionID: "ses_test" } })
  await settle(() => harness.updates.length === 1)
  assert.equal(harness.updates.length, 1)
})

test("uses the compaction summary when it is the only transcript content", async () => {
  // After compaction the visible context is often just the summary. It must be
  // part of the title prompt and must satisfy the minimum-text guard.
  const harness = await createHarness(
    { minPromptLength: 10 },
    {
      messages: [
        {
          type: "compaction",
          summary: "A long discussion about provider state and retitling sessions",
        },
      ],
    },
  )
  harness.push({ type: "session.compaction.ended", data: { sessionID: "ses_test" } })
  await settle(() => harness.updates.length === 1)
  assert.ok(harness.prompts[0]?.includes("Summary: A long discussion"))
})

test("retitles after the first completed response in a forked session", async () => {
  const harness = await createHarness({})
  harness.push({ type: "session.forked", data: { sessionID: "ses_test", parentID: "ses_parent" } })
  harness.push({ type: "session.step.ended", data: { sessionID: "ses_test" } })
  await harness.settle()
  assert.equal(harness.updates.length, 0, "a tool step must not fire the fork retitle")

  harness.deliverResponse()
  await settle(() => harness.updates.length === 1)
  assert.equal(harness.updates.length, 1)
})

test("pauses retitling after a manual rename and resumes on /retitle-enable", async () => {
  const harness = await createHarness({ turns: 1 })

  harness.push({ type: "session.renamed", data: { sessionID: "ses_test", title: "My own title" } })
  await harness.settle()

  harness.push(userPrompt())
  harness.deliverResponse()
  await harness.settle()
  assert.equal(harness.updates.length, 0)

  const enabled = await harness.rpc.enable({ sessionID: "ses_test" })
  assert.match(enabled.text, /re-enabled/)
  assert.equal(harness.updates.length, 1)
})

test("a manual rename during title generation is not overwritten", async () => {
  // The model call takes long enough for the rename event to be delivered
  // while the run is in flight. The run must re-check the title and lock
  // instead of applying its older generation.
  const harness = await createHarness(
    { turns: 1, minPromptLength: 0 },
    { generateDelayMs: 100, priorUserMessages: 0 },
  )

  harness.push(userPrompt())
  harness.deliverResponse()
  await new Promise((resolve) => setTimeout(resolve, 20))
  harness.push({
    type: "session.renamed",
    data: { sessionID: "ses_test", title: "My own title" },
  })
  await new Promise((resolve) => setTimeout(resolve, 200))

  assert.equal(harness.updates.length, 0, "the in-flight title must not win")

  const status = await harness.rpc.status({ sessionID: "ses_test" })
  assert.match(status.text, /^Title origin: manual \/ external$/m)
})

test("does not lock a session whose title is still empty", async () => {
  const harness = await createHarness(
    { turns: 1, minPromptLength: 0 },
    { initialTitle: "", priorUserMessages: 0 },
  )

  harness.push(userPrompt())
  harness.deliverResponse()
  await settle(() => harness.updates.length === 1)
  assert.equal(harness.updates.length, 1)
})

test("a blank rename never locks the session", async () => {
  const harness = await createHarness({ turns: 1, minPromptLength: 0 }, { priorUserMessages: 0 })

  harness.push({ type: "session.renamed", data: { sessionID: "ses_test", title: "   " } })
  await harness.settle()

  harness.push(userPrompt())
  harness.deliverResponse()
  await settle(() => harness.updates.length === 1)
  assert.equal(harness.updates.length, 1)
})

test("does not lock when the built-in generator produced the title", async () => {
  const harness = await createHarness({ turns: 1 })

  await harness.completeTitleHook()
  harness.push({ type: "session.renamed", data: { sessionID: "ses_test", title: "Auto generated" } })
  await harness.settle()

  harness.push(userPrompt())
  harness.deliverResponse()
  await settle(() => harness.updates.length === 1)
  assert.equal(harness.updates.length, 1)
})

test("our own rename does not consume the built-in attribution", async () => {
  const harness = await createHarness({ turns: 1 })

  // Built-in generation starts, then our retitle fires and renames before it finishes.
  await harness.completeTitleHook()
  harness.push(userPrompt())
  harness.deliverResponse()
  await settle(() => harness.updates.length === 1)

  // The built-in title arrives afterwards and must still be attributed to OpenCode.
  harness.push({ type: "session.renamed", data: { sessionID: "ses_test", title: "Auto generated" } })
  await harness.settle()

  harness.push(userPrompt())
  harness.deliverResponse()
  await settle(() => harness.updates.length === 2)
  assert.equal(harness.updates.length, 2)
})

test("server half exposes RPC and queues nothing", async () => {
  const harness = await createHarness({})

  const status = await harness.rpc.status({ sessionID: "ses_test" })
  assert.match(status.text, /Title origin:/)
  assert.ok(!status.text.includes("**"), "toasts do not render markdown")

  await harness.rpc.enable({ sessionID: "ses_test" })

  // No server commands and no synthetic output: reports go to the TUI over RPC.
  assert.deepEqual(harness.commandNames, [])
  assert.equal(harness.syntheticCalls.length, 0)
})

test("an instance that did not serve the title request still attributes the rename", async () => {
  // OpenCode runs one plugin instance per open location and delivers every
  // event to all of them, so the built-in marker has to be shared. Otherwise
  // the instances that never saw the title hook lock the session.
  const storage = new Map<string, unknown>()
  const sessionID = "ses_shared"
  const owner = await createHarness({ turns: 1 }, { storage, sessionID, priorUserMessages: 0 })
  const observer = await createHarness({ turns: 1 }, { storage, sessionID, priorUserMessages: 0 })

  await owner.completeTitleHook()
  const renamed: AnyEvent = {
    type: "session.renamed",
    data: { sessionID, title: "Generated by OpenCode" },
  }
  owner.push(renamed)
  observer.push(renamed)
  await owner.settle()
  await observer.settle()

  const stored = storage.get("session/" + sessionID) as
    | { locked: boolean; baseline?: string }
    | undefined
  assert.equal(stored?.locked, false)
  assert.equal(stored?.baseline, "Generated by OpenCode")

  const status = await observer.rpc.status({ sessionID })
  assert.doesNotMatch(status.text, /manual/)
})

test("another instance recognises our retitle as self instead of locking", async () => {
  // The observer's cache is stale before the owner writes. It must re-read
  // shared state when the rename arrives, or it classifies our own write as a
  // manual rename and disables retitling for the session.
  const storage = new Map<string, unknown>()
  const sessionID = "ses_cross"
  const owner = await createHarness(
    { turns: 1, minPromptLength: 0 },
    { storage, sessionID, priorUserMessages: 0 },
  )
  const observer = await createHarness(
    { turns: 1, minPromptLength: 0 },
    { storage, sessionID, priorUserMessages: 0 },
  )

  await observer.rpc.status({ sessionID }) // populate the observer's stale cache

  owner.push(userPrompt(sessionID))
  owner.deliverResponse()
  await settle(() => owner.updates.length === 1)

  observer.push({
    type: "session.renamed",
    data: { sessionID, title: owner.updates[0] },
  })
  await observer.settle()

  const stored = storage.get("session/" + sessionID) as { locked: boolean } | undefined
  assert.equal(stored?.locked, false)
  const status = await observer.rpc.status({ sessionID })
  assert.doesNotMatch(status.text, /manual/)
})

test("skips subagent sessions detected from the session info", async () => {
  const harness = await createHarness(
    { turns: 1, minPromptLength: 0 },
    { priorUserMessages: 0, parentID: "ses_parent" },
  )

  harness.push(userPrompt())
  harness.deliverResponse()
  await harness.settle()
  assert.equal(harness.updates.length, 0)

  const status = await harness.rpc.status({ sessionID: "ses_test" })
  assert.match(status.text, /^Retitling: disabled \(subagent session\)$/m)

  const enabled = await harness.rpc.enable({ sessionID: "ses_test" })
  assert.match(enabled.text, /no title generated: subagent session/)
  assert.equal(harness.updates.length, 0)
})

test("skips a child announced by session.created", async () => {
  const harness = await createHarness(
    { turns: 1, minPromptLength: 0 },
    { priorUserMessages: 0 },
  )

  harness.push({
    type: "session.created",
    data: { sessionID: "ses_test", parentID: "ses_parent" },
  })
  await harness.settle()

  harness.push(userPrompt())
  harness.deliverResponse()
  await harness.settle()
  assert.equal(harness.updates.length, 0)
})

test("queues a compaction retitle that arrives during a turn retitle", async () => {
  const harness = await createHarness(
    { turns: 1, minPromptLength: 0 },
    { priorUserMessages: 0, generateDelayMs: 100 },
  )

  harness.push(userPrompt())
  harness.deliverResponse()
  await new Promise((resolve) => setTimeout(resolve, 20))

  harness.push({ type: "session.compaction.ended", data: { sessionID: "ses_test" } })
  await settle(() => harness.updates.length === 2, 3000)
  assert.equal(harness.prompts.length, 2, "the coalesced compaction run is not dropped")
})

test("falls back to the deprecated generate API when experimental is absent", async () => {
  const harness = await createHarness(
    { turns: 1, minPromptLength: 0 },
    { priorUserMessages: 0, legacyGenerate: true },
  )

  harness.push(userPrompt())
  harness.deliverResponse()
  await settle(() => harness.updates.length === 1)
  assert.equal(harness.updates.length, 1)
})

test("ignores events that belong to another location", async () => {
  const harness = await createHarness({ turns: 1 }, { priorUserMessages: 0 })

  harness.push({
    type: "session.renamed",
    data: { sessionID: "ses_test", title: "Renamed in another directory" },
    location: { directory: "/somewhere/else" },
  })
  await harness.settle()

  const status = await harness.rpc.status({ sessionID: "ses_test" })
  assert.doesNotMatch(status.text, /manual/)
})

test("resolves a missing event location from the session", async () => {
  const elsewhere = mkdtempSync(join(tmpdir(), "retitle-other-"))
  const harness = await createHarness(
    { turns: 1 },
    { priorUserMessages: 0, sessionDirectory: elsewhere },
  )

  harness.push({
    type: "session.renamed",
    data: { sessionID: "ses_test", title: "Renamed in another directory" },
  })
  await harness.settle()

  const status = await harness.rpc.status({ sessionID: "ses_test" })
  assert.doesNotMatch(status.text, /manual/)
})

test("handles events that carry our own location", async () => {
  const directory = mkdtempSync(join(tmpdir(), "retitle-loc-"))
  const harness = await createHarness({ turns: 1 }, { priorUserMessages: 0, directory })

  harness.push({
    type: "session.renamed",
    data: { sessionID: "ses_test", title: "Renamed here" },
    location: { directory },
  })
  await harness.settle()

  const status = await harness.rpc.status({ sessionID: "ses_test" })
  assert.match(status.text, /^Title origin: manual \/ external$/m)
})

test("the title response refreshes the built-in marker", async () => {
  const harness = await createHarness({ turns: 0 })
  await harness.completeTitleHook()
  const started = harness.builtinMarkerAt()
  assert.equal(typeof started, "number")

  await new Promise((resolve) => setTimeout(resolve, 20))
  await harness.completeTitleResponse()
  const completed = harness.builtinMarkerAt()
  assert.equal(typeof completed, "number")
  assert.ok(
    (completed as number) > (started as number),
    "the response marker must be newer than the request marker",
  )
})

test("a failed title response does not extend the attribution window", async () => {
  const harness = await createHarness({ turns: 0 })
  await harness.completeTitleHook()
  const started = harness.builtinMarkerAt()
  assert.equal(typeof started, "number")

  await new Promise((resolve) => setTimeout(resolve, 20))
  await harness.completeTitleResponse(429)
  assert.equal(harness.builtinMarkerAt(), started)
})

test("builtinGraceMs controls how long a built-in title stays attributable", async () => {
  const harness = await createHarness({ turns: 1, builtinGraceMs: 0 })

  await harness.completeTitleHook()
  harness.push({ type: "session.renamed", data: { sessionID: "ses_test", title: "Auto generated" } })
  await harness.settle()

  // A zero grace window means the generated rename is no longer ours to attribute.
  const status = await harness.rpc.status({ sessionID: "ses_test" })
  assert.match(status.text, /^Title origin: manual \/ external$/m)
})
