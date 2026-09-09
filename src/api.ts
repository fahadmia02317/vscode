import * as vscode from 'vscode';
import { AuthManager } from './auth';
import { PlanInfo, ChatRequest, ModelOption, DEFAULT_PLAN, fallbackModelsForPlan } from './types';

/**
 * APIClient talks to the Meldrix backend (https://meldrix.com by default).
 *
 * The real Meldrix backend (Next.js) exposes routes that use
 * `getAuthenticatedDbUser(request)` and query PostgreSQL via
 * `getSubscriptionByEmail(email)`. The subscription route returns:
 *
 *   { subscription: { status, plan, endDate, renewsAt, ...(row.data || {}) } }
 *   { subscription: null }   ->  user has no subscription (free plan)
 *
 * Endpoints are configurable so they can be pointed at the exact routes in
 * the production meldrix.com app.
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

  /** Builds the full URL for login / plan / chat endpoints. */
  endpoint(kind: 'login' | 'plan' | 'chat'): string {
    const path =
      {
        login: this.config<string>('loginEndpoint', '/api/auth/login'),
        plan: this.config<string>('planEndpoint', '/api/subscription'),
        chat: this.config<string>('chatEndpoint', '/api/chat'),
      }[kind] || '';

    const trimmed = path.trim();
    if (!trimmed.startsWith('/')) {
      return `${this.baseUrl()}/${trimmed}`;
    }
    return `${this.baseUrl()}${trimmed}`;
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
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

  /** Logs the user in with email/password and returns an auth token. */
  async login(email: string, password: string): Promise<string> {
    const res = await fetch(this.endpoint('login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || data?.message || `Login failed (${res.status})`);
    }
    const token =
      data?.token ||
      data?.accessToken ||
      data?.access_token ||
      data?.jwt ||
      data?.session?.token;
    if (!token) {
      throw new Error('Login succeeded but no token was returned by the backend.');
    }
    return String(token);
  }

  /**
   * Fetches the current user's subscription plan from the backend DB.
   * Requires a valid auth token (Bearer), exactly like the production route
   * that calls `getAuthenticatedDbUser(request)`.
   *
   * Actual Meldrix backend response:
   *   { subscription: { status, plan, endDate, renewsAt, ...(row.data || {}) } }
   *   { subscription: null }  ->  no subscription (free plan)
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
    return this.normalizePlan(data);
  }

  /**
   * Coerces the backend response into a PlanInfo.
   *
   * Handles:
   *   { subscription: { status, plan, endDate, renewsAt, ...(row.data || {}) } }
   *   { subscription: null }                                    -> free plan
   *   { plan, planName, models, ... }                           -> flat fallback
   */
  private normalizePlan(data: any): PlanInfo {
    // No subscription at all -> free plan.
    const subRaw = data?.subscription;
    const sub =
      subRaw && typeof subRaw === 'object' ? subRaw : (subRaw === null ? null : data);

    if (!sub) {
      return this.freePlan();
    }

    const status = (sub?.status || 'active').toString().toLowerCase();
    const plan = (sub?.plan || sub?.tier || 'free').toString().toLowerCase();
    const features = sub?.features || {};
    const limits = sub?.limits || sub?.usage || {};

    return {
      plan,
      planName: sub?.planName || sub?.name || sub?.plan_label || DEFAULT_PLAN.planName,
      status,
      models: this.normalizeModels(sub, plan),
      activeModel: sub?.activeModel || sub?.defaultModel || sub?.model || sub?.default_model,
      features: {
        chat: features.chat ?? true,
        tools: features.tools ?? (plan === 'pro' || plan === 'ultimate'),
        github: features.github ?? plan === 'ultimate',
        imageGeneration: features.imageGeneration ?? plan === 'ultimate',
        videoGeneration: features.videoGeneration ?? plan === 'ultimate',
        tts: features.tts ?? plan !== 'free',
      },
      limits: {
        messagesPerDay: limits?.messagesPerDay ?? limits?.dailyLimit ?? 20,
        usedMessages: limits?.usedMessages ?? limits?.used,
      },
      renewsAt: sub?.renewsAt || sub?.renews_at,
      expiresAt: sub?.expiresAt || sub?.endDate || sub?.ends_at,
    };
  }

  private freePlan(): PlanInfo {
    return {
      ...DEFAULT_PLAN,
      status: 'active',
    };
  }

  /**
   * Normalizes the models array from the backend into ModelOption[].
   *
   * Because models come from `...(row.data || {})` in the production route,
   * the exact key is flexible. Supported keys:
   *   models, modelList, availableModels, aiModels, ai_models
   * Each entry can be a string or { id|key|slug, name|label, provider }.
   */
  private normalizeModels(data: any, plan: string): ModelOption[] {
    const raw =
      data?.models ||
      data?.modelList ||
      data?.availableModels ||
      data?.aiModels ||
      data?.ai_models ||
      data?.plans?.models;

    if (Array.isArray(raw) && raw.length > 0) {
      const mapped = raw
        .map((m: any) => {
          if (typeof m === 'string') {
            return { id: m, name: m, provider: '' } as ModelOption;
          }
          if (typeof m === 'object' && m !== null) {
            const id = m.id || m.key || m.slug || m.value || '';
            const name = m.name || m.label || m.title || id;
            const provider = m.provider || m.type || m.vendor || '';
            return { id, name, provider } as ModelOption;
          }
          return null;
        })
        .filter((m): m is ModelOption => Boolean(m && m.id));

      if (mapped.length > 0) {
        return mapped;
      }
    }

    // If backend did not list models explicitly, derive from the plan tier.
    return fallbackModelsForPlan(plan);
  }

  /**
   * Streams a chat completion from the backend.
   * `onToken` is called for each streamed text chunk; returns the full text.
   * `onToolCall` is called for each tool invocation the AI requests.
   */
  async chatStream(
    request: ChatRequest,
    onToken: (chunk: string) => void,
    onToolCall?: (toolCall: any) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const configModel = vscode.workspace
      .getConfiguration('meldrix')
      .get<string>('model', 'auto');
    const model = request.model || configModel || 'auto';
    const res = await fetch(this.endpoint('chat'), {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify({ ...request, model }),
      signal,
    });

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

      // JSON payload?
      if (raw.startsWith('{')) {
        try {
          const obj = JSON.parse(raw);
          if (obj.tool_call || obj.toolCalls) {
            onToolCall?.(obj.tool_call || obj.toolCalls);
            continue;
          }
          const content = obj.content ?? obj.delta ?? obj.text ?? '';
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