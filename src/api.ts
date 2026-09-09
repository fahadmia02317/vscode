import * as vscode from 'vscode';
import { AuthManager } from './auth';
import {
  PlanInfo,
  PlanTier,
  ChatRequest,
  ModelOption,
  DeviceAuthInfo,
  CliSession,
  DEFAULT_PLAN,
  fallbackModelsForPlan,
  normalizeTier,
  isModelAllowedForTier,
} from './types';

/**
 * APIClient talks to the real Meldrix backend (https://meldrix.com).
 *
 * ── AUTH ─────────────────────────────────────────────────────────────────
 * Mirrors lib/auth/cli.ts (Device Authorization Flow):
 *   1. POST {deviceEndpoint}       -> createDeviceAuthorization()
 *                                     { deviceCode, userCode, verificationUri, expiresIn, interval }
 *   2. User opens verificationUri (meldrix.com/authtoken), signs in with
 *      Gmail and enters the userCode -> approveDeviceAuthorization(userCode, user)
 *   3. POST {deviceTokenEndpoint}  -> issueCliSession(deviceCode)
 *                                     { accessToken, refreshToken, expiresAt }
 *   4. Optional: POST {refreshEndpoint} -> refreshCliSession(refreshToken)
 *
 * `getAuthenticatedDbUser(request)` accepts the accessToken as
 * `Authorization: Bearer <token>` via `getCliSession(token)`.
 *
 * ── PLAN ─────────────────────────────────────────────────────────────────
 * app/api/subscription/route.ts returns:
 *   { subscription: { status, plan, endDate, renewsAt, ...(row.data || {}) } }
 *   { subscription: null }   -> no subscription (free tier)
 *
 * Tiers are the FOUR from getUserPlanTier() in lib/constants.ts:
 *   free | starter | pro | ultimate
 *
 * ── CHAT ─────────────────────────────────────────────────────────────────
 * app/api/chat/route.ts expects:
 *   POST { messages, id?, modelId, enableSearch?, githubToken?, githubContext?, fileContext? }
 * and responds with streamText().toUIMessageStreamResponse() — an SSE stream
 * of AI-SDK UI message parts. We parse text-delta / tool-call parts below.
 */
export class APIClient {
  constructor(private readonly auth: AuthManager) {}

  private config<T>(key: string, def: T): T {
    return vscode.workspace.getConfiguration('meldrix').get<T>(key, def);
  }

  baseUrl(): string {
    const base = this.config<string>('apiBaseUrl', 'https://meldrix.com') || 'https://meldrix.com';
    return base.replace(/\/+$/, '');
  }

  /** Builds the full URL for the various endpoints. */
  endpoint(kind: 'device' | 'deviceToken' | 'refresh' | 'plan' | 'models' | 'chat'): string {
    const path =
      {
        device: this.config<string>('deviceEndpoint', '/api/auth/device'),
        deviceToken: this.config<string>('deviceTokenEndpoint', '/api/auth/device/token'),
        refresh: this.config<string>('refreshEndpoint', '/api/auth/device/refresh'),
        plan: this.config<string>('planEndpoint', '/api/subscription'),
        models: this.config<string>('modelsEndpoint', '/api/models'),
        chat: this.config<string>('chatEndpoint', '/api/chat'),
      }[kind] || '';

    const trimmed = path.trim();
    if (!trimmed.startsWith('/')) {
      return `${this.baseUrl()}/${trimmed}`;
    }
    return `${this.baseUrl()}${trimmed}`;
  }

