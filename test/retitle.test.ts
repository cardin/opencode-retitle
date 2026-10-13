import assert from "node:assert/strict"
import test from "node:test"

import { defaultConfig, type RetitleConfig } from "../src/config.ts"
import { formatStatus, resolveModel, titleOrigin } from "../src/retitle.ts"

function config(overrides: Partial<RetitleConfig>): RetitleConfig {
  return { ...defaultConfig, ...overrides }
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
  assert.equal(titleOrigin({ locked: false, lastWrite: "Mine" }, "Mine"), "retitle")
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
