import { defaultConfig, parseModelRef, type RetitleConfig } from "./config.ts"
import { classifyTitleChange, isDefaultTitle, isForkTitle } from "./guard.ts"
import type { SessionState, StateStore } from "./state.ts"
import {
  buildTitlePrompt,
  condenseTranscript,
  sanitizeTitle,
  type TranscriptMessage,
} from "./titles.ts"

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface SessionTitleInfo {
  title?: string
  model?: ModelRef
}

/** Everything the coordinator needs from the OpenCode runtime. */
export interface RetitleDeps {
  config: RetitleConfig
  store: StateStore
  /** Recent messages, oldest first. */
  readTranscript(sessionID: string): Promise<readonly TranscriptMessage[]>
  readSession(sessionID: string): Promise<SessionTitleInfo>
  /** Ask a model for a raw title. */
  generateTitle(input: { model: ModelRef; prompt: string }): Promise<string>
  /** Persist a title on the session. */
  applyTitle(sessionID: string, title: string): Promise<void>
  /** Whether the built-in title generator is currently producing a title. */
  isBuiltinPending(sessionID: string): boolean
  /** Stop treating the built-in generator as pending for a session. */
  clearBuiltinPending(sessionID: string): void
  log(message: string, detail?: unknown): void
}

export type RetitleReason = "turns" | "compaction" | "fork" | "manual-enable"

/**
 * Decides when to regenerate a session title and applies the manual-rename guard.
 *
 * The class is transport-free: it receives events through its methods and talks to
 * the runtime only through {@link RetitleDeps}.
 */
export class RetitleCoordinator {
  private readonly deps: RetitleDeps
  private readonly inflight: Map<string, Promise<void>>
  private readonly initialized: Set<string>

  constructor(deps: RetitleDeps) {
    this.deps = deps
    this.inflight = new Map()
    this.initialized = new Set()
  }

  /**
   * Prepare a session the first time the plugin sees it.
   *
   * When the session already carries a title the plugin did not set and cannot
   * attribute, it is treated as manually named and retitling pauses. The turn
   * counter starts at zero and restarts after every retitle, so it always means
   * "prompts since the last rename".
   */
  async ensureInitialized(sessionID: string): Promise<SessionState> {
    const { state, persisted } = await this.deps.store.loadDetailed(sessionID)
    if (persisted || this.initialized.has(sessionID)) {
      this.initialized.add(sessionID)
      return state
    }
    this.initialized.add(sessionID)

    let title: string | undefined
    try {
      title = (await this.deps.readSession(sessionID)).title
    } catch (error) {
      this.deps.log(`could not read session ${sessionID}`, error)
    }

    if (title !== undefined) {
      state.baseline = title
      if (
        this.deps.config.lockExistingTitles &&
        this.deps.config.respectManualRename &&
        !isDefaultTitle(title) &&
        !isForkTitle(title)
      ) {
        state.locked = true
        this.deps.log(
          `session ${sessionID} already had a title before it was seen; pausing retitling (run /retitle-enable to resume)`,
        )
      }
    }

    await this.deps.store.save(sessionID, state)
    return state
  }

  /** Report the current state, initializing the session if needed. */
  async inspect(sessionID: string): Promise<SessionState> {
    return this.ensureInitialized(sessionID)
  }

  /** A session was created. Establishes its title origin. */
  async onSessionCreated(sessionID: string): Promise<void> {
    await this.ensureInitialized(sessionID)
  }

  /** A user prompt was admitted. Counts turns and retitles on the configured interval. */
  async onUserPrompt(sessionID: string): Promise<void> {
    const { config, store } = this.deps
    const state = await this.ensureInitialized(sessionID)
    state.turns += 1
    await store.save(sessionID, state)

    if (state.locked) return
    if (config.turns <= 0) return
    if (state.turns % config.turns !== 0) return
    void this.retitle(sessionID, "turns")
  }

  /** A compaction finished. */
  async onCompactionEnded(sessionID: string): Promise<void> {
    if (!this.deps.config.onCompaction) return
    void this.retitle(sessionID, "compaction")
  }

  /** A session was forked. Arms the post-fork retitle. */
  async onForked(sessionID: string): Promise<void> {
    if (!this.deps.config.onFork) return
    const state = await this.ensureInitialized(sessionID)
    state.forkPending = true
    await this.deps.store.save(sessionID, state)
  }

  /** A model step finished. Retitles once for a session that was just forked. */
  async onStepEnded(sessionID: string): Promise<void> {
    const { config, store } = this.deps
    const state = await this.ensureInitialized(sessionID)
    if (!state.forkPending) return
    state.forkPending = false
    await store.save(sessionID, state)
    if (!config.onFork) return
    void this.retitle(sessionID, "fork")
  }

  /** A title change was observed. Attributes it and updates the guard. */
  async onRenamed(sessionID: string, title: string): Promise<void> {
    const { config, store } = this.deps
    const state = await this.ensureInitialized(sessionID)
    const result = classifyTitleChange({
      title,
      lastWrite: state.lastWrite,
      builtinPending: this.deps.isBuiltinPending(sessionID),
      locked: state.locked,
      respectManualRename: config.respectManualRename,
    })

    if (result.source === "self") return
    if (result.source === "builtin") this.deps.clearBuiltinPending(sessionID)
    if (result.source === "default" || result.source === "fork" || result.source === "builtin") {
      state.baseline = title
    }
    if (result.source === "foreign" && !state.locked) {
      this.deps.log(`title set outside retitle, locking session ${sessionID}`)
    }
    state.locked = result.locked
    await store.save(sessionID, state)
  }

