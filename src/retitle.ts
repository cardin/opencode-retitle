import { defaultConfig, parseModelRef, type RetitleConfig } from "./config.ts"
import { classifyTitleChange, isDefaultTitle, isForkTitle } from "./guard.ts"
import type { SessionState, StateStore } from "./state.ts"
import { emptyState } from "./state.ts"
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
  /** Set for a subagent/child session; forks are root sessions and have no parent. */
  parentID?: string | null
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
  /** Whether the built-in title generator recently started a title for this session. */
  isBuiltinPending(sessionID: string): Promise<boolean>
  log(message: string, detail?: unknown): void
}

export type RetitleReason = "turns" | "compaction" | "fork" | "manual-enable"

/** What a retitle run did, so callers such as `/retitle-enable` can report it. */
export type RetitleOutcome =
  | { applied: true; title: string }
  | { applied: false; reason: string }

function skipped(reason: string): RetitleOutcome {
  return { applied: false, reason }
}

/**
 * Decides when to regenerate a session title and applies the manual-rename guard.
 *
 * The class is transport-free: it receives events through its methods and talks to
 * the runtime only through {@link RetitleDeps}.
 */
export class RetitleCoordinator {
  private readonly deps: RetitleDeps
  private readonly inflight: Map<string, Promise<RetitleOutcome>>
  private readonly queued: Map<string, RetitleReason>

  constructor(deps: RetitleDeps) {
    this.deps = deps
    this.inflight = new Map()
    this.queued = new Map()
  }

