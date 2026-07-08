# Mothership — Relay

> **Chat your way to real, editable Figma nodes — and tidy or edit *any* Figma design, whether Mothership made it or not.**
> 設計の原本(JSON)を、編集できる本物のFigmaノードへ翻訳する母艦。作るだけでなく、**どんなFigmaデザインでも整える・会話で直せる**。 — Kinoshita Studio

*(The name is from the Dance Gavin Dance album "Mothership".)*

This repository is the **local relay** for the Mothership Figma plugin. The relay runs on your machine and bridges the plugin to **your own Claude Code (Pro/Max)** — so all AI runs on your subscription, with **no extra API cost** and **no developer backend**.

- **Plugin (get it here):** https://www.figma.com/community/plugin/1650150569984509789
- **Site / docs:** https://kinoshita.studio/mothership/

---

## What it is

One **Mothership JSON** is the single source of truth. Claude Code edits it "the same way it writes code," and the relay ships it into Figma as native nodes.

```
mothership.json   ← Claude Code edits it directly (no MCP)
   ├─► Figma      … the plugin builds native nodes (text / auto-layout, still editable)
   ├─► Code       … HTML / React (planned)
   └─► SVG        … helper output for illustration (planned)
```

Two more powers that don't even need Mothership-made frames:

- **Clean up (Lint & Fix)** — select *any* frame → scan → fix in one click (naming, font drift, sub-pixels, stray layers, auto-layout, 8pt spacing).
- **Edit by chat** — "make the heading bigger, CTA green" on any frame, external banners and hand-drawn frames included. Photos preserved.

It is **local and yours.** Nothing is stored on a server. Only the *structure* of the frame you act on is passed to your own Claude Code.

---

## Two ways to use it

| | Setup | AI needed? |
|---|---|---|
| **⚡ Try the sample** | None — open the plugin, hit **Build sample** | No (works with zero setup) |
| **Live mode** | This relay + Claude Code | Yes — runs on your Claude Code (Pro/Max) |

The rest of this README is about **Live mode**.

---

## Prerequisites (Live mode)

1. **Claude Code (Pro or Max)** — installed **and logged in**. This is the brain. Verify with:
   ```bash
   claude --version   # should print a version, e.g. 2.1.x (Claude Code)
   ```
   If it's missing, install & sign in: https://claude.com/claude-code
2. **Node.js 18+** — to run the relay. Verify: `node --version`.
3. **Figma** (desktop app) with the **Mothership plugin** installed from the Community link above.

---

## Setup — connect in ~3 minutes

**1. Get this relay**
```bash
git clone https://github.com/kinoshitastudio/mothership-relay.git
cd mothership-relay
npm install          # pulls playwright (used by URL → Figma). Core chat/edit works without it too.
```
*(Prefer no git? Use the green **Code → Download ZIP** button, unzip, then `cd` in.)*

**2. Make it always-on (recommended)**

Register the relay to **auto-start at login** — and auto-restart if it ever crashes — so you never have to keep a terminal open. Run this **once**:
```bash
node setup.js
# ✅ registers login auto-start (macOS LaunchAgent / Windows Startup) and starts it now
```
- **Check status:** `node setup.js --status`
- **Uninstall (stop auto-start):** `node setup.js --uninstall` — removes only the registration; fully reversible, nothing else touched.

Prefer to just run it yourself once, without auto-start? That works too:
```bash
node relay.js
# ▲ Mothership relay  →  http://localhost:4575
# ✅ claude CLI OK (2.1.x (Claude Code)) — AI features ready
```
The `✅ claude CLI OK` line means the AI (build / tidy / edit) can run. If you see `⚠️ claude CLI not found`, install & log in to Claude Code first (step 1).

**3. Connect in Figma**
Run the Mothership plugin → next to `http://localhost:4575` press **Connect**. When it turns a green **Connected**, live sync is on.

**4. Talk to it**
In the panel chat: *"make a simple 3-plan pricing table."* Claude edits the source and it's generated **natively** into Figma. From then on, every change to the source applies automatically.

---

## What you can do

- **Build by chat** — describe a screen; it lands as real, editable Figma layers.
- **Clean up (Lint & Fix)** — deterministic, local, zero external send. Works on any frame.
- **Tidy with AI / Edit by chat** — Claude reads the selected frame's structure and tidies or edits per your instruction. External & hand-made frames welcome; photos preserved.
- **URL → Figma** — paste a URL; the relay captures the page and Claude rebuilds it as editable layers (real images included). *(Needs `npm install` for playwright.)*
- **Tokenize / Text styles** — turn a real design's colors into Figma Variables and text into Text Styles — the seed of your own design system.

---

## Privacy & security

- **No developer backend.** The relay runs only on your machine (`localhost:4575`).
- **AI runs on *your* Claude Code.** The relay spawns `claude -p` locally; nothing is sent to a Kinoshita Studio server.
- **Structure only.** AI tidy/edit passes the *structure* of the selected frame to your Claude Code — not raw images or binaries.
- **Nothing is stored** beyond the local files you create (`mothership.json`, `library/*.json`), which stay on your disk and are git-ignored here.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Plugin shows **"waiting for relay…"** | The relay isn't running. In this folder: `node setup.js --status` to check; if it's not running, `node setup.js` (or a one-off `node relay.js`). |
| **`⚠️ claude CLI not found`** on startup | Install & log in to Claude Code (Pro/Max): https://claude.com/claude-code — then re-run `node relay.js`. |
| Build / edit fails with **"claude not found"** | Same as above — `claude` must be in your PATH and logged in. |
| **Port 4575 in use** | Quit the other relay, or free the port. Only one relay is needed. |
| **URL → Figma** does nothing | Run `npm install` (installs playwright), then retry. |

---

## Notes

- The **plugin itself** (the panel UI) is distributed via Figma Community — you don't build it from here. This repo is only the **relay + prompt (`CLAUDE.md`) + helper tools** you run locally.
- `CLAUDE.md` is the behavior prompt the relay hands to Claude Code. Tweak it to change how Mothership thinks.
- Feedback / bugs: 99letters99@gmail.com

A **Kinoshita Studio** product · License: ISC
