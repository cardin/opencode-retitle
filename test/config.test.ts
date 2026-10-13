import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  defaultConfig,
  loadConfig,
  normalizeConfig,
  parseJsonc,
  parseModelRef,
  stripComments,
} from "../src/config.ts"

test("stripComments leaves comment-like text inside strings alone", () => {
  const input = '{ "url": "https://example.com/a//b", "n": 1 } // trailing\n'
  const stripped = stripComments(input)
  assert.ok(stripped.includes("https://example.com/a//b"))
  assert.ok(!stripped.includes("// trailing"))
})

test("stripComments removes block comments", () => {
  assert.equal(stripComments('{ /* note */ "a": 1 }').trim(), '{  "a": 1 }')
})

test("parseJsonc tolerates comments and trailing commas", () => {
  const parsed = parseJsonc('{\n  // note\n  "turns": 3,\n  "onFork": true,\n}\n')
  assert.deepEqual(parsed, { turns: 3, onFork: true })
})

test("normalizeConfig keeps valid settings and drops bad ones", () => {
  assert.deepEqual(
    normalizeConfig({
      turns: 7,
      onCompaction: false,
      onFork: "yes",
      respectManualRename: false,
      lockExistingTitles: false,
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
  assert.deepEqual(normalizeConfig({ turns: -1, titleMaxLength: 0, minPromptLength: Number.NaN }), {})
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

test("loadConfig applies defaults, then file, then options", () => {
  const home = mkdtempSync(join(tmpdir(), "retitle-home-"))
  const directory = mkdtempSync(join(tmpdir(), "retitle-proj-"))

  mkdirSync(join(home, ".config", "opencode"), { recursive: true })
  writeFileSync(
    join(home, ".config", "opencode", "retitle.jsonc"),
    '{ // global\n  "turns": 3,\n  "titleMaxLength": 30,\n}\n',
  )
  mkdirSync(join(directory, ".opencode"), { recursive: true })
  writeFileSync(
    join(directory, ".opencode", "retitle.jsonc"),
    '{ "turns": 9, "onFork": false }\n',
  )

  const config = loadConfig({
    directory,
    home,
    options: { titleMaxLength: 12 },
  })

  assert.equal(config.turns, 9)
  assert.equal(config.onFork, false)
  assert.equal(config.titleMaxLength, 12)
  assert.equal(config.onCompaction, defaultConfig.onCompaction)
})

test("loadConfig falls back to defaults with no files or options", () => {
  const home = mkdtempSync(join(tmpdir(), "retitle-home-"))
  const directory = mkdtempSync(join(tmpdir(), "retitle-proj-"))
  assert.deepEqual(loadConfig({ directory, home }), defaultConfig)
})
