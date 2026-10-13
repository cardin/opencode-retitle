import { DEFAULT_BUILTIN_GRACE_MS } from "./config.ts"

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

/**
 * Storage key prefix for "built-in title generation in flight" markers.
 *
 * OpenCode runs one plugin instance per open location and delivers *every*
 * event to *every* instance, so a marker that lives only in memory is invisible
 * to the instances that did not serve the title request. They then receive the
 * resulting rename with no marker to explain it and mistake it for a manual
 * rename, locking the session. Keeping the marker in shared storage makes every
 * instance agree on the same attribution.
 */
export const BUILTIN_PREFIX = "builtin/"

/** Read the timestamp out of a stored built-in-pending marker. */
function builtinPendingAt(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const at = (value as { at?: unknown }).at
  return typeof at === "number" ? at : undefined
}

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
  private readonly builtinTtlMs: number
  private writes: number

  constructor(storage: StorageLike, builtinTtlMs: number = DEFAULT_BUILTIN_GRACE_MS) {
    this.storage = storage
    this.cache = new Map()
    this.persisted = new Set()
    this.builtinTtlMs = builtinTtlMs
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

  /**
   * Record that the built-in title generator is producing a title for this
   * session. Written straight to shared storage — and read back the same way —
   * so every plugin instance sees the same marker.
   */
  async markBuiltinPending(sessionID: string, now: number = Date.now()): Promise<void> {
    await this.storage.set(BUILTIN_PREFIX + sessionID, { at: now })
  }

  /**
   * Whether a built-in title generation for this session is recent enough to
   * attribute the next rename to OpenCode. Expired markers are removed. This
   * never uses the in-memory cache: another instance may have written it.
   */
  async isBuiltinPending(sessionID: string, now: number = Date.now()): Promise<boolean> {
    const value = await this.storage.get(BUILTIN_PREFIX + sessionID)
    const at = builtinPendingAt(value)
    if (at === undefined) return false
    if (now - at >= this.builtinTtlMs) {
      await this.storage.remove(BUILTIN_PREFIX + sessionID)
      return false
    }
    return true
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

    let afterBuiltin: string | undefined
    do {
      const page = await this.storage.scan({
        prefix: BUILTIN_PREFIX,
        limit: 200,
        ...(afterBuiltin === undefined ? {} : { after: afterBuiltin }),
      })
      for (const entry of page.entries) {
        const at = builtinPendingAt(entry.value)
        if (at === undefined || now - at >= this.builtinTtlMs) await this.storage.remove(entry.key)
      }
      afterBuiltin = page.next
    } while (afterBuiltin !== undefined)
  }
}
