import * as vscode from 'vscode';
import { AuthManager } from './auth';
import { PlanInfo, ChatRequest, DEFAULT_PLAN } from './types';

/**
 * APIClient talks to the Meldrix backend (https://meldrix.com by default).
 *
 * Expected backend endpoints (implement these on your Meldrix server):
 *   POST {base}/api/auth/login         -> { token }
 *   GET  {base}/api/plan               -> PlanInfo (uses Bearer token, reads DB)
 *   POST {base}/api/chat               -> streaming SSE response (tool use)
 */
export class APIClient {
  constructor(private readonly auth: AuthManager) {}

  baseUrl(): string {
    let base = vscode.workspace
      .getConfiguration('meldrix')
      .get<string>('apiBaseUrl', 'https://meldrix.com');
    if (!base) {
      base = 'https://meldrix.com';
    }
    return base.replace(/\/+$/, '');
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
    const res = await fetch(`${this.baseUrl()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || data?.message || `Login failed (${res.status})`);
    }
    const token = data?.token || data?.accessToken || data?.access_token;
    if (!token) {
      throw new Error('Login succeeded but no token was returned by the backend.');
    }
    return token as string;
  }

  /**
   * Fetches the current user's subscription plan from the backend DB.
   * Requires a valid auth token (Bearer).
   */
  async getPlan(): Promise<PlanInfo> {
    const res = await fetch(`${this.baseUrl()}/api/plan`, {
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

  /** Coerces whatever plan shape the backend returns into a PlanInfo. */
  private normalizePlan(data: any): PlanInfo {
    const plan = (data?.plan || data?.tier || 'free').toString().toLowerCase();
    const features = data?.features || {};
    return {
      plan,
      planName: data?.planName || data?.name || plan,
      features: {
        chat: features.chat ?? true,
        tools: features.tools ?? (plan === 'pro' || plan === 'ultimate'),
        github: features.github ?? (plan === 'ultimate'),
        imageGeneration: features.imageGeneration ?? (plan === 'ultimate'),
        videoGeneration: features.videoGeneration ?? (plan === 'ultimate'),
        tts: features.tts ?? (plan !== 'free'),
      },
      limits: {
        messagesPerDay: data?.limits?.messagesPerDay ?? 20,
        usedMessages: data?.limits?.usedMessages,
      },
      renewsAt: data?.renewsAt,
      expiresAt: data?.expiresAt,
    };
  }

  /**
   * Streams a chat completion from the backend.
   * `onToken` is called for each streamed text chunk; returns the full text.
   *
   * The backend is expected to stream Server-Sent Events where each `data:`
   * line is either raw text or JSON shaped like `{ "content": "..." }`.
   */
  async chatStream(
    request: ChatRequest,
    onToken: (chunk: string) => void,
    onToolCall?: (toolCall: any) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const model = vscode.workspace.getConfiguration('meldrix').get<string>('model', 'auto');
    const res = await fetch(`${this.baseUrl()}/api/chat`, {
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