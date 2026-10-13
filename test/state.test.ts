import assert from "node:assert/strict"
import test from "node:test"

import { StateStore, type StorageLike } from "../src/state.ts"

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