  /** URL the user opens in the browser to sign in and enter the code. */
  verificationUri(): string {
    return this.config<string>('verificationUri', 'https://meldrix.com/authtoken');
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    // Transparently refresh an expired access token before the request.
    await this.ensureFreshToken();

    const token = await this.auth.getToken();
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extra,
    };
    if (token) {
      h.Authorization = `Bearer ${token}`;
    }
    return h;
  }

  /**
   * If the stored accessToken is expired and we have a refreshToken, exchange
   * it for a new one via `refreshCliSession(refreshToken)`.
   * Failures are non-fatal — the caller will get a 401 and can re-login.
   */
  async ensureFreshToken(): Promise<void> {
    try {
      if (!(await this.auth.isExpired())) return;
      const refreshToken = await this.auth.getRefreshToken();
      if (!refreshToken) return;

      const res = await fetch(this.endpoint('refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return;

      const data: any = await res.json().catch(() => ({}));
      const accessToken = data?.accessToken || data?.access_token || data?.token;
      if (!accessToken) return;

      await this.auth.saveSession({
        accessToken: String(accessToken),
        refreshToken: data?.refreshToken || data?.refresh_token || refreshToken,
        expiresAt: data?.expiresAt || data?.expires_at || data?.expiresIn,
        email: data?.email,
      });
    } catch {
      // Ignore — let the request proceed and surface a 401 if needed.
    }
  }

  /**
   * STEP 1 — Device Authorization Flow: request a device/user code pair.
   * Backed by `createDeviceAuthorization()` in lib/auth/cli.ts.
   *
   *   POST {deviceEndpoint}
   *   -> { deviceCode, userCode, verificationUri?, expiresIn?, interval? }
   */
  async startDeviceAuth(): Promise<DeviceAuthInfo> {
    const res = await fetch(this.endpoint('device'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client: 'vscode-extension' }),
    });

    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || data?.message || `Device auth failed (${res.status})`);
    }

    const deviceCode = data?.deviceCode || data?.device_code;
    const userCode = data?.userCode || data?.user_code;
    const verificationUri = data?.verificationUri || data?.verification_uri || this.verificationUri();

    if (!deviceCode || !userCode) {
      throw new Error('Backend did not return device authorization codes.');
    }

    return {
      deviceCode: String(deviceCode),
      userCode: String(userCode),
      verificationUri: String(verificationUri),
      expiresIn: Number(data?.expiresIn || data?.expires_in || 600),
      interval: Math.max(2, Number(data?.interval || 5)),
    };
  }

  /**
   * STEP 2 — Poll for the CLI session.
   * Backed by `issueCliSession(deviceCode)` in lib/auth/cli.ts.
   *
   *   POST {deviceTokenEndpoint}  { deviceCode }
   *   -> while pending:  { error: "authorization_pending" | "slow_down" }
   *   -> on success:     { accessToken, refreshToken?, expiresAt? }
   *   -> on expiry/deny: { error: "expired_token" | "access_denied" }
   */
  async pollForSession(deviceCode: string): Promise<CliSession> {
    const res = await fetch(this.endpoint('deviceToken'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode }),
    });

    const data: any = await res.json().catch(() => ({}));

    if (res.ok) {
      const accessToken =
        data?.accessToken || data?.access_token || data?.token || data?.session?.accessToken;
      if (accessToken) {
        return {
          accessToken: String(accessToken),
          refreshToken: data?.refreshToken || data?.refresh_token || data?.session?.refreshToken,
          expiresAt: data?.expiresAt || data?.expires_at || data?.expiresIn,
          email: data?.email || data?.user?.email,
        };
      }
    }

    const codeRaw =
      data?.error ||
      data?.code ||
      (res.status === 400 ? 'authorization_pending' : `device auth failed (${res.status})`);
    const err = new Error(data?.error_description || data?.message || String(codeRaw)) as Error & {
      code: string;
    };
    err.code = String(codeRaw);
    throw err;
  }

  /** Backwards-compatible helper returning just the access token. */
  async pollForToken(deviceCode: string): Promise<string> {
    const session = await this.pollForSession(deviceCode);
    return session.accessToken;
  }

  /** Revokes the CLI session server-side (best effort) — `revokeCliSession`. */
  async revokeSession(): Promise<void> {
    const token = await this.auth.getToken();
    if (!token) return;
    try {
      await fetch(this.endpoint('refresh'), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // ignore
    }
  }

  /**
   * Fetches the current user's subscription plan from the backend DB.
   * Requires a valid CLI accessToken (Bearer), exactly like the production
   * route that calls `getAuthenticatedDbUser(request)`.
   *
   *   { subscription: { status, plan, endDate, renewsAt, ...(row.data || {}) } }
   *   { subscription: null }  ->  no subscription (free tier)
   */
  async getPlan(): Promise<PlanInfo> {
    const res = await fetch(this.endpoint('plan'), {
      headers: await this.headers(),
    });

    if (res.status === 401) {
      throw new Error('unauthorized');
    }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || data?.message || `Failed to fetch plan (${res.status})`);
    }

    const plan = this.normalizePlan(data);

    // If the subscription payload did not carry an explicit model list, try the
    // dedicated models endpoint (tier-filtered by the backend).
    if (!plan.modelsFromBackend) {
      try {
        const remote = await this.fetchModels(plan.plan);
        if (remote.length > 0) {
          plan.models = remote;
        }
      } catch {
        // Keep the tier-based fallback.
      }
    }

    return plan;
  }

  /**
   * Optional dedicated models endpoint. If your backend exposes
   * `GET /api/models` it should return the models allowed for the caller's
   * tier (using MODEL_TIER_REQUIREMENTS + isModelAllowedForTier).
   */
  async fetchModels(tier: PlanTier): Promise<ModelOption[]> {
    const res = await fetch(this.endpoint('models'), {
      headers: await this.headers(),
    });
    if (!res.ok) return [];

    const data: any = await res.json().catch(() => ({}));
    const raw = Array.isArray(data) ? data : data?.models || data?.data || [];
    return this.mapModels(raw, tier);
  }

  /**
   * Coerces the backend response into a PlanInfo.
   *
   * Handles:
   *   { subscription: { status, plan, endDate, renewsAt, ...(row.data || {}) } }
   *   { subscription: null }                                    -> free tier
   *   { plan, planName, models, ... }                           -> flat fallback
   */
  private normalizePlan(data: any): PlanInfo & { modelsFromBackend?: boolean } {
    const subRaw = data?.subscription;
    const sub = subRaw && typeof subRaw === 'object' ? subRaw : subRaw === null ? null : data;

    if (!sub) {
      return { ...this.freePlan(), modelsFromBackend: false };
    }

    const status = (sub?.status || 'active').toString().toLowerCase();
    // Map ANY backend plan slug onto the four real tiers.
    const plan: PlanTier = normalizeTier(sub?.plan || sub?.tier);
    const features = sub?.features || {};
    const limits = sub?.limits || sub?.usage || {};

    const modelsFromBackend = Boolean(
      sub?.models || sub?.modelList || sub?.availableModels || sub?.aiModels || sub?.ai_models
    );

    return {
      plan,
      planName:
        sub?.planName || sub?.name || sub?.plan_label || this.tierLabel(plan),
      status,
      models: this.normalizeModels(sub, plan),
      activeModel: sub?.activeModel || sub?.defaultModel || sub?.model || sub?.default_model,
      features: {
        chat: features.chat ?? true,
        tools: features.tools ?? plan !== 'free',
        github: features.github ?? (plan === 'pro' || plan === 'ultimate'),
        imageGeneration: features.imageGeneration ?? (plan === 'pro' || plan === 'ultimate'),
        videoGeneration: features.videoGeneration ?? plan === 'ultimate',
        tts: features.tts ?? plan !== 'free',
        webSearch: features.webSearch ?? plan !== 'free',
      },
      limits: {
        messagesPerDay: limits?.messagesPerDay ?? limits?.dailyLimit ?? this.tierDailyLimit(plan),
        usedMessages: limits?.usedMessages ?? limits?.used,
      },
      renewsAt: sub?.renewsAt || sub?.renews_at,
      expiresAt: sub?.expiresAt || sub?.endDate || sub?.ends_at,
      modelsFromBackend,
    };
  }

  private freePlan(): PlanInfo {
    return {
      ...DEFAULT_PLAN,
      status: 'active',
    };
  }

  private tierLabel(tier: PlanTier): string {
    return { free: 'Free', starter: 'Starter', pro: 'Pro', ultimate: 'Ultimate' }[tier] || 'Free';
  }

  /** Rough daily message limits per tier (override via backend `limits`). */
  private tierDailyLimit(tier: PlanTier): number {
    return { free: 20, starter: 100, pro: 500, ultimate: 2000 }[tier] ?? 20;
  }

  /**
   * Normalizes the models array from the backend into ModelOption[].
   *
   * Because models come from `...(row.data || {})` in the production route,
   * the exact key is flexible. Supported keys:
   *   models, modelList, availableModels, aiModels, ai_models
   * Each entry can be a string or { id|key|slug, name|label, provider, minTier }.
   */
  private normalizeModels(data: any, plan: PlanTier): ModelOption[] {
    const raw =
      data?.models ||
      data?.modelList ||
      data?.availableModels ||
      data?.aiModels ||
      data?.ai_models ||
      data?.plans?.models;

    if (Array.isArray(raw) && raw.length > 0) {
      const mapped = this.mapModels(raw, plan);
      if (mapped.length > 0) {
        return mapped;
      }
    }

    // If backend did not list models explicitly, derive from the plan tier.
    return fallbackModelsForPlan(plan);
  }

  private mapModels(raw: any[], plan: PlanTier): ModelOption[] {
    return raw
      .map((m: any) => {
        if (typeof m === 'string') {
          return { id: m, name: m, provider: '' } as ModelOption;
        }
        if (typeof m === 'object' && m !== null) {
          const id = m.id || m.key || m.slug || m.value || m.modelId || '';
          const name = m.name || m.label || m.title || id;
          const provider = m.provider || m.type || m.vendor || '';
          const minTier = (m.minTier || m.tier || m.requiredTier) as PlanTier | undefined;
          return { id, name, provider, minTier } as ModelOption;
        }
        return null;
      })
      .filter((m): m is ModelOption => Boolean(m && m.id))
      // Only surface models the user's tier actually unlocks.
      .filter((m) => isModelAllowedForTier(m, plan) || !m.minTier);
  }

  /**
   * Streams a chat completion from app/api/chat/route.ts.
   *
   * Request body matches the route exactly:
   *   { messages, id?, modelId, enableSearch?, githubToken?, githubContext?, fileContext? }
   *
   * The route responds with `streamText().toUIMessageStreamResponse()`, an SSE
   * stream whose `data:` frames are AI-SDK UI message parts:
   *   { "type": "text-delta", "delta": "..." }        (AI SDK v5)
   *   { "type": "text", "text": "..." }
   *   { "type": "tool-call", "toolName": "...", "args": {...} }
   *   { "type": "finish" | "done" | "[DONE]" }
   * We also tolerate the older v4 shape ({ "type": "text-delta", "textDelta": "..." })
   * and plain OpenAI-style deltas.
   *
   * `onToken` is called for each streamed text chunk; returns the full text.
   * `onToolCall` is called for each tool invocation the AI requests.
   */
  async chatStream(
    request: ChatRequest,
    onToken: (chunk: string) => void,
    onToolCall?: (toolCall: any) => void,
    signal?: AbortSignal
  ): Promise<string> {
    // Backend field is `modelId` (NOT `model`).
    const modelId =
      request.modelId ||
      vscode.workspace.getConfiguration('meldrix').get<string>('model', '') ||
      undefined;

    const body: Record<string, any> = {
      messages: request.messages,
      modelId: modelId && modelId !== 'auto' ? modelId : undefined,
    };
    if (request.id) body.id = request.id;
    if (request.enableSearch !== undefined) body.enableSearch = request.enableSearch;
    if (request.githubToken) body.githubToken = request.githubToken;
    if (request.githubContext) body.githubContext = request.githubContext;
    if (request.fileContext) body.fileContext = request.fileContext;
    // Local agentic tools (executed by the extension, not the backend).
    if (request.tools?.length) body.tools = request.tools;
    if (request.toolResults?.length) body.toolResults = request.toolResults;

    const res = await fetch(this.endpoint('chat'), {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify(body),
      signal,
    });

    if (res.status === 401) {
      throw new Error('unauthorized');
    }
    if (res.status === 402) {
      // The route returns 402 when isModelAllowedForTier() rejects the model.
      const errText = await res.text().catch(() => '');
      throw new Error(
        `This model is not included in your plan. ${errText.slice(0, 200)}`.trim()
      );
    }
    if (res.status === 429) {
      throw new Error('Rate limit reached. Please try again later.');
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`Chat failed (${res.status}): ${text.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE frames separated by double newlines.
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 2);
        this.handleFrame(frame, onToken, onToolCall, (s: string) => (full += s));
      }
    }
    return full;
  }

  private handleFrame(
    frame: string,
    onToken: (chunk: string) => void,
    onToolCall?: (toolCall: any) => void,
    accumulate?: (s: string) => void
  ): void {
    const lines = frame.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data:')) {
        continue;
      }
      const raw = line.slice(5).trim();
      if (raw === '[DONE]' || raw === '') {
        continue;
      }

      if (raw.startsWith('{')) {
        try {
          const obj = JSON.parse(raw);
          const type = obj?.type;

          // ── AI SDK UI message stream parts ──────────────────────────
          if (type === 'text-delta') {
            const chunk = obj.delta ?? obj.textDelta ?? obj.text ?? '';
            if (chunk) {
              onToken(String(chunk));
              accumulate?.(String(chunk));
            }
            continue;
          }
          if (type === 'text' || type === 'text-start' || type === 'text-end') {
            const chunk = obj.text ?? '';
            if (chunk) {
              onToken(String(chunk));
              accumulate?.(String(chunk));
            }
            continue;
          }
          if (type === 'tool-call' || type === 'tool_call') {
            onToolCall?.({
              id: obj.toolCallId || obj.id,
              name: obj.toolName || obj.name,
              args: obj.args ?? obj.arguments ?? {},
            });
            continue;
          }
          if (type === 'finish' || type === 'done' || type === 'finish-step') {
            continue;
          }
          if (type === 'error') {
            onToken(`\n⚠ ${obj.errorText || obj.message || 'stream error'}\n`);
            continue;
          }

          // ── Generic / OpenAI-style fallbacks ────────────────────────
          if (obj.tool_call || obj.toolCalls) {
            onToolCall?.(obj.tool_call || obj.toolCalls);
            continue;
          }
          const content =
            obj.choices?.[0]?.delta?.content ?? obj.content ?? obj.delta ?? obj.text ?? '';
          if (content) {
            onToken(String(content));
            accumulate?.(String(content));
          }
        } catch {
          onToken(raw);
          accumulate?.(raw);
        }
      } else {
        onToken(raw);
        accumulate?.(raw);
      }
    }
  }
}