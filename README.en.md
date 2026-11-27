# dsh-saynext

[中文](README.md) · [English](README.en.md)

**When an answer ends, your next sentence appears in the input box.**
Press Enter once to keep it, press again to send — it never decides for you, it only suggests what to say.

![A grey suggestion: press Enter to move it into the input box, press Enter again to send](https://raw.githubusercontent.com/mantonlove/dsh-saynext/main/assets/saynext.png)

## What it solves

Every time DSH finishes an answer you have to rebuild the next line: follow up, ask it to continue, or change direction.
This plugin spends that idle moment guessing the line from the session's recent context and writes it where the placeholder normally sits.
It does not settle for agreement: when the assistant is waiting on a choice it picks one and says why; when it delivered a result it names the check that proves it; when it drifted it asks for a rework.

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
- **Suggestions follow your goal**. The plugin reserves room for your messages. Suggestions use the conversation’s language to express a specific question, correction or request in plain terms. The model ranks replies against the current goal and new information. The client-facing suggestion is the first eligible reply in that order. A newly reported fee or error code can be relevant. A short confirmation can answer a request to start an operation the user already chose. For choices, personal claims and consequential changes, the generator can attach a supporting user quote for screening. Only the reply is displayed. Uncertain or completed turns can be left blank.
- **Bound to a turn**: every suggestion remembers the turn it belongs to. It shows only when it belongs to the
  session's latest turn, that turn ended normally, and the composer is empty. A new turn invalidates the old line
  immediately (read from the host timeline, not from polling); a failed, interrupted or timed-out turn shows the
  original placeholder instead of an older sentence. Enter re-checks the same condition.
- **A restart costs nothing**: a restart or hot reload never re-runs the model; it only shows a cache that is
  still valid for the current turn, otherwise it waits for the next normal finish. Retries during generation
  are described under cost control below — a turn costs at most three calls.
- **No repeats**. The plugin filters out the suggestion it last displayed in the session.
- An explicit new writing request starts fresh context for the suggestion. A short follow-up such as “继续” retains earlier turns. Screening checks whether a candidate would postpone the requested deliverable.
- **Control when it runs and what it costs**: turn it off entirely, set a cooldown (it gates the first request of a turn; the same-turn retries are not gated), a minimum transcript length, and a timeout. A finished, non-skipped turn sends one request. Any of the cases above triggers a retry with the reason attached, at most two retries, so a turn costs at most three calls.
- **Auditable**: the trace log is on by default; it mainly records session id, turn number, suggestion length, the chosen provider / model and a few status lines — never the conversation text.

## Install

**npm (three steps, easiest)**:

```bash
cd ~/.dsh/profiles/desktop
pnpm add dsh-saynext
```

Then add `dsh-saynext` to the `dsh.profile.bundles` array in `package.json` and run `pnpm install` once.

**Download page (optional)**: https://mantonlove.github.io/dsh-saynext/ . Pick sharing or local-only there, quit DSH, run the installation command shown for that choice in the download directory (Node.js and pnpm required), then reopen DSH. The installer enables the plugin and records the choice in this OS user's desktop profile. Local-only keeps samples on this machine; sharing starts syncing new turns. Check or stop it later under the suggestion statistics view.

**Plugin market** (once listed): Settings → Plugin market → search `dsh-saynext` → install.

**Local by default**: installing from npm or the market uploads nothing. Only a choice made on the download page starts uploading the shown suggestion, the message you then sent, and up to 1200 UTF-16 units of the previous context (see `docs/feedback.md`).

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
Tests live in the repo: `npm test` runs the UI, suggestion, session-context and evaluation suites on Node 22+ after installing the development dependencies.

## How it works

```
turn ends normally ──► read the session goal summary and the latest three paired turns
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
- A normal stop completes the final candidate even without a trailing newline. If the model hits its token limit, the stream is interrupted, or the request times out, only newline-terminated candidates enter ranking.
- If a session declares no provider / model, the plugin skips it rather than falling back to a default.

Type `/saynext-goal` in the conversation to inspect the goal, requirements, reported progress and open questions with source turns. Supply a new goal to correct it, or `clear` to resume automatic extraction. The normal DSH session log retains the correction across windows and restarts. The development [evaluation guide](docs/evaluation.md) describes the four metrics.

### Local usage statistics

Open **建议统计** in the conversation header (or its overflow menu) to see device totals or the current conversation. Display coverage counts visible suggestions per eligible composer round. Direct use counts verbatim text among confirmed subsequent sends. After the next confirmed send, the client estimates intent and serious errors independently using offline text rules and the preceding request. Each rate uses its own judged denominator. Partial intent matches are separate. Ambiguous or attachment-bearing sends can remain unjudged. Expand **依据与纠正** on a comparison to inspect the reasons, change either result or select **沿用自动** to restore its estimate. Prior manual labels are preserved. Reopening a conversation can backfill old displayed suggestions. IndexedDB stores suggestions, outcomes, reason codes and overrides on this device and origin. The actual message is read from the loaded conversation and is not copied to the statistics database. Grading does not call a model or upload statistics.

## Configuration

In the mount block of `~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- insert:
  - id: saynext
    name: dsh-saynext
    config:
      enabled: true            # false = never call the model
      cooldownMs: 0            # minimum gap between the first requests of consecutive turns of the same session, measured from the start of the turn's attempt; the same-turn retries are not gated; 0 = no limit
      minTranscriptChars: 40   # shorter transcripts are not worth asking about
      timeoutMs: 20000         # per-generation timeout; stops waiting and keeps newline-terminated candidates
```

All four live in the mount block and are read when the plugin loads; a change takes effect after the plugin reloads (restarting the app is the simplest way). Client-side changes only need a window refresh.

The plugin declares the DSH range `>=0.2.0-rc.2 <0.4.0-0`; DSH outside that range will not load it.

Desktop applies the download choice automatically. Suggestion Statistics shows the current choice and lets you change it. Fresh direct npm or market installs start local-only. Sharing starts with new turns after consent. It includes opportunities, displayed text, the next human message, fill and review outcomes, and up to 1,200 characters each from the current request and assistant reply. Attachments are flagged only. Stopping sharing clears the local upload queue. A build without a configured endpoint stays local.

## Privacy and cost

- Only **this session's summary, relevant references and recent conversation text** is sent to the provider / model you configured in DSH for that session. A build with an author feedback endpoint also transmits the disclosed samples after the user opts in; if the provider you configured is itself a third-party service, that text travels under that service's terms.
- The result is a small JSON blob stored in the plugin's own config namespace `saynext.hint`, inside your DSH profile config, not in the project directory.
- The trace log goes to `~/.dsh/saynext/trace.log` by default (the log directory is created with mode 0700, the file with 0600; the size is checked every 200 writes, so a file past 512 KB is rotated at that check, not necessarily on the very next write). It **never records conversation text**: only session id, turn number, suggestion length, the chosen provider/model (with its source) and a few status lines (`apply`, `bus attach`, `skip short transcript`, `publish try`); set `DSH_SAYNEXT_TRACE=0` to disable it.
- The three most recent turns receive 1,440, 900 and 550 UTF-16 code units respectively. The session summary and a relevant earlier reference are included separately. The output budget is 900 tokens and the default timeout is 20 seconds. The model can offer up to three lines, each limited to 40 Chinese characters and 80 code units. Empty output and an explicit skip end generation. When all candidates fail screening, the plugin retries at most twice and leaves the composer empty if none passes.

## Boundaries

| Situation | Behaviour |
| --- | --- |
| A turn does not finish cleanly (interrupt, error) | No new suggestion; the next clean turn recomputes it |
| A turn is streaming | The grey line hides; reading is not interrupted |
| The composer already has text | The grey line hides and the placeholder returns |
| Focus is not in the composer | The key is not intercepted; the grey line stays put |
| No conversation timeline available (version mismatch or a changed entry point) | The grey line is not drawn: better an empty composer than a line nobody can prove is current |
| Several sessions at once | One suggestion per session, up to 8 cached; recently updated ones move to the back of the eviction queue |
| Session declares no provider / model | Nothing is generated; no default is invented |
| Output limit reached, stream interrupted, or request timed out | Complete lines are still used as candidates; if none is complete, the placeholder stays (the previous turn's line has already expired with its turn) |
| The UI cannot set the draft | The grey line is not drawn at all (showing it would be worse) |
| Plugin disabled, cooldown not elapsed, or transcript too short | Skipped entirely; no model call |
| The previous suggestion for this session is still being generated | Skipped; nothing is queued and no parallel call is made |
| The host rebuilds the composer layer | It re-locates within a second and recovers |

## FAQ

**No grey line after refreshing?**
Check three things: the composer is empty, no turn is running in that session, and the last turn ended normally. If generation ended early before any candidate line was complete, the placeholder stays visible.

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
