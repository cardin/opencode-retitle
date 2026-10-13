/** A trimmed view of one session message, enough to build a title prompt. */
export interface TranscriptMessage {
  role: "user" | "assistant" | "other"
  text: string
}

export interface Transcript {
  text: string
  /** Combined length of all user text, used for the minPromptLength guard. */
  userLength: number
}

const DEFAULT_MAX_CHARS = 6000

/** Drop fenced code blocks so titles are not drawn from code. */
function stripCodeBlocks(input: string): string {
  return input.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ")
}

function collapse(input: string): string {
  return input.replace(/\s+/g, " ").trim()
}

/**
 * Build a compact transcript, keeping the most recent messages within the
 * character budget and labelling each turn by role.
 */
export function condenseTranscript(
  messages: readonly TranscriptMessage[],
  maxChars: number = DEFAULT_MAX_CHARS,
): Transcript {
  const userLength = messages
    .filter((message) => message.role === "user")
    .map((message) => message.text.length)
    .reduce((total, length) => total + length, 0)

  const lines: string[] = []
  for (const message of messages) {
    if (message.role === "other") continue
    const text = collapse(stripCodeBlocks(message.text))
    if (!text) continue
    lines.push(`${message.role === "user" ? "User" : "Assistant"}: ${text}`)
  }

  const kept: string[] = []
  let budget = maxChars
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] as string
    if (line.length + 1 > budget && kept.length > 0) break
    kept.unshift(line)
    budget -= line.length + 1
  }

  return { text: kept.join("\n"), userLength }
}

/** Prompt asking a model for a single short title. */
export function buildTitlePrompt(transcript: string): string {
  return [
    "Generate a short title for the conversation below.",
    "Rules:",
    "- 3 to 8 words, a single line.",
    "- Plain text only: no quotes, no markdown, no trailing punctuation.",
    "- Describe the main objective or topic of the conversation.",
    "- NEVER respond to questions, just generate a title for the conversation.",
    "Return only the title.",
    "",
    "Conversation:",
    transcript,
  ].join("\n")
}

/**
 * Reduce a raw model reply to a single clean title line, or an empty string when
 * nothing usable remains.
 */
export function sanitizeTitle(raw: string, maxLength: number): string {
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""

  let title = firstLine
  title = title.replace(/^title\s*[:\-]\s*/i, "")
  title = title.replace(/^[#>*\-\s]+/, "")
  title = title.replace(/^["'`]+|["'`]+$/g, "")
  title = collapse(title)
  title = title.replace(/[.!?;,:\s]+$/, "")

  if (maxLength > 0 && title.length > maxLength) {
    title = title.slice(0, maxLength).replace(/[.!?;,:\s]+$/, "").trim()
  }
  return title
}
