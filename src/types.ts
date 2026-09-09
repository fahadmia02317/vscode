/**
 * Shared type definitions for the Meldrix extension.
 */

export type PlanTier = 'free' | 'pro' | 'ultimate';

/** A single AI model available inside a user's subscription plan. */
export interface ModelOption {
  /** Unique model id sent to the backend, e.g. "claude-3.7-sonnet". */
  id: string;
  /** Human friendly name, e.g. "Claude 3.7 Sonnet". */
  name: string;
  /** Provider family, e.g. "claude" | "gemini" | "grok". */
  provider?: string;
}

/** Subscription plan fetched from the backend DB via auth token. */
export interface PlanInfo {
  plan: PlanTier;
  planName: string;
  /**
   * Subscription status from the backend DB
   * (e.g. "active" | "trialing" | "canceled" | "expired" | "past_due").
   * Missing/unknown status is treated as "active".
   */
  status?: string;
  /** Models unlocked for this plan (shown in the UI dropdown). */
  models: ModelOption[];
  /** Default/active model the user last used (optional). */
  activeModel?: string;
  features: {
    chat: boolean;
    tools: boolean; // file read/write/edit, terminal, search
    github: boolean;
    imageGeneration: boolean;
    videoGeneration: boolean;
    tts: boolean;
  };
  limits: {
    messagesPerDay: number;
    usedMessages?: number;
  };
  renewsAt?: string;
  expiresAt?: string;
}

/**
 * Device Authorization Flow payload (RFC 8628 style, like GitHub/Google).
 *
 * Step 1 — POST /api/auth/device returns this. The user opens
 * `verificationUri` in a browser, signs in with their Gmail, and enters
 * the short `userCode` (e.g. 6 digits).
 */
export interface DeviceAuthInfo {
  /** Long-lived identifier used to poll for the token. */
  deviceCode: string;
  /** Short human-enterable code shown to the user (e.g. "A1B2-C3D4" or 6 digits). */
  userCode: string;
  /** URL the user opens to sign in & authorize (e.g. https://meldrix.com/authtoken). */
  verificationUri: string;
  /** Seconds until the codes expire. */
  expiresIn: number;
  /** Polling interval in seconds. */
  interval: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** Map of tool-name -> argument JSON object. */
export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, any>;
};

export interface ToolResult {
  success: boolean;
  output: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  tools?: { name: string; description: string; parameters: Record<string, any> }[];
  toolResults?: { id: string; name: string; result: string }[];
}

/**
 * Fallback models used when the backend plan does not explicitly list models.
 * Tiers map to the models advertised on meldrix.com:
 *   Claude 3.7 Sonnet, Gemini 3.6 Flash, Grok AI.
 */
export function fallbackModelsForPlan(plan: string): ModelOption[] {
  const claude: ModelOption = { id: 'claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', provider: 'claude' };
  const gemini: ModelOption = { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', provider: 'gemini' };
  const grok: ModelOption = { id: 'grok-ai', name: 'Grok AI', provider: 'grok' };

  switch ((plan || '').toLowerCase()) {
    case 'ultimate':
      return [claude, gemini, grok];
    case 'pro':
      return [claude, gemini];
    case 'free':
    default:
      return [claude];
  }
}

export const DEFAULT_PLAN: PlanInfo = {
  plan: 'free',
  planName: 'Free',
  status: 'active',
  models: fallbackModelsForPlan('free'),
  features: {
    chat: true,
    tools: false,
    github: false,
    imageGeneration: false,
    videoGeneration: false,
    tts: false,
  },
  limits: { messagesPerDay: 20 },
};