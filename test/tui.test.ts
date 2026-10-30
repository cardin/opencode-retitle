import assert from "node:assert/strict"
import test from "node:test"

import tui from "../src/tui.ts"

interface Command {
  readonly id?: string
  readonly run: (input?: string, event?: unknown) => void | false | Promise<void>
}

test("resolves the RPC client per call and syncs an uncached session", async () => {
  const toasts: Array<{ message: string; sessionID?: string }> = []
  const synced: string[] = []
  let rpcCalls = 0
  let cached: { location: { directory: string } } | undefined
  let createLayer: (() => { commands?: readonly Command[] }) | undefined

  const context = {
    location: { directory: "/local" },
    client: {
      rpc() {
        rpcCalls += 1
        const version = rpcCalls
        return {
          async status(
            _input: { sessionID: string },
            options: { location: { directory: string } },
          ) {
            return { text: `client ${version} ${options.location.directory}` }
          },
          async enable() {
            return { text: "enabled" }
          },
        }
      },
    },
    data: {
      session: {
        get() {
          return cached
        },
        async sync(sessionID: string) {
          synced.push(sessionID)
          cached = { location: { directory: "/remote" } }
        },
      },
      location: {
        default() {
          return { directory: "/default" }
        },
      },
    },
    ui: {
      router: {
        current() {
          return { type: "session", sessionID: "ses_tui" }
        },
      },
      toast: {
        show(toast: { message: string; sessionID?: string }) {
          toasts.push(toast)
        },
      },
    },
    keymap: {
      layer(factory: () => { commands?: readonly Command[] }) {
        createLayer = factory
      },
    },
  }

  await tui.setup(context as never)

  const commands = createLayer?.().commands ?? []
  const status = commands.find((command) => command.id === "retitle.status")
  assert.ok(status)
  await status.run()
  await status.run()

  assert.equal(rpcCalls, 2, "the client is resolved for each call")
  assert.deepEqual(synced, ["ses_tui"], "the session is synced once before choosing a location")
  assert.deepEqual(
    toasts.map((toast) => toast.message),
    ["client 1 /remote", "client 2 /remote"],
  )
  assert.ok(toasts.every((toast) => toast.sessionID === "ses_tui"))
})
