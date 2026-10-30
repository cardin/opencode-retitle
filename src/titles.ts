/** A trimmed view of one session message, enough to build a title prompt. */
export interface TranscriptMessage {
  role: "user" | "assistant" | "compaction" | "other"
  text: string
}

export interface Transcript {
  text: string
  /** Combined length of all user text, before code blocks are stripped. */
  userLength: number
}

/** Maximum characters of the assembled transcript sent for title inference. */
const DEFAULT_MAX_CHARS = 3100

/** Maximum characters kept from any single message. */
const DEFAULT_MAX_MESSAGE_CHARS = 1000

/** Drop fenced code blocks so titles are not drawn from code. */
function stripCodeBlocks(input: string): string {
  return input.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ")
}

function collapse(input: string): string {
  return input.replace(/\s+/g, " ").trim()
}

function truncate(input: string, maxChars: number): string {
  return maxChars > 0 && input.length > maxChars ? input.slice(0, maxChars) : input
}

/**
 * Build a compact transcript, keeping the most recent messages within the
 * character budget and labelling each turn by role.
 *
 * Every labelled line is truncated to `maxMessageChars` and the assembled
 * transcript never exceeds `maxChars`, so a single large paste cannot inflate
 * the prompt.
 */
export function condenseTranscript(
  messages: readonly TranscriptMessage[],
  maxChars: number = DEFAULT_MAX_CHARS,
  maxMessageChars: number = DEFAULT_MAX_MESSAGE_CHARS,
): Transcript {
  const userLength = messages
    .filter((message) => message.role === "user")
    .map((message) => message.text.length)
    .reduce((total, length) => total + length, 0)

  const lines: string[] = []
  for (const message of messages) {
    if (message.role === "other") continue
    const body = collapse(stripCodeBlocks(message.text))
    if (!body) continue
    const label =
      message.role === "user"
        ? "User: "
        : message.role === "compaction"
          ? "Summary: "
          : "Assistant: "
    lines.push(truncate(label + body, maxMessageChars))
  }

  const kept: string[] = []
  let budget = maxChars
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] as string
    if (kept.length > 0 && line.length + 1 > budget) break
    const text = truncate(line, budget)
    if (!text) break
    kept.unshift(text)
    budget -= text.length + 1
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
  title = title.replace(/^[#>*_~\-\s]+/, "")
  title = title.replace(/^["'`]+|["'`]+$/g, "")
  title = collapse(title)
  title = title.replace(/[.!?;,:\s]+$/, "")
  title = title.replace(/[#>*_~`]+$/, "")
  title = title.replace(/[.!?;,:\s]+$/, "")

  if (maxLength > 0) {
    // Count code points, not UTF-16 code units, so an emoji is never split in
    // half and the visible length matches the configured maximum.
    const characters = Array.from(title)
    if (characters.length > maxLength) {
      title = characters
        .slice(0, maxLength)
        .join("")
        .replace(/[.!?;,:\s]+$/, "")
        .trim()
    }
  }
  return title
}
