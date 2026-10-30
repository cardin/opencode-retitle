/**
 * Recognition of title shapes produced by OpenCode itself.
 *
 * The V2 server titles a session `` `${parentID ? "Child" : "New"} session - ${ISO}` ``
 * and derives fork titles as `<base> (fork #N)`. Both are stable, so a title that
 * matches neither, was not written by us, and did not come from the built-in
 * title generator is treated as a human/foreign rename.
 */
export const DEFAULT_TITLE_RE =
  /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export const FORK_TITLE_RE = /\(fork #\d+\)$/

export function isDefaultTitle(title: string): boolean {
  return DEFAULT_TITLE_RE.test(title)
}

export function isForkTitle(title: string): boolean {
  return FORK_TITLE_RE.test(title)
}

export type TitleSource = "self" | "default" | "fork" | "builtin" | "foreign"

export interface ClassifyInput {
  /** The new title reported by a `session.renamed` event. */
  title: string
  /** The last title this plugin wrote for the session, if any. */
  lastWrite?: string
  /** Whether the built-in title generator is known to be producing a title now. */
  builtinPending: boolean
  /** Whether the session is already locked. */
  locked: boolean
  /** Whether a foreign title should lock the session. */
  respectManualRename: boolean
}

export interface ClassifyResult {
  source: TitleSource
  /** The lock state after this change. */
  locked: boolean
}

/**
 * Attribute a title change by elimination. We cannot tell a manual rename apart
 * from another plugin or the user prompting the agent to rename; all three are
 * "a meaningful title was set by someone else", which is the signal we act on.
 */
export function classifyTitleChange(input: ClassifyInput): ClassifyResult {
  const { title, lastWrite, builtinPending, locked, respectManualRename } = input

  // A blank title is "unset", not a human rename. OpenCode can emit an empty
  // title while clearing a session, and locking on it would pause retitling
  // forever even though there is nothing to protect.
  if (title.trim() === "") {
    return { source: "default", locked }
  }
  if (lastWrite !== undefined && title === lastWrite) {
    return { source: "self", locked }
  }
  if (isDefaultTitle(title)) {
    return { source: "default", locked }
  }
  if (isForkTitle(title)) {
    return { source: "fork", locked }
  }
  if (builtinPending) {
    return { source: "builtin", locked }
  }
  return { source: "foreign", locked: locked || respectManualRename }
}
