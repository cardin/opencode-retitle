/** Durable, per-session bookkeeping for the plugin. */
export interface SessionState {
  /** Admitted user prompts seen for this session. */
  turns: number
  /** The last title this plugin wrote. */
  lastWrite?: string
  /** The last title OpenCode itself produced (default, fork, or built-in). */
  baseline?: string
  /** Set once a title we did not write appears and `respectManualRename` is on. */
  locked: boolean
  /** Set when a fork was observed, cleared when its first response is retitled. */
  forkPending: boolean
  /** Epoch ms of the last write, used for pruning. */
  updated: number
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface StorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: JsonValue): Promise<void>
  remove(key: string): Promise<void>
  scan(options: {
    prefix: string
    limit?: number
  }): Promise<{ entries: readonly { key: string; value: unknown }[]; next?: string }>
}

export const STORAGE_PREFIX = "session/"
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function emptyState(now: number): SessionState {
  return { turns: 0, locked: false, forkPending: false, updated: now }
}

export function isSessionState(value: unknown): value is SessionState {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    typeof v.turns === "number" &&
    typeof v.locked === "boolean" &&
    typeof v.forkPending === "boolean" &&
    typeof v.updated === "number"
  )
}

/**
 * In-memory cache in front of the plugin storage. Writes are write-through so a
 * plugin reload does not lose lock or turn state.
 */
export class StateStore {
  private readonly storage: StorageLike
  private readonly cache: Map<string, SessionState>
  private readonly persisted: Set<string>
  private writes: number

  constructor(storage: StorageLike) {
    this.storage = storage
    this.cache = new Map()
    this.persisted = new Set()
    this.writes = 0
  }

  async load(sessionID: string, now: number = Date.now()): Promise<SessionState> {
    return (await this.loadDetailed(sessionID, now)).state
  }

  /**
   * Like {@link load}, but also reports whether the state was restored from
   * storage. A non-persisted state means this is the first time the plugin has
   * seen the session.
   */
  async loadDetailed(
    sessionID: string,
    now: number = Date.now(),
  ): Promise<{ state: SessionState; persisted: boolean }> {
    const cached = this.cache.get(sessionID)
    if (cached) return { state: cached, persisted: this.persisted.has(sessionID) }

    const stored = await this.storage.get(STORAGE_PREFIX + sessionID)
    if (isSessionState(stored) && now - stored.updated < MAX_AGE_MS) {
      this.cache.set(sessionID, stored)
      this.persisted.add(sessionID)
      return { state: stored, persisted: true }
    }

    const fresh = emptyState(now)
    this.cache.set(sessionID, fresh)
    return { state: fresh, persisted: false }
  }

  /** Read without touching storage; returns undefined when nothing is cached. */
  peek(sessionID: string): SessionState | undefined {
    return this.cache.get(sessionID)
  }

  async save(
    sessionID: string,
    state: SessionState,
    now: number = Date.now(),
  ): Promise<void> {
    state.updated = now
    this.cache.set(sessionID, state)
    this.persisted.add(sessionID)
    await this.storage.set(STORAGE_PREFIX + sessionID, {
      turns: state.turns,
      locked: state.locked,
      forkPending: state.forkPending,
      updated: state.updated,
      ...(state.lastWrite === undefined ? {} : { lastWrite: state.lastWrite }),
      ...(state.baseline === undefined ? {} : { baseline: state.baseline }),
    })

    this.writes += 1
    if (this.writes % 50 === 0) await this.prune(now)
  }

  /** Remove cached and stored entries older than the retention window. */
  async prune(now: number = Date.now()): Promise<void> {
    for (const [id, state] of this.cache) {
      if (now - state.updated >= MAX_AGE_MS) {
        this.cache.delete(id)
        this.persisted.delete(id)
      }
    }

    let after: string | undefined
    do {
      const page = await this.storage.scan({
        prefix: STORAGE_PREFIX,
        limit: 200,
        ...(after === undefined ? {} : { after }),
      })
      for (const entry of page.entries) {
        const value = entry.value
        const updated = isSessionState(value) ? value.updated : 0
        if (now - updated >= MAX_AGE_MS) await this.storage.remove(entry.key)
      }
      after = page.next
    } while (after !== undefined)
  }
}
