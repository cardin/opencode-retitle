import assert from "node:assert/strict"
import test from "node:test"

import { defaultConfig, type RetitleConfig } from "../src/config.ts"
import {
  RetitleCoordinator,
  formatStatus,
  resolveModel,
  titleOrigin,
  type ModelRef,
  type RetitleDeps,
} from "../src/retitle.ts"
import { StateStore, type StorageLike } from "../src/state.ts"
import type { TranscriptMessage } from "../src/titles.ts"

function config(overrides: Partial<RetitleConfig>): RetitleConfig {
  return { ...defaultConfig, ...overrides }
}

function memoryStorage(): StorageLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    async get(key) {
      return data.get(key)
    },
    async set(key, value) {
      data.set(key, value)
    },
    async remove(key) {
      data.delete(key)
    },
    async scan(input) {
      const entries = [...data.entries()]
        .filter(([key]) => key.startsWith(input.prefix))
        .map(([key, value]) => ({ key, value }))
      return { entries }
    },
  }
}

interface CoordinatorHarness {
  coordinator: RetitleCoordinator
  store: StateStore
  storage: StorageLike & { data: Map<string, unknown> }
  title: { value: string | undefined }
  reads: { count: number }
  applied: string[]
  prompts: string[]
  logs: string[]
}

function createCoordinator(
  options: {
    initialTitle?: string
    parentID?: string | null
    transcript?: TranscriptMessage[]
    generate?: (input: { model: ModelRef; prompt: string }) => Promise<string>
    config?: Partial<RetitleConfig>
    storage?: StorageLike & { data: Map<string, unknown> }
  } = {},
): CoordinatorHarness {
  const storage = options.storage ?? memoryStorage()
  const store = new StateStore(storage)
  const title = { value: options.initialTitle ?? "New session - 2026-10-13T09:52:00.000Z" }
  const reads = { count: 0 }
  const applied: string[] = []
  const prompts: string[] = []
  const logs: string[] = []
  const deps: RetitleDeps = {
    config: {
      ...defaultConfig,
      turns: 1,
      minPromptLength: 0,
      ...options.config,
    },
    store,
    async readTranscript() {
      return (
        options.transcript ?? [
          { role: "user", text: "please add a retitle plugin" },
          { role: "assistant", text: "sure" },
        ]
      )
    },
    async readSession() {
      reads.count += 1
      return {
        title: title.value,
        model: { providerID: "openai", id: "gpt-5" },
        parentID: options.parentID,
      }
    },
    async generateTitle(input) {
      prompts.push(input.prompt)
      if (options.generate) return options.generate(input)
      return "Generated title"
    },
    async applyTitle(_sessionID, next) {
      applied.push(next)
      title.value = next
    },
    async isBuiltinPending() {
      return false
    },
    log(message) {
      logs.push(message)
    },
  }
  return {
    coordinator: new RetitleCoordinator(deps),
    store,
    storage,
    title,
    reads,
    applied,
    prompts,
    logs,
  }
}

test("resolveModel prefers the configured model", () => {
  const model = resolveModel(config({ model: "anthropic/claude-sonnet-4-5" }), {
    model: { providerID: "openai", id: "gpt-5" },
  })
  assert.deepEqual(model, { providerID: "anthropic", id: "claude-sonnet-4-5" })
})

test("resolveModel inherits the session model by default", () => {
  const inherited = { providerID: "openai", id: "gpt-5" }
  assert.deepEqual(resolveModel(config({ model: null }), { model: inherited }), inherited)
})

test("resolveModel falls back to the session model when the setting is malformed", () => {
  const inherited = { providerID: "openai", id: "gpt-5" }
  assert.deepEqual(resolveModel(config({ model: "nonsense" }), { model: inherited }), inherited)
})

test("resolveModel returns undefined without any model", () => {
  assert.equal(resolveModel(config({ model: null }), {}), undefined)
})

test("titleOrigin reports the source of the current title", () => {
  assert.equal(titleOrigin({ locked: false, lastWrite: "Mine" }, "Mine"), "opencode-retitle")
  assert.equal(titleOrigin({ locked: false }, "New session - 2026-10-13T09:52:00.000Z"), "auto (default)")
  assert.equal(titleOrigin({ locked: false }, "Parent (fork #1)"), "auto (fork)")
  assert.equal(titleOrigin({ locked: false, baseline: "Generated thing" }, "Generated thing"), "auto (generated)")
  assert.equal(titleOrigin({ locked: false }, "Something else"), "external")
  assert.equal(titleOrigin({ locked: true }, "Mine"), "manual / external")
  assert.equal(titleOrigin({ locked: false }), "unknown")
})

test("formatStatus is short and plain text", () => {
  const text = formatStatus(
    { turns: 4, locked: true, forkPending: false, baseline: "OpenCode Session Auto-Renamer" },
    defaultConfig,
    "OpenCode Session Auto-Renamer",
  )
  assert.ok(!text.includes("**"))
  assert.ok(!text.includes("Config:"))
  assert.ok(!text.includes("Baseline"))
  assert.match(text, /^Title origin: manual \/ external$/m)
  assert.match(text, /^Retitling: paused \(run \/retitle-enable\)$/m)
  assert.match(text, /^Turns since retitle: 4 of 5$/m)
  assert.equal(text.split("\n").length, 3)
})

