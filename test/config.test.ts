import assert from "node:assert/strict"
import test from "node:test"

import {
  defaultConfig,
  loadConfig,
  normalizeConfig,
  parseModelRef,
} from "../src/config.ts"

test("normalizeConfig keeps valid settings and drops bad ones", () => {
  assert.deepEqual(
    normalizeConfig({
      turns: 7,
      onCompaction: false,
      onFork: "yes",
      respectManualRename: false,
      lockExistingTitles: false,
      builtinGraceMs: 45000,
      model: " anthropic/claude-sonnet-4-5 ",
      titleMaxLength: 40,
      minPromptLength: 0,
      debug: true,
      unknown: 1,
    }),
    {
      turns: 7,
      onCompaction: false,
      respectManualRename: false,
      lockExistingTitles: false,
      builtinGraceMs: 45000,
      model: "anthropic/claude-sonnet-4-5",
      titleMaxLength: 40,
      minPromptLength: 0,
      debug: true,
    },
  )
})

test("normalizeConfig accepts an explicit null model", () => {
  assert.deepEqual(normalizeConfig({ model: null }), { model: null })
})

test("normalizeConfig rejects negative and non-finite numbers", () => {
  assert.deepEqual(
    normalizeConfig({
      turns: -1,
      titleMaxLength: 0,
      minPromptLength: Number.NaN,
      builtinGraceMs: -1,
    }),
    {},
  )
})

test("parseModelRef splits on the first slash", () => {
  assert.deepEqual(parseModelRef("anthropic/claude-sonnet-4-5"), {
    providerID: "anthropic",
    id: "claude-sonnet-4-5",
  })
  assert.deepEqual(parseModelRef("opencode/go/kimi"), { providerID: "opencode", id: "go/kimi" })
  assert.equal(parseModelRef("noslash"), undefined)
  assert.equal(parseModelRef("/id"), undefined)
  assert.equal(parseModelRef("provider/"), undefined)
})

test("loadConfig applies defaults, then plugin options", () => {
  const config = loadConfig({
    options: { turns: 9, onFork: false, titleMaxLength: 12 },
  })

  assert.equal(config.turns, 9)
  assert.equal(config.onFork, false)
  assert.equal(config.titleMaxLength, 12)
  assert.equal(config.onCompaction, defaultConfig.onCompaction)
})

test("loadConfig falls back to defaults with no options", () => {
  assert.deepEqual(loadConfig(), defaultConfig)
})
