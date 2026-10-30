import { Plugin } from "@opencode/plugin/tui"

import { Retitle, type RetitleTextResult } from "./rpc.ts"

type Location = NonNullable<Plugin.Context["location"]>

interface RetitleClient {
  status(
    input: { sessionID: string },
    options: { location: Location },
  ): Promise<RetitleTextResult>
  enable(
    input: { sessionID: string },
    options: { location: Location },
  ): Promise<RetitleTextResult>
}

/**
 * TUI half. A server plugin has no way to display text, so the slash commands
 * live here and render results with a toast. The data comes from the server
 * half over RPC, and a toast never schedules a model run.
 */
export default Plugin.define({
  id: "opencode-retitle.tui",
  setup(context) {
    // Resolve the RPC client per call: a TUI can reconnect or switch servers
    // while this plugin instance stays loaded.
    const retitleClient = (): RetitleClient =>
      context.client.rpc(Retitle) as unknown as RetitleClient

    const toast = (message: string, sessionID?: string): void => {
      context.ui.toast.show({
        title: "opencode-retitle",
        message,
        ...(sessionID === undefined ? {} : { sessionID }),
      })
    }

    const currentSession = (): string | undefined => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    // A TUI can have several locations open, and a remote server has its own.
    // Send the session's location with every RPC so the call reaches the plugin
    // instance that owns this session instead of the default location's instance.
    // The session cache may not have this session yet; sync it first.
    const currentLocation = async (sessionID: string): Promise<Location> => {
      let session = context.data.session.get(sessionID)
      if (!session) {
        await context.data.session.sync(sessionID)
        session = context.data.session.get(sessionID)
      }
      return session?.location ?? context.location ?? context.data.location.default()
    }

    const run = async (
      label: string,
      call: (sessionID: string) => Promise<RetitleTextResult>,
    ): Promise<void> => {
      const sessionID = currentSession()
      if (!sessionID) {
        toast("No active session.")
        return
      }
      try {
        const result = await call(sessionID)
        toast(result.text, sessionID)
      } catch (error) {
        toast(
          `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
          sessionID,
        )
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "retitle.status",
          title: "Retitle: show title status",
          description: "Report whether this session's title was renamed manually",
          group: "Retitle",
          slash: { name: "retitle-status" },
          run: () =>
            run("Status", async (sessionID) =>
              retitleClient().status(
                { sessionID },
                { location: await currentLocation(sessionID) },
              ),
            ),
        },
        {
          id: "retitle.enable",
          title: "Retitle: re-enable retitling",
          description: "Clear a manual-rename pause and retitle this session now",
          group: "Retitle",
          slash: { name: "retitle-enable" },
          run: () =>
            run("Enable", async (sessionID) =>
              retitleClient().enable(
                { sessionID },
                { location: await currentLocation(sessionID) },
              ),
            ),
        },
      ],
    }))
  },
})
