# dsh-saynext

[中文](README.md) · [English](README.en.md)

Adds a "next line" to the DSH composer: after each turn finishes normally, it guesses the sentence you are most
likely to say next and leaves it just above the input box. Press **Enter** to drop it into the composer
(**nothing is sent**); press **Enter** again to send.

![suggestion / 建议内容](https://raw.githubusercontent.com/mantonlove/dsh-saynext/main/assets/saynext.png)

> The grey line inside the red box is the suggestion. While it sits above the composer it takes no focus
> and swallows no keys — you can ignore it entirely.

## What it does

- When a turn ends **normally**, the host asks the model once, using the last 4 turns of that session, for
  one sentence you could send as-is.
- When the composer is empty and no turn is running, that sentence shows as a grey pill above the composer.
- Enter while the composer has focus: the sentence is copied into the composer and **not sent**; a second
  Enter sends it.
- Enter anywhere else (sidebar search, settings field, rename box): the plugin ignores the key, the pill stays put,
  and that control behaves exactly as before.
- The pill hides itself while the composer already has text or while a turn is still streaming.
- When a new turn ends, the previous suggestion is taken down first and the new one appears once it is ready,
  so you never paste a sentence that already went stale.

## Install

Published on npm: <https://www.npmjs.com/package/dsh-saynext>

```bash
cd ~/.dsh/profiles/desktop
pnpm add dsh-saynext
```

Then add `dsh-saynext` to the `dsh.profile.bundles` array in `package.json` and run `pnpm install` once more.
Once the plugin is listed, you can also install it from **Settings → Plugin Market** by searching for
`dsh-saynext`.

For local development a link is easier:

```json
"dsh-saynext": "link:/absolute/path/to/dsh-saynext"
```

`lib/index.js` imports `@deepseek-ai/schemastery` at runtime (shipped inside DSH, declared as a peer dependency
so you do not end up with a second copy). npm installs that peer for you; this profile has automatic peer installation
turned off, so pnpm adds no second copy and DSH's own runtime copy is used. With a link install where Node
cannot resolve it, add one symlink:

```bash
cd /absolute/path/to/dsh-saynext   # the next command must run in this directory
mkdir -p node_modules/@deepseek-ai
ln -s ~/.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery \
      node_modules/@deepseek-ai/schemastery
```

## One full interaction

1. You send a message and wait for the answer.
2. The turn ends and the composer is empty — a grey pill appears above it (e.g. `新增 publish.yml，实现 tag 触发自动发布`).
3. Press Enter: the sentence lands in the composer, cursor at the end, **nothing sent**.
4. Edit it or send it with a second Enter.
5. Do not want it? Delete and type your own; the next turn produces a fresh one.

## Three knobs

All live in the mount block of `~/.dsh/profiles/desktop/cordis.patch.yml`; a window reload picks them up
(`enabled` and the cooldown sit on the host side and need an app restart):

```yaml
- insert:
  - id: saynext
    name: dsh-saynext
    config:
      enabled: true            # false stops all model calls
      cooldownMs: 0            # minimum gap between two requests for the same session, 0 = no limit
      minTranscriptChars: 40   # skip turns whose transcript is shorter than this
```

## Payload

There is exactly one channel between host and UI: the `hint` field of the plugin's settings namespace
`saynext`, holding a JSON string shaped like `{"rev": 4, "items": [ … ]}`. Each entry in `items` carries:

| Field | Meaning |
| --- | --- |
| `sessionId` | which session the suggestion belongs to |
| `text` | the suggested sentence |
| `turn` | the turn that produced it |
| `rev` | payload revision, used by the UI to detect changes |
| `at` | creation timestamp in milliseconds |

The UI reads this configuration once a second and only accepts the entry whose `sessionId` matches the
current session, so several sessions running in parallel never see each other's suggestion.

## Where the data goes

- Each generation sends **the last 4 turns of that session** (at most 4000 characters) to the **provider / model
  configured for that session in DSH** — nowhere else.
- The result is stored as a small JSON string in the plugin's own namespace `saynext.hint`, inside the DSH profile
  configuration; nothing is written into your project directory.
- The trace log is off by default. With `DSH_SAYNEXT_TRACE=1` it goes to `~/.dsh/saynext/trace.log`
  (directory 0700, file 0600) and records **only the length of the suggestion, never its text**.

## Boundaries

| Situation | Behaviour |
| --- | --- |
| Turn did not end normally (aborted, failed) | no new suggestion; the next normal turn computes a fresh one |
| A turn is streaming | pill hidden, no interference |
| Composer already has text | pill hidden, no interference |
| Focus outside the composer | the plugin does not intercept that key; the pill stays put |
| Several sessions open | one suggestion each, up to 8 cached; a refreshed session moves to the back, so it is not evicted first |
| Session declares no model (header has no provider/model) | no suggestion, no guessed default |
| Upstream stream fails or times out | no suggestion for that turn — a half sentence is never pasted |

Be clear about the cost: **one extra model call after every turn** (last 4 turns of that session, at most
4000 characters in, 400 tokens out, 20 second timeout). Those tokens are billed to you. If you do not want
it, uninstall the plugin.

## Development

```
lib/index.js     host: watch turn/end, call the model, write `hint`
lib/client.js    UI: read `hint`, draw the pill, intercept Enter
cordis.patch.yml mount declaration
assets/          screenshot
```

- Changing `lib/index.js` (host) needs an **app restart**; host plugins load once at startup.
- Changing only `lib/client.js` (UI) needs a window reload.

After installation the mount block appears in `~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- insert:
  - id: saynext
    name: dsh-saynext
```

To debug, start with `DSH_SAYNEXT_TRACE=1` and the host writes each step to `~/.dsh/saynext/trace.log`
(0600, lengths only, no text); by default it writes nothing.

## License

MIT, see [LICENSE](LICENSE).