  /** Clear the manual-rename lock and retitle immediately. */
  async enable(sessionID: string): Promise<{ wasLocked: boolean }> {
    const state = await this.ensureInitialized(sessionID)
    const wasLocked = state.locked
    state.locked = false
    state.forkPending = false
    await this.deps.store.save(sessionID, state)
    await this.retitle(sessionID, "manual-enable")
    return { wasLocked }
  }

  /**
   * Generate and apply a title. Concurrent calls for the same session share one
   * run, and failures are logged rather than thrown.
   */
  async retitle(sessionID: string, reason: RetitleReason): Promise<void> {
    const existing = this.inflight.get(sessionID)
    if (existing) return existing

    const run = this.run(sessionID, reason).catch((error: unknown) => {
      this.deps.log(`retitle failed (${reason})`, error)
    })
    this.inflight.set(sessionID, run)
    try {
      await run
    } finally {
      this.inflight.delete(sessionID)
    }
  }

  private async run(sessionID: string, reason: RetitleReason): Promise<void> {
    const { config, store } = this.deps

    const state = await this.ensureInitialized(sessionID)
    if (state.locked) {
      this.deps.log(`skip retitle (${reason}): session ${sessionID} is locked`)
      return
    }

    const messages = await this.deps.readTranscript(sessionID)
    const transcript = condenseTranscript(messages)
    if (transcript.userLength < config.minPromptLength) {
      this.deps.log(`skip retitle (${reason}): not enough user text`)
      return
    }

    const info = await this.deps.readSession(sessionID)
    const model = resolveModel(config, info)
    if (!model) {
      this.deps.log(`skip retitle (${reason}): no model available`)
      return
    }

    const raw = await this.deps.generateTitle({
      model,
      prompt: buildTitlePrompt(transcript.text),
    })
    const title = sanitizeTitle(raw, config.titleMaxLength)
    if (!title) {
      this.deps.log(`skip retitle (${reason}): empty title from model`)
      return
    }
    if (title === info.title) {
      this.deps.log(`skip retitle (${reason}): title unchanged`)
      return
    }

    // Record our write before applying it so the resulting rename is recognised,
    // and restart the turn interval so renames never bunch up.
    state.lastWrite = title
    state.turns = 0
    await store.save(sessionID, state)
    await this.deps.applyTitle(sessionID, title)
    this.deps.log(`retitled (${reason}) -> ${title}`)
  }
}

export function resolveModel(
  config: RetitleConfig,
  info: SessionTitleInfo,
): ModelRef | undefined {
  if (config.model) {
    const parsed = parseModelRef(config.model)
    if (parsed) return parsed
  }
  return info.model
}

const SOURCE_LABEL = {
  self: "opencode-retitle",
  default: "auto (default)",
  fork: "auto (fork)",
  builtin: "auto (generated)",
  external: "external",
  unknown: "unknown",
} as const

/** Where the session's current title came from. */
export function titleOrigin(
  state: { locked: boolean; lastWrite?: string; baseline?: string },
  currentTitle?: string,
): string {
  if (state.locked) return "manual / external"
  if (currentTitle === undefined) return SOURCE_LABEL.unknown
  if (currentTitle === state.lastWrite) return SOURCE_LABEL.self
  if (isDefaultTitle(currentTitle)) return SOURCE_LABEL.default
  if (isForkTitle(currentTitle)) return SOURCE_LABEL.fork
  if (currentTitle === state.baseline) return SOURCE_LABEL.builtin
  return SOURCE_LABEL.external
}

/** Only the settings that differ from the defaults, so a toast stays short. */
function describeConfig(config: RetitleConfig): string | undefined {
  const parts: string[] = []
  if (config.turns !== defaultConfig.turns) parts.push(`turns=${config.turns}`)
  if (config.onCompaction !== defaultConfig.onCompaction) parts.push(`compaction=${config.onCompaction}`)
  if (config.onFork !== defaultConfig.onFork) parts.push(`fork=${config.onFork}`)
  if (config.respectManualRename !== defaultConfig.respectManualRename) {
    parts.push(`guard=${config.respectManualRename}`)
  }
  if (config.lockExistingTitles !== defaultConfig.lockExistingTitles) {
    parts.push(`lockExisting=${config.lockExistingTitles}`)
  }
  if (config.model !== defaultConfig.model) parts.push(`model=${config.model ?? "session"}`)
  if (config.titleMaxLength !== defaultConfig.titleMaxLength) parts.push(`max=${config.titleMaxLength}`)
  if (config.minPromptLength !== defaultConfig.minPromptLength) parts.push(`min=${config.minPromptLength}`)
  if (config.debug !== defaultConfig.debug) parts.push(`debug=${config.debug}`)
  return parts.length === 0 ? undefined : parts.join(" ")
}

/**
 * Plain-text report for a TUI toast. It answers the only question the command
 * exists for: was this session's title set by hand, and is retitling running?
 * No markdown (toasts do not render it), and no internal bookkeeping.
 */
export function formatStatus(
  state: {
    turns: number
    locked: boolean
    forkPending: boolean
    lastWrite?: string
    baseline?: string
  },
  config: RetitleConfig,
  currentTitle?: string,
): string {
  const lines = [
    `Title origin: ${titleOrigin(state, currentTitle)}`,
    state.locked
      ? "Retitling: paused (run /retitle-enable)"
      : "Retitling: active",
    `Turns since retitle: ${state.turns}${config.turns > 0 ? ` of ${config.turns}` : ""}`,
  ]

  if (state.forkPending) lines.push("Fork pending: yes")

  const changes = describeConfig(config)
  if (changes !== undefined) lines.push(`Config: ${changes}`)

  return lines.join("\n")
}
