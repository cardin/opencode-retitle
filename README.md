# opencode-retitle

Keep OpenCode session titles meaningful. `opencode-retitle` regenerates a
session title at three moments:

1. **After every N user turns** (default 5).
2. **After a compaction finishes.**
3. **After the first assistant response in a forked session.**

It also protects titles you set by hand: once a title it did not write appears,
retitling pauses for that session until you re-enable it.

## Install

### Published package

Once it is on npm, add it to `opencode.json(c)`:

```jsonc
{
  "plugins": ["opencode-retitle"]
}
```

### Local development checkout

OpenCode discovers plugins under `.opencode/plugins/` (project) and
`~/.config/opencode/plugins/` (global) in the same layout as a published package,
with the server and TUI entrypoints kept together. Point a two-file directory at
this checkout:

```text
~/.config/opencode/plugins/retitle/index.ts   # server half
~/.config/opencode/plugins/retitle/tui.ts     # TUI half
```

```ts
// index.ts
export { default } from "/absolute/path/to/opencode-retitle/src/index.ts"

// tui.ts
export { default } from "/absolute/path/to/opencode-retitle/src/tui.ts"
```

OpenCode 2.0.27 silently ignores a local directory referenced from the `plugins`
array, so the discovered directory above is the reliable way to load a working
copy. Restart OpenCode after adding it, or open a new session.

## Configuration

Settings resolve in this order (later wins):

1. built-in defaults
2. the first existing file among
   - `<project>/.opencode/retitle.jsonc`
   - `<project>/.opencode/retitle.json`
   - `~/.config/opencode/retitle.jsonc`
   - `~/.config/opencode/retitle.json`
3. `options` passed through `opencode.json(c)`

```jsonc
{
  "turns": 5,                    // retitle every N user prompts; 0 disables
  "onCompaction": true,          // retitle after a compaction
  "onFork": true,                // retitle after the first response in a fork
  "respectManualRename": true,   // pause retitling once a foreign title appears
  "lockExistingTitles": true,    // pause a session that already had a title when first seen
  "model": null,                 // "providerID/modelID"; null = the session's model
  "titleMaxLength": 60,
  "minPromptLength": 10,         // skip when there is too little user text
  "debug": false                 // log decisions to the OpenCode log
}
```

## Commands

Both commands are **TUI slash commands**, registered by the TUI half and rendered
as a toast. A server plugin has no way to display text, and `session.synthetic`
would either run the model or leave the note undelivered in the inbox; a toast
does neither.

- `/retitle-status` — report whether this session's title was set manually or by
  retitle, the turn count, and the active config. No model call.
- `/retitle-enable` — clear the manual-rename pause for this session and retitle
  now. Use this when you renamed a session by hand and want automatic retitling
  back. The one model call it makes is the title generation itself.

The server half implements an RPC (`id: "retitle"`, methods `status` and
`enable`) that the TUI half calls; `src/rpc.ts` is exported as `./rpc` so other
clients can use the same contract.

## How manual renames are detected

We cannot tell a manual rename apart from another plugin, or from you asking the
agent to rename the session. All three mean "a meaningful title is now in place",
which is exactly when retitling should stop. So the plugin attributes every
`session.renamed` event by elimination, using title shapes that OpenCode itself
produces:

| New title | Attributed to | Effect |
| --- | --- | --- |
| equals the last title we wrote | retitle | keep going |
| `New session - <ISO>` / `Child session - <ISO>` | OpenCode default | record baseline |
| `<base> (fork #N)` | OpenCode fork | record baseline |
| arrives while the built-in generator is running | OpenCode auto-title | record baseline |
| anything else | manual / external | **pause** (when `respectManualRename`) |

The built-in generator is observed through the `title` session hook. A title that
fits none of the rows above pauses retitling for that session; run
`/retitle-enable` to resume.

**Sessions the plugin meets mid-flight.** The first time the plugin sees a
session it seeds the turn counter from the existing conversation and inspects the
current title. A title that is not a default, a fork title, or one we wrote is
treated as manually chosen, so the session starts paused. This only affects a
session the plugin has never recorded; state is persisted, so a restart does not
re-trigger it.

This is the one case where an auto-generated title can be mistaken for a manual
one: if OpenCode generated the title before the plugin loaded, there is no way to
attribute it. Set `lockExistingTitles` to `false` to retitle such sessions
instead of pausing them.

## Behaviour notes

- Turn counting uses `session.inbox.enqueued` items of type `user`, so synthetic
  and command traffic does not inflate the count. On first sight the counter is
  seeded from the existing conversation.
- `session.created` initializes a new session at zero turns so the interval is
  measured from the start of the conversation.
- Fork retitling is armed by `session.forked` and fires on the next
  `session.step.ended`.
- Title generation reuses the session's current model unless `model` is set, and
  reads the recent transcript (code blocks stripped) to build a short title.
- State is persisted per session through plugin storage and pruned after 30 days.

## Development

```sh
npm install
npm run typecheck
npm test              # fast unit tests
npm run test:integration   # drives the real plugin wiring with a mock context
npm run test:all
```

`test:integration` imports `@opencode/plugin`, whose runtime keeps the process
alive for about 15 seconds after the tests finish; the unit tests are separate so
the default run stays fast.
