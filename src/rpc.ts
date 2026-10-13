import { Rpc } from "@opencode/plugin/rpc"

const sessionInput = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
}

const textOutput = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
}

/**
 * Contract shared by the server half (which implements it) and the TUI half
 * (which calls it). A server plugin cannot print to the terminal, so the report
 * is returned over RPC and rendered by the TUI plugin as a toast.
 */
export const Retitle = Rpc.define({
  id: "opencode-retitle",
  methods: {
    status: { input: sessionInput, output: textOutput },
    enable: { input: sessionInput, output: textOutput },
  },
  events: {},
})

export interface RetitleTextResult {
  text: string
}