  /**
   * Prepare a session the first time the plugin sees it.
   *
   * When the session already carries a title the plugin did not set and cannot
   * attribute, it is treated as manually named and retitling pauses. The turn
   * counter starts at zero and restarts after every retitle, so it always means
   * "prompts since the last rename".
   *
   * Persistence, not an in-memory set, decides whether a session is new. Pruning
   * can evict the cached state, and a memory-only "already initialized" flag
   * would then keep a stale decision forever instead of re-reading the title.
   */
  async ensureInitialized(sessionID: string): Promise<SessionState> {
    const { state, persisted } = await this.deps.store.loadDetailed(sessionID)
    if (persisted) return state

    let info: SessionTitleInfo | undefined
    try {
      info = await this.deps.readSession(sessionID)
    } catch (error) {
      this.deps.log(`could not read session ${sessionID}`, error)
    }

    if (info?.parentID !== undefined && info.parentID !== null) {
      state.child = true
      this.deps.log(`session ${sessionID} is a subagent session; retitling disabled`)
      await this.deps.store.save(sessionID, state)
      return state
    }

    const title = info?.title
    // A title that is empty (or only whitespace) is not a manual rename: the
    // session has not been named yet, so it must stay eligible for retitling.
    if (title !== undefined && title.trim() !== "") {
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

  /** Report the current state without initializing, caching, or persisting it. */
  async inspect(sessionID: string): Promise<SessionState> {
    const cached = this.deps.store.peek(sessionID)
    if (cached !== undefined) return cached
    return (await this.deps.store.readStored(sessionID)) ?? emptyState(Date.now())
  }

  /** A session was created. Establishes its title origin. */
  async onSessionCreated(sessionID: string, parentID?: string | null): Promise<void> {
    if (parentID !== undefined && parentID !== null) {
      const state = await this.deps.store.load(sessionID)
      state.child = true
      this.deps.log(`session ${sessionID} is a subagent session; retitling disabled`)
      await this.deps.store.save(sessionID, state)
      return
    }
    await this.ensureInitialized(sessionID)
  }

  /**
   * A user prompt was admitted. Counts turns now, but waits for the response
   * before retitling: `session.context()` does not contain the prompt until it
   * is delivered, and it cannot contain the answer until the run finishes.
   */
  async onUserPrompt(sessionID: string): Promise<void> {
    const { config, store } = this.deps
    const state = await this.ensureInitialized(sessionID)
    if (state.child) return

    state.turns += 1
    if (!state.locked && config.turns > 0 && state.turns % config.turns === 0) {
      state.pendingTurns = true
    }
    await store.save(sessionID, state)
  }

  /**
   * A run finished successfully. This is the first point where the triggering
   * prompt and its assistant response are both in the transcript.
   */
  async onExecutionSucceeded(sessionID: string): Promise<void> {
    const state = await this.ensureInitialized(sessionID)
    if (state.child) return

    const reason: RetitleReason | undefined = state.forkPending
      ? "fork"
      : state.pendingTurns
        ? "turns"
        : undefined
    if (reason === undefined) return

    state.forkPending = false
    state.pendingTurns = false
    await this.deps.store.save(sessionID, state)
    void this.retitle(sessionID, reason)
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
    if (state.child) return
    state.forkPending = true
    await this.deps.store.save(sessionID, state)
  }

  /**
   * A title change was observed. Attributes it and updates the guard.
   *
   * The built-in marker is deliberately not consumed here. Consuming it would
   * let concurrent instances (OpenCode delivers every event to every instance)
   * flip each other's decision: whichever read it first classifies "builtin",
   * the rest classify "foreign" and lock the session. Leaving it to expire keeps
   * every instance in agreement.
   */
  async onRenamed(sessionID: string, title: string): Promise<void> {
    const { config, store } = this.deps
    // Another instance may have written the title (and its `lastWrite` marker)
    // while this instance's cache was stale. Read shared storage directly so our
    // own rename is not classified as foreign and locked.
    const state = await store.reload(sessionID)
    const result = classifyTitleChange({
      title,
      lastWrite: state.lastWrite,
      builtinPending: await this.deps.isBuiltinPending(sessionID),
      locked: state.locked,
      respectManualRename: config.respectManualRename,
    })

    if (result.source === "self") return
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
  async enable(sessionID: string): Promise<{ wasLocked: boolean; outcome: RetitleOutcome }> {
    const state = await this.ensureInitialized(sessionID)
    const wasLocked = state.locked
    state.locked = false
    state.forkPending = false
    state.pendingTurns = false
    await this.deps.store.save(sessionID, state)
    const outcome = await this.retitle(sessionID, "manual-enable")
    return { wasLocked, outcome }
  }

  /**
   * Generate and apply a title. Concurrent calls for the same session share one
   * run, and failures are logged rather than thrown.
   *
   * A compaction or fork that arrives while a turn retitle is generating is
   * queued, not dropped: the coalesced run happens immediately after the first
   * one and sees the transcript that triggered it.
   */
  async retitle(sessionID: string, reason: RetitleReason): Promise<RetitleOutcome> {
    const existing = this.inflight.get(sessionID)
    if (existing) {
      this.queued.set(sessionID, reason)
      this.deps.log(`queue retitle (${reason}) for session ${sessionID}: another run is in flight`)
      return existing
    }

    const run = this.run(sessionID, reason).catch((error: unknown): RetitleOutcome => {
      this.deps.log(`retitle failed (${reason})`, error)
      const message = error instanceof Error ? error.message : String(error)
      return skipped(`generation failed: ${message}`)
    })
    this.inflight.set(sessionID, run)
    let outcome: RetitleOutcome
    try {
      outcome = await run
    } finally {
      this.inflight.delete(sessionID)
      const queued = this.queued.get(sessionID)
      if (queued !== undefined) {
        this.queued.delete(sessionID)
        void this.retitle(sessionID, queued)
      }
    }
    return outcome
  }

  private async run(sessionID: string, reason: RetitleReason): Promise<RetitleOutcome> {
    const { config, store } = this.deps

    const state = await this.ensureInitialized(sessionID)
    if (state.child) {
      this.deps.log(`skip retitle (${reason}): session ${sessionID} is a subagent session`)
      return skipped("subagent session")
    }
    if (state.locked) {
      this.deps.log(`skip retitle (${reason}): session ${sessionID} is locked`)
      return skipped("session is paused after a manual rename")
    }

    // Only these already-admitted turns may be consumed by this rename. Prompts
    // admitted while the model runs must stay counted for the next interval.
    const turnsAtStart = state.turns

    const messages = await this.deps.readTranscript(sessionID)
    const transcript = condenseTranscript(messages)
    // The guard measures the text that is actually sent to the model. It uses
    // the assembled transcript rather than raw user text so a prompt made only
    // of a code block (stripped from the prompt) does not count, while a
    // compaction summary still lets the post-compaction retitle run.
    if (transcript.text.length < config.minPromptLength) {
      this.deps.log(`skip retitle (${reason}): not enough transcript text`)
      return skipped("not enough transcript text")
    }

    const info = await this.deps.readSession(sessionID)
    if (info.parentID !== undefined && info.parentID !== null) {
      state.child = true
      await store.save(sessionID, state)
      this.deps.log(`skip retitle (${reason}): session ${sessionID} is a subagent session`)
      return skipped("subagent session")
    }
    const model = resolveModel(config, info)
    if (!model) {
      this.deps.log(`skip retitle (${reason}): no model available`)
      return skipped("no model available")
    }

    const raw = await this.deps.generateTitle({
      model,
      prompt: buildTitlePrompt(transcript.text),
    })
    const title = sanitizeTitle(raw, config.titleMaxLength)
    if (!title) {
      this.deps.log(`skip retitle (${reason}): empty title from model`)
      return skipped("empty title from model")
    }

    // A manual rename (or another plugin) can arrive while the model is
    // generating. The rename event sets `locked`, but this run started before
    // that and must not overwrite the newer title with a stale one.
    const latest = await this.deps.readSession(sessionID)
    if (state.locked) {
      this.deps.log(`skip retitle (${reason}): session locked while generating`)
      return skipped("session locked while generating")
    }
    if (latest.title !== info.title) {
      this.deps.log(`skip retitle (${reason}): title changed while generating`)
      return skipped("title changed while generating")
    }
    if (title === latest.title) {
      this.deps.log(`skip retitle (${reason}): title unchanged`)
      return skipped("title unchanged")
    }

    // A lock can belong to another instance and be visible only in storage.
    const storedBefore = await store.readStored(sessionID)
    if (state.locked || storedBefore?.locked) {
      this.deps.log(`skip retitle (${reason}): session locked while generating`)
      return skipped("session locked while generating")
    }

    // Record our write before applying it so the resulting rename is recognised.
    // The turn counter is adjusted only after the save below, and only by the
    // turns that existed when this run started.
    const previousLastWrite = state.lastWrite
    state.lastWrite = title
    await store.save(sessionID, state)

    // `store.save` awaits storage, so a manual rename can land after the check
    // above. Re-read shared state and the session title before touching the
    // counter or the live session.
    const afterSave = await this.conflict(sessionID, info.title, state)
    if (afterSave !== undefined) {
      this.deps.log(`skip retitle (${reason}): ${afterSave}`)
      await this.restoreWrite(sessionID, state, title, previousLastWrite, 0)
      return skipped(afterSave)
    }

    state.turns = Math.max(0, state.turns - turnsAtStart)
    await store.save(sessionID, state)

    // Last check immediately before the rename. The window is now only the
    // in-memory handoff to `applyTitle`.
    const beforeApply = await this.conflict(sessionID, info.title, state)
    if (beforeApply !== undefined) {
      this.deps.log(`skip retitle (${reason}): ${beforeApply}`)
      await this.restoreWrite(sessionID, state, title, previousLastWrite, turnsAtStart)
      return skipped(beforeApply)
    }

    await this.deps.applyTitle(sessionID, title)
    this.deps.log(`retitled (${reason}) -> ${title}`)
    return { applied: true, title }
  }

  /**
   * Detect a manual rename or a lock that landed after a write started. State is
   * read straight from storage because another plugin instance owns it.
   */
  private async conflict(
    sessionID: string,
    expectedTitle: string | undefined,
    state: SessionState,
  ): Promise<string | undefined> {
    if (state.locked) return "session locked while applying title"
    const stored = await this.deps.store.readStored(sessionID)
    if (stored?.locked) {
      state.locked = true
      return "session locked while applying title"
    }
    let latest: SessionTitleInfo
    try {
      latest = await this.deps.readSession(sessionID)
    } catch (error) {
      this.deps.log(`could not re-read session ${sessionID} before renaming`, error)
      return "could not verify the session title"
    }
    if (latest.title !== expectedTitle) return "title changed while applying title"
    return undefined
  }

  /** Undo the provenance marker and restore turn counters after an aborted write. */
  private async restoreWrite(
    sessionID: string,
    state: SessionState,
    attemptedTitle: string,
    previousLastWrite: string | undefined,
    turnsToRestore: number,
  ): Promise<void> {
    if (state.lastWrite === attemptedTitle) {
      if (previousLastWrite === undefined) delete state.lastWrite
      else state.lastWrite = previousLastWrite
    }
    if (turnsToRestore > 0) state.turns += turnsToRestore
    await this.deps.store.save(sessionID, state)
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
  if (config.builtinGraceMs !== defaultConfig.builtinGraceMs) {
    parts.push(`builtinGrace=${config.builtinGraceMs}`)
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
    child?: boolean
    lastWrite?: string
    baseline?: string
  },
  config: RetitleConfig,
  currentTitle?: string,
): string {
  const lines = [
    `Title origin: ${titleOrigin(state, currentTitle)}`,
    state.child
      ? "Retitling: disabled (subagent session)"
      : state.locked
        ? "Retitling: paused (run /retitle-enable)"
        : "Retitling: active",
    `Turns since retitle: ${state.turns}${config.turns > 0 ? ` of ${config.turns}` : ""}`,
  ]

  if (state.forkPending) lines.push("Fork pending: yes")

  const changes = describeConfig(config)
  if (changes !== undefined) lines.push(`Config: ${changes}`)

  return lines.join("\n")
}
