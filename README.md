# Meldrix AI for VS Code ✦

All-in-one AI assistant for Visual Studio Code — Claude, Gemini & Grok in one
workspace, with agentic tools, GitHub editing, image/video generation, TTS and
music.

This extension is the **VS Code client** for the Meldrix backend
(https://meldrix.com). It connects to your Meldrix account, fetches your
subscription plan + unlocked models from the backend database, and unlocks
models & features based on that plan.

---

## Features

- 🤖 **Plan-aware model selector** — after login, the models unlocked by your
  subscription are fetched from the backend DB and shown in a dropdown. The
  selected model is routed to the backend on every chat.
- ⚡ **Streaming responses** — token-by-token, Cline-style.
- 🧰 **Agentic tools** — the AI can read/write/edit files, list directories,
  run terminal commands, and search the workspace.
- 🔐 **Secure auth** — token stored in VS Code SecretStorage (OS keychain).
- 💳 **Plan-aware** — your subscription plan (free / pro / ultimate) is fetched
  from the backend DB and gates which models + tools are available.
- 🧭 **Two surfaces** — a sidebar view (activity bar) and a full editor panel.

---

## Auth → Plan → Models flow

```
1. Login (email/password)  →  POST /api/auth/login  →  token saved in SecretStorage
2. Plan fetch               →  GET  /api/plan (Bearer) →  plan + models from DB
3. UI renders plan badge + model dropdown (only that plan's models)
4. Chat                     →  POST /api/chat { ..., model } → SSE streamed reply
```

The extension **validates the selected model against the plan** — if a model
isn't in the returned `models[]`, the request is blocked client-side.

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
| GET  | `/api/plan` | Bearer | Returns the user's plan **and models**, read from your DB |
| POST | `/api/chat` | Bearer | Body: `{ messages, tools, model }` → streams SSE |

### `GET /api/plan` response shape

```json
{
  "plan": "pro",
  "planName": "Pro",
  "models": [
    { "id": "claude-3.7-sonnet", "name": "Claude 3.7 Sonnet", "provider": "claude" },
    { "id": "gemini-3.6-flash", "name": "Gemini 3.6 Flash", "provider": "gemini" }
  ],
  "activeModel": "claude-3.7-sonnet",
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

> **Models field flexibility** — the client accepts several shapes:
> - `models: [ { id, name, provider } ]`  *(recommended)*
> - `models: ["claude", "gemini"]`  *(strings — name == id)*
> - `modelList` / `availableModels`  *(alias keys)*
>
> If `models` is missing or empty, the client falls back to a **tier-based
> default**: Free → Claude, Pro → Claude + Gemini, Ultimate → Claude + Gemini + Grok.

### `POST /api/chat` request shape

```json
{
  "messages": [ { "role": "user", "content": "hello" } ],
  "model": "claude-3.7-sonnet",
  "tools": [ { "name": "read_file", "description": "...", "parameters": {} } ]
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
| `meldrix.model` | `auto` | Fallback model when none selected in the dropdown |

---

## Project structure

```
.
├── package.json          # manifest: commands, views, config
├── tsconfig.json
├── media/
│   ├── icon.svg          # activity bar icon
│   ├── webview.js        # chat UI client (model dropdown, streaming)
│   └── webview.css
└── src/
    ├── extension.ts      # activate, commands, views, chat loop + model routing
    ├── auth.ts           # secure token storage
    ├── api.ts            # login / plan (+models) / streaming chat
    ├── tools.ts          # agentic tool registry
    ├── ui.ts             # shared webview HTML (model selector)
    └── types.ts          # PlanInfo, ModelOption, fallback models
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