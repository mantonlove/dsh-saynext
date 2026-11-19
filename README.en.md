# dsh-saynext

[中文](README.md) · [English](README.en.md)

**When an answer ends, your next sentence appears in the input box.**
Press Enter once to keep it, press again to send — it never decides for you, it only suggests what to say.

![A grey suggestion: press Enter to move it into the input box, press Enter again to send](https://raw.githubusercontent.com/mantonlove/dsh-saynext/main/assets/saynext.png)

## What it solves

Every time DSH finishes an answer you have to rebuild the next line: follow up, ask it to continue, or change direction.
This plugin spends that idle moment guessing the line from the session's recent context,
and writes it where the placeholder normally sits.

- Right guess: one Enter and you skip the typing.
- Wrong guess: ignore it, or just start typing — it steps aside on its own.
- It **never sends for you**: the first Enter only moves the text into the input box.

## Three moves

1. A turn finishes normally → one grey line appears in the input box. Generation takes a moment; if it fails or times out, that turn is skipped and nothing partial is written.
2. Press **Enter** → that line becomes your draft, cursor at the end, **nothing is sent**.
3. Edit it if you like; press **Enter** again to actually send.

When focus is elsewhere (sidebar search, settings field, rename box), the plugin leaves Enter alone and that control behaves as usual.

## Highlights

- **Inside the input box**: same slot as the host placeholder, so it adds no height and never collides with the goal bar, todo list, or queued messages.
- **Never steals focus or keys**: the grey line is display-only; clicks and ordinary typing pass through to the composer. The plugin takes over exactly one key: the Enter you press inside the composer to accept the suggestion.
- **Per-session**: with several sessions open, each shows its own suggestion; session A's guess never lands in session B's composer.
- **No stale text**: when a new turn ends, the previous suggestion is taken down first, then the new one appears.
- **No repeats**: if the model returns the same sentence twice in a row, it retries once with that sentence excluded; a second duplicate is dropped.
- **Control when it runs and what it costs**: turn it off entirely, set a cooldown (it gates the first request of a turn; the same-turn retry is not gated), a minimum transcript length, and a timeout — one model call per finished turn that is not skipped, plus one retry only if the generated line repeats the previous one.
- **Auditable**: the trace log is on by default; it mainly records session id, turn number, suggestion length, the chosen provider / model and a few status lines — never the conversation text.

## Install (the npm registry; the DSH profile itself uses pnpm)

**Plugin market** (once listed): Settings → Plugin market → search `dsh-saynext` → install.

**npm**:

```bash
cd ~/.dsh/profiles/desktop
pnpm add dsh-saynext
```

Then add `dsh-saynext` to the `dsh.profile.bundles` array in `package.json` and run `pnpm install` once.

**Local development** with `link`:

```json
"dsh-saynext": "link:/absolute/path/to/dsh-saynext"
```

`lib/index.js` uses the runtime-provided `@deepseek-ai/schemastery`, declared as a peer dependency so the plugin does not bundle its own nested copy. Package managers normally install that peer automatically (the npm CLI does); this profile relies on the DSH runtime instead because its pnpm has `autoInstallPeers` off.
With a `link` install: put the dependency entry under `dependencies` in the profile's `package.json`, add `dsh-saynext` to `dsh.profile.bundles`, and run `pnpm install`. If Node still cannot resolve the runtime package from the project directory, add the symlink below.

First check that the link target exists: `ls ~/.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery`. If it is missing, point the link at your actual runtime path instead (for example `~/.dsh/dsh-runtimes/<runtime>/dependencies/node_modules/@deepseek-ai/schemastery`).

```bash
cd /absolute/path/to/dsh-saynext   # the next command must run inside the project
mkdir -p node_modules/@deepseek-ai
ln -s ~/.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery \
      node_modules/@deepseek-ai/schemastery
```

Host-side changes need an app restart; UI-only changes (`lib/client.js`) need a window refresh.

## How it works

```
turn ends normally ──► take the last 4 turns of this session (up to 4000 chars)
                            │
                            ▼
                 ask once, using that session's own provider / model
                            │
                            ▼
        write into the plugin config namespace `saynext.hint` (a small JSON)
                            │
                            ▼
     the UI reads it once a second, keeps only this session's entry, draws it grey
```

- Only `turn/end` with `reason.kind === 'completed'` triggers it; interrupts and errors produce nothing, and nothing is guessed.
- Generation uses the streaming API; on error or timeout the partial text is discarded — **an unfinished sentence is never put in your input box**.
- If a session declares no provider / model, the plugin skips it rather than falling back to a default.

## Configuration

In the mount block of `~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- insert:
  - id: saynext
    name: dsh-saynext
    config:
      enabled: true            # false = never call the model
      cooldownMs: 0            # minimum gap between the first requests of consecutive turns of the same session, measured from the start of the turn's attempt; the same-turn retry is not gated; 0 = no limit
      minTranscriptChars: 40   # shorter transcripts are not worth asking about
      timeoutMs: 20000         # per-generation timeout; when it fires the plugin stops waiting and drops the result, without relying on upstream honouring abort
```

All four live in the mount block and are read when the plugin loads; a change takes effect after the plugin reloads (restarting the app is the simplest way). Client-side changes only need a window refresh.

The plugin declares the DSH range `>=0.2.0-rc.2 <0.4.0-0`; DSH outside that range will not load it.

## Privacy and cost

- Only **this session's recent conversation text** is sent to the provider / model you configured in DSH for that session. The plugin has no outbound endpoint of its own (no server, no relay); if the provider you configured is itself a third-party service, that text travels under that service's terms.
- The result is a small JSON blob stored in the plugin's own config namespace `saynext.hint`, inside your DSH profile config, not in the project directory.
- The trace log goes to `~/.dsh/saynext/trace.log` by default (the log directory is created with mode 0700, the file with 0600; the size is checked every 200 writes, so a file past 512 KB is rotated at that check, not necessarily on the very next write). It **never records conversation text**: only session id, turn number, suggestion length, the chosen provider/model (with its source) and a few status lines (`apply`, `bus attach`, `skip short transcript`, `publish try`); set `DSH_SAYNEXT_TRACE=0` to disable it.
- A finished turn that is not skipped costs one extra model call: up to 4000 characters of conversation text to build the request, 400 output tokens (the sentence itself is capped at 160 characters), 20 s timeout. If the generated line is identical to the previous one, the plugin retries once with “avoid the previous line”, so in the worst case a turn costs two calls. That usage is billed to your own account.

## Boundaries

| Situation | Behaviour |
| --- | --- |
| A turn does not finish cleanly (interrupt, error) | No new suggestion; the next clean turn recomputes it |
| A turn is streaming | The grey line hides; reading is not interrupted |
| The composer already has text | The grey line hides and the placeholder returns |
| Focus is not in the composer | The key is not intercepted; the grey line stays put |
| Several sessions at once | One suggestion per session, up to 8 cached; recently updated ones move to the back of the eviction queue |
| Session declares no provider / model | Nothing is generated; no default is invented |
| Upstream error or timeout | No suggestion for that turn; no partial sentence is inserted |
| The UI cannot set the draft | The grey line is not drawn at all (showing it would be worse) |
| Plugin disabled, cooldown not elapsed, or transcript too short | Skipped entirely; no model call |
| The previous suggestion for this session is still being generated | Skipped; nothing is queued and no parallel call is made |
| The host rebuilds the composer layer | It re-locates within a second and recovers |

## FAQ

**No grey line after refreshing?**
Check three things: the composer is empty, no turn is running in that session, and the last turn ended normally. Generation waits for the model; a failure or timeout skips that turn and never writes a partial line.

**The guess is off.**
It only sees this session's recent context, not your long-term preferences. Treat it as a draft prompt: you can edit it, or delete the whole line and write your own.

**Will it send the message for me?**
No. The first Enter only writes into the input box; sending always needs your second press.

**How do I turn it off completely?**
Set `enabled: false` to stop model calls, or remove `dsh-saynext` from `dsh.profile.bundles`.

## Development

```
lib/index.js     host: listen for turn/end, call the model, write `hint`
lib/client.js    UI: read `hint`, draw the grey line, take over Enter
cordis.patch.yml mount declaration
assets/          README illustration
docs/            optimisation list (past review record)
```

The event listener is attached to both `ctx` and `ctx.root`: the kernel dispatches `session/event` by bubbling from the ctx that entered the session,
so a listener on a side branch can miss every event right after startup. Attaching to root normally receives them under the current bubbling behaviour, and duplicates are dropped by turn number; if it still misses, the fallback below applies.
If neither receives anything, the plugin re-checks at 8 s and 30 s: when the session list is non-empty but no event arrived, it re-attaches on root and on the session store and writes `bus silent` / `bus attach` to the trace.

Start debugging with `~/.dsh/saynext/trace.log`; set `DSH_SAYNEXT_TRACE=0` if you would rather not keep it.

## License

MIT, see [LICENSE](LICENSE).
