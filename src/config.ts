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
  /**
   * How long (ms) after the built-in title request starts or its response
   * arrives the resulting rename stays attributable to OpenCode. The response
   * refresh means this does not have to outlast a slow model call.
   */
  builtinGraceMs: number
  /** `"providerID/modelID"` for title generation, or null to inherit the session model. */
  model: string | null
  /** Maximum generated title length in characters. */
  titleMaxLength: number
  /** Minimum transcript text (code blocks excluded) before a title is generated. */
  minPromptLength: number
  /** Log decisions to the OpenCode log. */
  debug: boolean
}

/**
 * Default for {@link RetitleConfig.builtinGraceMs}.
 *
 * The marker is written when the built-in title request starts and refreshed
 * when its HTTP response arrives. The rename follows the response, so a short
 * window is enough even when the model queues for minutes behind a provider:
 * the old 45-second start-only window expired before a slow title call
 * finished, and the generated rename was then mistaken for a manual one. Two
 * minutes from the response is ample for the rename to be published, while
 * keeping the window in which a genuine manual rename could be attributed to
 * OpenCode small. Hosts that do not expose `http.response` still get the
 * start-time marker; for those, a title call longer than two minutes can still
 * expire, but that is the compatibility fallback rather than the normal path.
 */
export const DEFAULT_BUILTIN_GRACE_MS = 2 * 60 * 1000

export const defaultConfig: RetitleConfig = {
  turns: 5,
  onCompaction: true,
  onFork: true,
  respectManualRename: true,
  lockExistingTitles: true,
  builtinGraceMs: DEFAULT_BUILTIN_GRACE_MS,
  model: null,
  titleMaxLength: 60,
  minPromptLength: 10,
  debug: false,
}

/** The set of settings the plugin options may provide. */
export type PartialConfig = Partial<RetitleConfig>

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
  if (
    typeof r.builtinGraceMs === "number" &&
    Number.isFinite(r.builtinGraceMs) &&
    r.builtinGraceMs >= 0
  ) {
    out.builtinGraceMs = Math.floor(r.builtinGraceMs)
  }
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

/**
 * Resolve the effective configuration.
 *
 * Every setting lives in `opencode.json(c)` under this plugin's `options`
 * object; the plugin keeps no configuration file of its own. OpenCode merges the
 * global and project `opencode.json(c)` files before the plugin runs. Settings
 * that are absent fall back to the built-in defaults.
 */
export function loadConfig(input: { options?: unknown } = {}): RetitleConfig {
  return { ...defaultConfig, ...normalizeConfig(input.options) }
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