test("formatStatus reports only changed config", () => {
  const text = formatStatus(
    { turns: 2, locked: false, forkPending: false },
    config({ turns: 9, model: "anthropic/claude-sonnet-4-5" }),
    "Some title",
  )
  assert.match(text, /^Config: turns=9 model=anthropic\/claude-sonnet-4-5$/m)
})

test("inspect does not initialize, read the title, or persist state", async () => {
  const harness = createCoordinator({ initialTitle: "Chosen before the plugin loaded" })

  const state = await harness.coordinator.inspect("ses_inspect")

  assert.equal(state.locked, false)
  assert.equal(harness.reads.count, 0)
  assert.equal(harness.store.peek("ses_inspect"), undefined)
  assert.equal(harness.storage.data.size, 0)
})

test("a code-only prompt does not satisfy minPromptLength", async () => {
  const harness = createCoordinator({
    transcript: [{ role: "user", text: "```ts\nconst a = 1\n```" }],
    config: { minPromptLength: 1 },
  })

  const outcome = await harness.coordinator.retitle("ses_code", "turns")

  assert.equal(outcome.applied, false)
  assert.equal(outcome.applied ? "" : outcome.reason, "not enough transcript text")
  assert.deepEqual(harness.applied, [])
})

test("a manual rename after the marker save aborts and restores the turn counter", async () => {
  const storage = memoryStorage()
  const originalSet = storage.set.bind(storage)
  let injected = false
  // Simulate a rename landing in the window after the marker save. The next
  // read of shared state must see the lock before `applyTitle` runs.
  storage.set = async (key, value) => {
    await originalSet(key, value)
    if (!injected && key === "session/ses_window" && (value as { lastWrite?: string }).lastWrite) {
      injected = true
      await originalSet(key, { ...(value as object), locked: true })
    }
  }
  const harness = createCoordinator({ storage, initialTitle: "" })
  await harness.coordinator.onUserPrompt("ses_window")
  await harness.coordinator.onUserPrompt("ses_window")
  await harness.coordinator.onUserPrompt("ses_window")

  const outcome = await harness.coordinator.retitle("ses_window", "turns")

  assert.equal(outcome.applied, false)
  assert.deepEqual(harness.applied, [])
  const stored = (await harness.store.load("ses_window")) as {
    turns: number
    locked: boolean
    lastWrite?: string
  }
  assert.equal(stored.locked, true)
  assert.equal(stored.turns, 3, "the unconsumed turn counter is restored")
  assert.equal(stored.lastWrite, undefined, "the provenance marker is removed")
})

test("turns admitted while the model is generating are preserved", async () => {
  let harness: CoordinatorHarness
  harness = createCoordinator({
    initialTitle: "",
    config: { turns: 3 },
    generate: async () => {
      // The next prompt is admitted while the title model call is in flight.
      await harness.coordinator.onUserPrompt("ses_turns")
      return "Generated title"
    },
  })
  await harness.coordinator.onUserPrompt("ses_turns")
  await harness.coordinator.onUserPrompt("ses_turns")
  await harness.coordinator.onUserPrompt("ses_turns")

  const outcome = await harness.coordinator.retitle("ses_turns", "turns")

  assert.equal(outcome.applied, true)
  const stored = await harness.store.load("ses_turns")
  assert.equal(stored.turns, 1, "the prompt admitted during generation is not consumed")
})

test("pruned state is re-inspected instead of trusting an initialized flag", async () => {
  const harness = createCoordinator({ initialTitle: "First manual title" })
  await harness.coordinator.onUserPrompt("ses_pruned")
  assert.equal((await harness.store.load("ses_pruned")).locked, true)

  // Prune everything older than the retention window: both the cache entry and
  // the stored one disappear, exactly as they would after long inactivity.
  await harness.store.prune(Date.now() + 181 * 24 * 60 * 60 * 1000)
  assert.equal(harness.storage.data.has("session/ses_pruned"), false)

  harness.title.value = "Renamed while pruned"
  const state = await harness.coordinator.ensureInitialized("ses_pruned")

  assert.equal(state.locked, true, "the new title is inspected again")
  assert.equal(state.baseline, "Renamed while pruned")
})

test("prune runs in the background instead of blocking save", async () => {
  const storage = memoryStorage()
  const originalScan = storage.scan.bind(storage)
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let scans = 0
  storage.scan = async (input) => {
    scans += 1
    await gate
    return originalScan(input)
  }
  const store = new StateStore(storage)
  const now = Date.now()
  for (let i = 0; i < 49; i += 1) {
    await store.save(`ses_bg_${i}`, {
      turns: 0,
      locked: false,
      forkPending: false,
      pendingTurns: false,
      child: false,
      updated: now,
    })
  }

  const result = await Promise.race([
    store
      .save("ses_bg_50", {
        turns: 0,
        locked: false,
        forkPending: false,
        pendingTurns: false,
        child: false,
        updated: now,
      })
      .then(() => "saved"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 100)),
  ])

  assert.equal(result, "saved")
  assert.equal(scans > 0, true, "pruning started in the background")
  release?.()
  await new Promise((resolve) => setTimeout(resolve, 0))
})
