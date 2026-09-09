# Meldrix AI for VS Code ✦

All-in-one AI assistant for Visual Studio Code — Claude, Gemini & Grok in one
workspace, with agentic tools, GitHub editing, image/video generation, TTS and
music.

This extension is the **VS Code client** for the Meldrix backend
(https://meldrix.com). It connects to your Meldrix account, fetches your
subscription plan from the backend database, and unlocks features based on
that plan.

---

## Features

- 🤖 **Multi-model chat** — route to Claude, Gemini or Grok (or let the backend decide).
- ⚡ **Streaming responses** — token-by-token, Cline-style.
- 🧰 **Agentic tools** — the AI can read/write/edit files, list directories,
  run terminal commands, and search the workspace.
- 🔐 **Secure auth** — token stored in VS Code SecretStorage (OS keychain).
- 💳 **Plan-aware** — your subscription plan (free / pro / ultimate) is fetched
  from the backend DB and gates which tools are available.
- 🧭 **Two surfaces** — a sidebar view (activity bar) and a full editor panel.

---

## Quick start (development)

```bash
npm install
npm run compile
```

Then press `F5` (run Extension Development Host), or build the VSIX:

```bash
npm install -g @vscode/vsce
vsce package          # produces meldrix-ai-x.x.x.vsix
```

Install locally: VS Code → Extensions → `...` → **Install from VSIX**.

---

## Backend contract

The extension expects your Meldrix backend to expose these endpoints
(configure the base URL via `meldrix.apiBaseUrl`, default `https://meldrix.com`):

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/auth/login` | none | Body `{ email, password }` → returns `{ token }` |
| GET  | `/api/plan` | Bearer | Returns the user's plan, read from your DB |
| POST | `/api/chat` | Bearer | Body: `{ messages, tools, model }` → streams SSE |

### `GET /api/plan` response shape

```json
{
  "plan": "pro",
  "planName": "Pro",
  "features": {
    "chat": true,
    "tools": true,
    "github": false,
    "imageGeneration": false,
    "videoGeneration": false,
    "tts": true
  },
  "limits": { "messagesPerDay": 500, "usedMessages": 12 },
  "renewsAt": "2026-10-01T00:00:00Z"
}
```

### `POST /api/chat` streaming

Return `text/event-stream` frames:

```
data: {"content":"Hello"}

data: {"content":" world"}

data: [DONE]
```

To trigger a tool call, emit:

```
data: {"tool_call":{"id":"1","name":"read_file","arguments":{"path":"src/app.ts"}}}
```

---

## Plan tiers & tool gating

| Tool | Free | Pro | Ultimate |
|------|:----:|:---:|:--------:|
| `read_file` | ✅ | ✅ | ✅ |
| `list_files` | ✅ | ✅ | ✅ |
| `search` | ✅ | ✅ | ✅ |
| `write_file` | ❌ | ✅ | ✅ |
| `edit_file` | ❌ | ✅ | ✅ |
| `run_command` | ❌ | ❌ | ✅ |

---

## Extension settings

| Setting | Default | Description |
|---------|---------|-------------|
| `meldrix.apiBaseUrl` | `https://meldrix.com` | Backend API base URL |
| `meldrix.authToken` | `""` | Optional static token (auto-saved after login) |
| `meldrix.model` | `auto` | `auto` / `claude` / `gemini` / `grok` |

---

## Project structure

```
.
├── package.json          # manifest: commands, views, config
├── tsconfig.json
├── media/
│   ├── icon.svg          # activity bar icon
│   ├── webview.js        # chat UI client
│   └── webview.css
└── src/
    ├── extension.ts      # activate, commands, views, chat loop
    ├── auth.ts           # secure token storage
    ├── api.ts            # login / plan / streaming chat
    ├── tools.ts          # agentic tool registry
    ├── ui.ts             # shared webview HTML
    └── types.ts
```

---

## Publishing to the Marketplace

```bash
# 1. create a publisher: https://marketplace.visualstudio.com/manage
# 2. login and publish
vsce login meldrix
vsce publish
```

---

## License

MIT © Meldrix AI