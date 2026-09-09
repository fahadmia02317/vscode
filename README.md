# Meldrix AI — VS Code Extension

> All-in-one AI assistant for VS Code — Claude, Gemini & Grok with agentic tools, plan-gated models and device sign-in. Powered by [meldrix.com](https://meldrix.com).

This extension is the VS Code client for the Meldrix backend. It mirrors the production app exactly:

- **Auth** → Device Authorization Flow backed by `lib/auth/cli.ts` (`createDeviceAuthorization` → `approveDeviceAuthorization` → `issueCliSession`). The `accessToken` is validated server-side by `getAuthenticatedDbUser(request)` via `getCliSession(token)`.
- **Plans** → `app/api/subscription` (`getSubscriptionByEmail` from PostgreSQL). Four tiers from `getUserPlanTier()`: **free · starter · pro · ultimate**.
- **Models** → the dropdown only shows models the user's tier unlocks (mirrors `MODEL_TIER_REQUIREMENTS` + `isModelAllowedForTier`).
- **Chat** → `app/api/chat` with body `{ messages, id?, modelId, enableSearch?, githubToken?, githubContext?, fileContext? }`, streamed via `streamText().toUIMessageStreamResponse()` (AI SDK UI message stream).

---

## ✨ Features

- 🔐 **Device sign-in** — click Login, a short code appears, the browser opens `meldrix.com/authtoken`, the user signs in with Gmail and enters the code. The extension polls until the backend issues a CLI session.
- 🔄 **Silent token refresh** — the `refreshToken` is stored in SecretStorage; expired access tokens are refreshed automatically before each request.
- 💳 **Plan-aware UI** — plan badge (free/starter/pro/ultimate) + model dropdown populated from the subscription.
- 🧰 **Agentic tools** — `read_file`, `list_files`, `search` (all tiers), `write_file`, `edit_file` (starter+), `run_command` (pro+). Gated locally *and* by the backend.
- 💬 **Streaming chat** — parses AI SDK `text-delta` / `tool-call` stream parts token-by-token.
- 🛡️ **402 / 401 / 429 handling** — plan-denied models, expired sessions and rate limits surface clear messages.

---

## 🚀 Run locally

```bash
git clone https://github.com/fahadmia02317/vscode.git
cd vscode
npm install
npm run compile
```

Open the folder in VS Code and press **F5** (Extension Development Host). Click the ✦ Meldrix icon in the activity bar.

## 📦 Package & publish

```bash
npm run package     # -> meldrix-ai-0.2.0.vsix
vsce login meldrix
vsce publish
```

---

## ⚙️ Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `meldrix.apiBaseUrl` | `https://meldrix.com` | Backend base URL |
| `meldrix.deviceEndpoint` | `/api/auth/device` | Step 1 — create device authorization |
| `meldrix.deviceTokenEndpoint` | `/api/auth/device/token` | Step 2 — poll → issue CLI session |
| `meldrix.refreshEndpoint` | `/api/auth/device/refresh` | Refresh an expired access token |
| `meldrix.verificationUri` | `https://meldrix.com/authtoken` | Browser sign-in page |
| `meldrix.planEndpoint` | `/api/subscription` | Subscription / plan (already exists ✅) |
| `meldrix.modelsEndpoint` | `/api/models` | Optional tier-filtered model list |
| `meldrix.chatEndpoint` | `/api/chat` | Streaming chat (already exists ✅) |
| `meldrix.model` | `""` | Default `modelId` override |

---

## 🔌 Backend contract

### ✅ Already implemented in meldrix.com

| Route | Status |
|-------|--------|
| `GET /api/subscription` | ✅ exists — returns `{ subscription: { status, plan, endDate, renewsAt, ...row.data } }` |
| `POST /api/chat` | ✅ exists — `getAuthenticatedDbUser` + `isModelAllowedForTier` + `toUIMessageStreamResponse()` |
| `lib/auth/cli.ts` | ✅ exists — `createDeviceAuthorization`, `approveDeviceAuthorization`, `issueCliSession`, `getCliSession`, `refreshCliSession`, `revokeCliSession` |

### 🛠️ Routes to add (thin wrappers around `lib/auth/cli.ts`)

#### 1. `POST /api/auth/device` — start device flow

```ts
// app/api/auth/device/route.ts
import { NextResponse } from "next/server";
import { createDeviceAuthorization } from "@/lib/auth/cli";

export const dynamic = "force-dynamic";

export async function POST() {
  const auth = await createDeviceAuthorization(); // { deviceCode, userCode, expiresAt, ... }
  return NextResponse.json({
    deviceCode: auth.deviceCode,
    userCode: auth.userCode,
    verificationUri: "https://meldrix.com/authtoken",
    expiresIn: 600,
    interval: 5,
  });
}
```

#### 2. `POST /api/auth/device/token` — poll for the session

```ts
// app/api/auth/device/token/route.ts
import { NextResponse } from "next/server";
import { getDeviceAuthorization, issueCliSession } from "@/lib/auth/cli";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { deviceCode } = await request.json();
  const device = await getDeviceAuthorization(deviceCode);

  if (!device) {
    return NextResponse.json({ error: "expired_token" }, { status: 400 });
  }
  if (!device.approved) {
    // user has not entered the code on the website yet
    return NextResponse.json({ error: "authorization_pending" }, { status: 400 });
  }

  const session = await issueCliSession(deviceCode); // { accessToken, refreshToken, expiresAt }
  return NextResponse.json(session);
}
```

#### 3. `POST /api/auth/device/refresh` — refresh the access token

```ts
// app/api/auth/device/refresh/route.ts
import { NextResponse } from "next/server";
import { refreshCliSession } from "@/lib/auth/cli";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { refreshToken } = await request.json();
  try {
    const session = await refreshCliSession(refreshToken);
    return NextResponse.json(session);
  } catch {
    return NextResponse.json({ error: "invalid_grant" }, { status: 401 });
  }
}
```

#### 4. `meldrix.com/authtoken` — the verification page

A page where the signed-in user enters the `userCode`. On submit it calls
`approveDeviceAuthorization(userCode, dbUser)` from `lib/auth/cli.ts`.
The extension's next poll then receives the session.

#### 5. (Optional) `GET /api/models` — tier-filtered model list

```ts
// app/api/models/route.ts
import { NextResponse } from "next/server";
import { getAuthenticatedDbUser } from "@/lib/auth/server-user";
import { getCachedUserSubscriptionData } from "@/lib/subscription";
import { getUserPlanTier, MODEL_LABELS, isModelAllowedForTier } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { dbUser } = await getAuthenticatedDbUser(request);
  const sub = await getCachedUserSubscriptionData(dbUser.email);
  const tier = getUserPlanTier(sub.isOwner, sub.isSubscribed, sub.planName);

  const models = Object.entries(MODEL_LABELS)
    .filter(([id]) => isModelAllowedForTier(id, tier))
    .map(([id, name]) => ({ id, name }));

  return NextResponse.json({ models });
}
```

> If you skip `/api/models`, the extension falls back to the `models` array spread from `row.data` in the subscription response, and finally to a built-in tier-based list.

---

## 🔁 End-to-end flow

```
Login click
  → POST /api/auth/device            → { deviceCode, userCode }
  → browser opens meldrix.com/authtoken (Gmail sign-in + enter code)
  → poll POST /api/auth/device/token → { accessToken, refreshToken }  (issueCliSession)
  → SecretStorage save
  → GET /api/subscription (Bearer)   → { subscription: { status, plan, ...row.data } }
  → normalizeTier(plan)              → free | starter | pro | ultimate
  → model dropdown + tool gating
  → POST /api/chat { messages, modelId } → AI SDK stream → token-by-token UI
```

---

## 🗂️ Project structure

```
src/
├── extension.ts   → activate, commands, sidebar/panel, agentic chat loop
├── auth.ts        → CLI session in SecretStorage (accessToken + refreshToken + expiry)
├── api.ts         → device auth, refresh, plan fetch, AI SDK stream parser
├── tools.ts       → agentic tools, 4-tier gating (TIER_RANK)
├── ui.ts          → shared webview HTML (CSP + model selector)
└── types.ts       → PlanTier, CliSession, ChatRequest, normalizeTier, isModelAllowedForTier
media/
├── icon.svg       → activity bar icon
├── webview.js     → chat UI client (streaming, plan badge, device-code card)
└── webview.css    → dark theme + tier badge colors
```

## 🔒 Privacy

User data is accessed only to fulfil explicit user instructions and is never stored, sold or shared. Tokens live in the OS keychain via VS Code SecretStorage.

## 📄 License

MIT
