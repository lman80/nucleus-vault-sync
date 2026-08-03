# Nucleus Vault Sync

An Obsidian plugin that keeps your vault in **a database you own**, on your own machine — on your Mac, your iPhone and your iPad. No third-party sync service in the middle.

> **Why any of this exists:** https://github.com/lman80/data-layer-protocol/blob/main/WHY.md

## Setting it up

Install the plugin, open Obsidian, and the setup wizard appears.

1. **Where your Nucleus is, and the key.** Two boxes.
2. **Which notes.** It shows you the vaults already in your Nucleus, with a file count each — you pick one. You never type a name, and nothing has to match between devices. (If your Nucleus is empty, it offers to start a new one named after the folder.)
3. **What it will do.** It compares both sides and says so before doing anything.

The folder can be called whatever you like on each device.

You never have to decide "upload or download". It works that out:

| Your vault | Your Nucleus | What happens |
|---|---|---|
| empty | empty | Nothing to move. Sync is on; write a note and it goes up. |
| has files | empty | **Upload.** Everything goes up. Nothing here is touched. |
| empty | has files | **Download.** Your vault is rebuilt, folders and all. |
| has files | has files | **Careful merge.** See below. |

### The careful merge

This is where people lose work with other tools, so it is worth saying plainly what happens here.

When both sides already have files and this device has never synced before, there is **no record of when the two last agreed** — so nothing can be assumed, and nothing is overwritten:

- Files that match are left alone.
- Files that differ are kept **both ways**. Yours stays exactly as it is; the Nucleus version is saved next to it with `(conflict …)` in the name, for you to compare and merge yourself.
- Anything only one side has is copied to the other.

You will not silently lose a note. That rule lives in `core/decide.ts` and has tests covering every branch, including the ones that must do nothing.

## Installing

**Mac:**

```bash
npm install && npm run build
```

Then copy `main.js`, `manifest.json` and `styles.css` into
`<your vault>/.obsidian/plugins/nucleus-vault-sync/`, restart Obsidian, and enable it under **Settings → Community plugins**.

**iPhone / iPad:** the Files app cannot see inside `.obsidian`, so put the plugin folder there from a Mac — the same way you would move any file into the vault — and it appears on the phone. Then enable it in Settings.

## What it syncs, and what it does not

**Synced:** every note and every attachment — images, PDFs, canvases, video.

**Not synced, deliberately:**

- `.obsidian/` — your settings, themes, hotkeys and plugin configs. Devices legitimately differ, and syncing this is how you get a phone trying to load a desktop-only plugin.
- `.trash/` — Obsidian's own deleted-notes folder.
- Plugin caches (`.smart-env`, `.claude`, `.claudian`) — large, machine-specific, and regenerable.

## Large files on iPhone

Obsidian's built-in network calls pass data to the phone as base64, which runs the app out of memory somewhere above 20 MB. A vault with video in it hits that immediately.

So this plugin uses a **direct connection** for large attachments instead, which handles them fine — your Nucleus has to allow it, which it does if it is running the standard gateway config. If large files ever fail to transfer, turn off *Use direct transfers for big attachments* in settings; the plugin then refuses oversized files with a clear message rather than crashing Obsidian.

## When it syncs

On startup, a few seconds after you stop typing, and on a timer you choose. All three are optional. There is also a **Sync now** command and a ribbon button.

On iPhone and iPad, **nothing runs while Obsidian is in the background** — iOS suspends the app. Sync resumes when you next open it. Every pass is resumable, so an interrupted one costs nothing.

## Your key

It is stored in this plugin's `data.json`, inside the vault, **in plain text**. Obsidian offers no keychain, and every other plugin in the vault can read it. Use a credential you can revoke. This is stated rather than hidden because pretending otherwise would be worse.

## Layout

```
src/main.ts        plugin lifecycle, commands, when to sync
src/onboarding.ts  the setup wizard and the four situations
src/settings.ts    settings screen
src/client.ts      HTTP: Obsidian's requestUrl for data, direct fetch for big files
src/engine.ts      one pass, both directions, against the Obsidian vault API
src/core/          parsing and the conflict decision table — shared with the Mac
                   connector so both agree about what is safe. No Node APIs:
                   none of them exist on iOS.
```

`npm test` runs the decision-table tests. `npm run typecheck` checks both configs.
