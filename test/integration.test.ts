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
  updates: string[]
  synthetic: string[]
  syntheticCalls: Array<{ text: string; resume?: boolean }>
  commandNames: string[]
  rpc: {
    status(input: { sessionID: string }): Promise<{ text: string }>
    enable(input: { sessionID: string }): Promise<{ text: string }>
  }
  completeTitleHook(): Promise<void>
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
    /** Share one storage map between harnesses to model OpenCode's per-location instances. */
    storage?: Map<string, unknown>
    sessionID?: string
    directory?: string
  } = {},
): Promise<Harness> {
  const queue = createQueue()
  const updates: string[] = []
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

  let title = setupOptions.initialTitle ?? "New session - 2026-10-13T09:52:00.000Z"
  let lastBuiltin: (() => unknown) | undefined
  let titleCounter = 0

  const ctx = {
    location: {
      directory: setupOptions.directory ?? mkdtempSync(join(tmpdir(), "retitle-ctx-")),
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
      async hook(name: string, callback: (event: { sessionID: string }) => void) {
        if (name === "title") lastBuiltin = () => callback({ sessionID })
        return { dispose: async () => undefined }
      },
      async context() {
        const messages: unknown[] = []
        for (let i = 0; i < priorUserMessages; i += 1) {
          messages.push({ type: "user", text: "please add a retitle plugin for sessions" })
        }
        messages.push({ type: "assistant", content: [{ type: "text", text: "sure" }] })
        return messages
      },
      async get() {
        return { title, model: { providerID: "openai", id: "gpt-5" } }
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
    generate: {
      async text() {
        titleCounter += 1
        return { text: `Generated title ${titleCounter}` }
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
    push: (event) => queue.push(event),
    updates,
    synthetic,
    syntheticCalls,
    commandNames,
    rpc: {
      status: (input) => callRpc("status", input),
      enable: (input) => callRpc("enable", input),
    },
    completeTitleHook: async () => {
      await lastBuiltin?.()
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

function userPrompt(): AnyEvent {
  return {
    type: "session.inbox.enqueued",
    data: { sessionID: "ses_test", item: { type: "user", payload: { text: "do the thing" } } },
  }
}

test("retitles after the configured number of turns", async () => {
  const harness = await createHarness({ turns: 3, minPromptLength: 0 }, { priorUserMessages: 0 })

  harness.push(userPrompt())
  harness.push(userPrompt())
  await harness.settle()
  assert.equal(harness.updates.length, 0)

  harness.push(userPrompt())
  await settle(() => harness.updates.length === 1)
  assert.deepEqual(harness.updates, ["Generated title 1"])
})

test("repeats every N turns", async () => {
  const harness = await createHarness({ turns: 2, minPromptLength: 0 }, { priorUserMessages: 0 })
  for (let i = 0; i < 2; i += 1) harness.push(userPrompt())
  await settle(() => harness.updates.length === 1)
  for (let i = 0; i < 2; i += 1) harness.push(userPrompt())
  await settle(() => harness.updates.length === 2)
  assert.deepEqual(harness.updates, ["Generated title 1", "Generated title 2"])
})

test("resets the turn interval after a retitle", async () => {
  // turns = 3, so the schedule is measured from each rename, not from session start.
  const harness = await createHarness({ turns: 3, minPromptLength: 0 }, { priorUserMessages: 0 })

  harness.push(userPrompt()) // 1
  harness.push({ type: "session.compaction.ended", data: { sessionID: "ses_test" } })
  await settle(() => harness.updates.length === 1)

  harness.push(userPrompt()) // 1 since the compaction retitle
  harness.push(userPrompt()) // 2
  await harness.settle()
  assert.equal(harness.updates.length, 1, "two prompts must not reach the interval")

  harness.push(userPrompt()) // 3
  await settle(() => harness.updates.length === 2)
})

test("locks a session whose title predates the plugin", async () => {
  const harness = await createHarness(
    { turns: 1 },
    { initialTitle: "Hand written before the plugin loaded" },
  )

  harness.push(userPrompt())
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
  await settle(() => harness.updates.length === 1)
  assert.equal(harness.updates.length, 1)
})

test("retitles after a compaction completes", async () => {
  const harness = await createHarness({})
  harness.push({ type: "session.compaction.ended", data: { sessionID: "ses_test" } })
  await settle(() => harness.updates.length === 1)
  assert.equal(harness.updates.length, 1)
})

test("retitles after the first response in a forked session", async () => {
  const harness = await createHarness({})
  harness.push({ type: "session.forked", data: { sessionID: "ses_test", parentID: "ses_parent" } })
  harness.push({ type: "session.step.ended", data: { sessionID: "ses_test" } })
  await settle(() => harness.updates.length === 1)
  assert.equal(harness.updates.length, 1)
})

test("pauses retitling after a manual rename and resumes on /retitle-enable", async () => {
  const harness = await createHarness({ turns: 1 })

  harness.push({ type: "session.renamed", data: { sessionID: "ses_test", title: "My own title" } })
  await harness.settle()

  harness.push(userPrompt())
  await harness.settle()
  assert.equal(harness.updates.length, 0)

  const enabled = await harness.rpc.enable({ sessionID: "ses_test" })
  assert.match(enabled.text, /re-enabled/)
  assert.equal(harness.updates.length, 1)
})

test("does not lock when the built-in generator produced the title", async () => {
  const harness = await createHarness({ turns: 1 })

  await harness.completeTitleHook()
  harness.push({ type: "session.renamed", data: { sessionID: "ses_test", title: "Auto generated" } })
  await harness.settle()

  harness.push(userPrompt())
  await settle(() => harness.updates.length === 1)
  assert.equal(harness.updates.length, 1)
})

test("our own rename does not consume the built-in attribution", async () => {
  const harness = await createHarness({ turns: 1 })

  // Built-in generation starts, then our retitle fires and renames before it finishes.
  await harness.completeTitleHook()
  harness.push(userPrompt())
  await settle(() => harness.updates.length === 1)

  // The built-in title arrives afterwards and must still be attributed to OpenCode.
  harness.push({ type: "session.renamed", data: { sessionID: "ses_test", title: "Auto generated" } })
  await harness.settle()

  harness.push(userPrompt())
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

test("builtinGraceMs controls how long a built-in title stays attributable", async () => {
  const harness = await createHarness({ turns: 1, builtinGraceMs: 0 })

  await harness.completeTitleHook()
  harness.push({ type: "session.renamed", data: { sessionID: "ses_test", title: "Auto generated" } })
  await harness.settle()

  // A zero grace window means the generated rename is no longer ours to attribute.
  const status = await harness.rpc.status({ sessionID: "ses_test" })
  assert.match(status.text, /^Title origin: manual \/ external$/m)
})
