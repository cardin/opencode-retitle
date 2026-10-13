import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Resolved configuration used by the plugin at runtime. */
export interface RetitleConfig {
  /** Retitle every N admitted user prompts. 0 disables the turn trigger. */
  turns: number
  /** Retitle once after a compaction finishes. */
  onCompaction: boolean
  /** Retitle after the first assistant response in a forked session. */
  onFork: boolean
  /** Stop retitling a session once a title we did not write appears. */
  respectManualRename: boolean
  /**
   * Treat a session that already carries an unattributable title when the plugin
   * first sees it as manually named (paused). Disable to retitle such sessions.
   */
  lockExistingTitles: boolean
  /** `"providerID/modelID"` for title generation, or null to inherit the session model. */
  model: string | null
  /** Maximum generated title length in characters. */
  titleMaxLength: number
  /** Minimum combined user text length before a title is generated. */
  minPromptLength: number
  /** Log decisions to the OpenCode log. */
  debug: boolean
}

export const defaultConfig: RetitleConfig = {
  turns: 5,
  onCompaction: true,
  onFork: true,
  respectManualRename: true,
  lockExistingTitles: true,
  model: null,
  titleMaxLength: 60,
  minPromptLength: 10,
  debug: false,
}

/** The set of settings a config file or plugin options may provide. */
export type PartialConfig = Partial<RetitleConfig>

/**
 * Remove `//` and `/* ... *\/` comments from JSONC without touching string literals.
 */
export function stripComments(input: string): string {
  let out = ""
  let i = 0
  let inString = false
  let quote = ""
  while (i < input.length) {
    const ch = input[i]
    const next = input[i + 1]
    if (inString) {
      out += ch
      if (ch === "\\") {
        out += next ?? ""
        i += 2
        continue
      }
      if (ch === quote) inString = false
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      inString = true
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i += 1
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** Parse JSONC text, tolerating comments and trailing commas. */
export function parseJsonc(input: string): unknown {
  const cleaned = stripComments(input).replace(/,(\s*[}\]])/g, "$1")
  return JSON.parse(cleaned)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

/** Keep only recognised, well-typed settings. Unknown keys and bad values are dropped. */
export function normalizeConfig(raw: unknown): PartialConfig {
  const out: PartialConfig = {}
  const r = asRecord(raw)
  if (!r) return out

  if (typeof r.turns === "number" && Number.isFinite(r.turns) && r.turns >= 0) {
    out.turns = Math.floor(r.turns)
  }
  if (typeof r.onCompaction === "boolean") out.onCompaction = r.onCompaction
  if (typeof r.onFork === "boolean") out.onFork = r.onFork
  if (typeof r.respectManualRename === "boolean") out.respectManualRename = r.respectManualRename
  if (typeof r.lockExistingTitles === "boolean") out.lockExistingTitles = r.lockExistingTitles
  if (r.model === null) out.model = null
  else if (typeof r.model === "string" && r.model.trim()) out.model = r.model.trim()
  if (typeof r.titleMaxLength === "number" && r.titleMaxLength > 0) {
    out.titleMaxLength = Math.floor(r.titleMaxLength)
  }
  if (typeof r.minPromptLength === "number" && r.minPromptLength >= 0) {
    out.minPromptLength = Math.floor(r.minPromptLength)
  }
  if (typeof r.debug === "boolean") out.debug = r.debug
  return out
}

/** Candidate config files, most specific first. */
export function configPaths(directory: string, home: string = homedir()): string[] {
  return [
    join(directory, ".opencode", "retitle.jsonc"),
    join(directory, ".opencode", "retitle.json"),
    join(home, ".config", "opencode", "retitle.jsonc"),
    join(home, ".config", "opencode", "retitle.json"),
  ]
}

/**
 * Resolve the effective configuration.
 *
 * Precedence (low to high): built-in defaults, the first existing config file,
 * then `ctx.options` supplied through `opencode.json(c)`.
 */
export function loadConfig(input: {
  directory?: string
  options?: unknown
  home?: string
}): RetitleConfig {
  const directory = input.directory ?? process.cwd()
  const home = input.home ?? homedir()

  let fromFile: PartialConfig = {}
  for (const path of configPaths(directory, home)) {
    if (!existsSync(path)) continue
    try {
      fromFile = normalizeConfig(parseJsonc(readFileSync(path, "utf8")))
    } catch {
      fromFile = {}
    }
    break
  }

  const fromOptions = normalizeConfig(input.options)

  return { ...defaultConfig, ...fromFile, ...fromOptions }
}

/** Parse a `"providerID/modelID"` reference. Returns undefined when malformed. */
export function parseModelRef(
  value: string,
): { providerID: string; id: string } | undefined {
  const trimmed = value.trim()
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1) return undefined
  return { providerID: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) }
}
