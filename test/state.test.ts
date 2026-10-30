import assert from "node:assert/strict"
import test from "node:test"

import { StateStore, MAX_AGE_MS, type StorageLike } from "../src/state.ts"

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

test("the built-in marker expires after the configured grace", async () => {
  const storage = memoryStorage()
  const store = new StateStore(storage, 1000)

  await store.markBuiltinPending("ses_a", 10_000)
  assert.equal(await store.isBuiltinPending("ses_a", 10_999), true)
  assert.equal(await store.isBuiltinPending("ses_a", 11_000), false)
  assert.equal(storage.data.has("builtin/ses_a"), false, "expired marker is removed")
})

test("the marker is visible to every store, not just the one that wrote it", async () => {
  const storage = memoryStorage()
  const owner = new StateStore(storage, 1000)
  const observer = new StateStore(storage, 1000)

  await owner.markBuiltinPending("ses_b", 10_000)
  assert.equal(await observer.isBuiltinPending("ses_b", 10_500), true)
})

test("refreshing the marker at the response survives a slow title model", async () => {
  const storage = memoryStorage()
  const store = new StateStore(storage)
  const started = 10_000
  const response = started + 5 * 60 * 1000
  await store.markBuiltinPending("ses_slow", started)
  // The request started five minutes ago; the response arrives now and the
  // rename follows immediately.
  await store.markBuiltinPending("ses_slow", response)
  assert.equal(await store.isBuiltinPending("ses_slow", response + 2 * 60 * 1000 - 1), true)
  assert.equal(await store.isBuiltinPending("ses_slow", response + 2 * 60 * 1000), false)
})

test("state survives long enough to keep our own old titles attributable", async () => {
  const storage = memoryStorage()
  const now = Date.now()
  const updated = now - 31 * 24 * 60 * 60 * 1000
  storage.data.set("session/ses_old", {
    turns: 2,
    locked: false,
    forkPending: false,
    lastWrite: "An old generated title",
    updated,
  })
  assert.ok(MAX_AGE_MS >= 90 * 24 * 60 * 60 * 1000)

  const store = new StateStore(storage)
  const loaded = await store.loadDetailed("ses_old", now)
  assert.equal(loaded.persisted, true)
  assert.equal(loaded.state.lastWrite, "An old generated title")
})

test("older persisted state gets the newer fields with safe defaults", async () => {
  const storage = memoryStorage()
  const now = Date.now()
  storage.data.set("session/ses_legacy", {
    turns: 1,
    locked: false,
    forkPending: false,
    updated: now,
  })
  const store = new StateStore(storage)
  const state = await store.load("ses_legacy", now)
  assert.equal(state.pendingTurns, false)
  assert.equal(state.child, false)
})
