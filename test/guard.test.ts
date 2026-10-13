import assert from "node:assert/strict"
import test from "node:test"

import {
  classifyTitleChange,
  FORK_TITLE_RE,
  isDefaultTitle,
  isForkTitle,
} from "../src/guard.ts"

const base = {
  lastWrite: undefined,
  builtinPending: false,
  locked: false,
  respectManualRename: true,
} as const

test("recognises default titles for new and child sessions", () => {
  assert.ok(isDefaultTitle("New session - 2026-10-13T09:52:00.000Z"))
  assert.ok(isDefaultTitle("Child session - 2026-10-13T09:52:00.000Z"))
  assert.ok(!isDefaultTitle("New session"))
  assert.ok(!isDefaultTitle("Fix the provider state"))
})

test("recognises fork titles", () => {
  assert.ok(isForkTitle("Fix the provider state (fork #1)"))
  assert.ok(isForkTitle("Fix the provider state (fork #12)"))
  assert.ok(!isForkTitle("Fix the provider state (fork)"))
  assert.match("anything (fork #1)", FORK_TITLE_RE)
})

test("a title equal to our last write is attributed to us", () => {
  const result = classifyTitleChange({
    ...base,
    title: "Add retitle plugin",
    lastWrite: "Add retitle plugin",
  })
  assert.equal(result.source, "self")
  assert.equal(result.locked, false)
})

test("default and fork titles never lock the session", () => {
  assert.equal(classifyTitleChange({ ...base, title: "New session - 2026-10-13T09:52:00.000Z" }).source, "default")
  assert.equal(classifyTitleChange({ ...base, title: "Parent (fork #2)" }).source, "fork")
})

test("built-in generation is attributed when pending", () => {
  const result = classifyTitleChange({
    ...base,
    title: "Some generated title",
    builtinPending: true,
  })
  assert.equal(result.source, "builtin")
  assert.equal(result.locked, false)
})

test("an unexplained title is foreign and locks", () => {
  const result = classifyTitleChange({ ...base, title: "Renamed by hand" })
  assert.equal(result.source, "foreign")
  assert.equal(result.locked, true)
})

test("foreign titles do not lock when the guard is off", () => {
  const result = classifyTitleChange({
    ...base,
    title: "Renamed by hand",
    respectManualRename: false,
  })
  assert.equal(result.source, "foreign")
  assert.equal(result.locked, false)
})

test("an already locked session stays locked", () => {
  const result = classifyTitleChange({ ...base, title: "Another manual name", locked: true })
  assert.equal(result.locked, true)
})

test("our own write does not unlock a locked session", () => {
  const result = classifyTitleChange({
    ...base,
    title: "kept",
    lastWrite: "kept",
    locked: true,
  })
  assert.equal(result.source, "self")
  assert.equal(result.locked, true)
})
