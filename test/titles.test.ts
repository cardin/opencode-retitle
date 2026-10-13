import assert from "node:assert/strict"
import test from "node:test"

import {
  buildTitlePrompt,
  condenseTranscript,
  sanitizeTitle,
  type TranscriptMessage,
} from "../src/titles.ts"

test("sanitizeTitle keeps a single clean line", () => {
  assert.equal(sanitizeTitle("Fix the provider state", 60), "Fix the provider state")
  assert.equal(sanitizeTitle("  ## Add retitle plugin  ", 60), "Add retitle plugin")
  assert.equal(sanitizeTitle('"Add retitle plugin"', 60), "Add retitle plugin")
  assert.equal(sanitizeTitle("Title: Add retitle plugin", 60), "Add retitle plugin")
  assert.equal(sanitizeTitle("Add retitle plugin.", 60), "Add retitle plugin")
})

test("sanitizeTitle uses the first non-empty line", () => {
  assert.equal(sanitizeTitle("\n\n  Add retitle plugin \n (extra)", 60), "Add retitle plugin")
})

test("sanitizeTitle clamps to the maximum length", () => {
  assert.equal(sanitizeTitle("a".repeat(200), 20), "a".repeat(20))
  assert.equal(sanitizeTitle("Fix the provider state", 10), "Fix the pr")
})

test("sanitizeTitle returns an empty string when there is nothing usable", () => {
  assert.equal(sanitizeTitle("   \n  ", 60), "")
})

test("condenseTranscript labels turns and sums user text", () => {
  const messages: TranscriptMessage[] = [
    { role: "user", text: "hello there" },
    { role: "assistant", text: "hi" },
    { role: "user", text: "please add a plugin" },
  ]
  const transcript = condenseTranscript(messages)
  assert.match(transcript.text, /User: hello there/)
  assert.match(transcript.text, /Assistant: hi/)
  assert.equal(transcript.userLength, "hello there".length + "please add a plugin".length)
})

test("condenseTranscript drops code blocks and other turns", () => {
  const messages: TranscriptMessage[] = [
    { role: "other", text: "ignored" },
    { role: "user", text: "look at ```const a = 1``` this" },
  ]
  const transcript = condenseTranscript(messages)
  assert.ok(!transcript.text.includes("const a = 1"))
  assert.ok(!transcript.text.includes("ignored"))
})

test("condenseTranscript keeps the most recent lines within budget", () => {
  const messages: TranscriptMessage[] = [
    { role: "user", text: "a".repeat(50) },
    { role: "assistant", text: "b".repeat(50) },
    { role: "user", text: "c".repeat(50) },
  ]
  const transcript = condenseTranscript(messages, 60)
  assert.ok(transcript.text.includes("c".repeat(50)))
  assert.ok(!transcript.text.includes("a".repeat(50)))
})

test("condenseTranscript truncates each labelled line", () => {
  const user = condenseTranscript([{ role: "user", text: "x".repeat(5000) }])
  assert.equal(user.text.length, 1000)
  assert.equal(user.text, "User: " + "x".repeat(994))

  const assistant = condenseTranscript([{ role: "assistant", text: "x".repeat(5000) }])
  assert.equal(assistant.text.length, 1000)
  assert.equal(assistant.text, "Assistant: " + "x".repeat(989))
})

test("condenseTranscript never exceeds the total character budget", () => {
  const messages: TranscriptMessage[] = []
  for (let i = 0; i < 10; i += 1) {
    messages.push({ role: i % 2 === 0 ? "user" : "assistant", text: `${i}`.repeat(5000) })
  }
  const transcript = condenseTranscript(messages)
  assert.ok(transcript.text.length <= 3100, `transcript was ${transcript.text.length} chars`)
  // Three 1000-char lines plus their separators fit the budget.
  assert.equal(transcript.text.split("\n").length, 3)
})

test("condenseTranscript honours an explicit per-message budget", () => {
  const transcript = condenseTranscript(
    [{ role: "user", text: "a".repeat(5000) }],
    400,
    1000,
  )
  assert.ok(transcript.text.length <= 400, `transcript was ${transcript.text.length} chars`)
})

test("buildTitlePrompt embeds the transcript and constraints", () => {
  const prompt = buildTitlePrompt("User: hello")
  assert.match(prompt, /Generate a short title/)
  assert.match(prompt, /NEVER respond to questions/)
  assert.match(prompt, /User: hello/)
})
