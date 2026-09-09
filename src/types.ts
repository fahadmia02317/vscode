/** 
 * Shared type definitions for the Meldrix extension.
 *
 * These types mirror the real meldrix.com backend:
 *   - lib/constants.ts        -> getUserPlanTier(): "free" | "starter" | "pro" | "ultimate"
 *   - lib/auth/cli.ts         -> issueCliSession(): { accessToken, refreshToken, ... }
 *   - app/api/subscription    -> { subscription: { status, plan, endDate, renewsAt, ...row.data } }
 *   - app/api/chat            -> POST { messages, id?, modelId, enableSearch?, githubToken?, githubContext?, fileContext? }
 *                              -> streamText().toUIMessageStreamResponse()
 *   - app/api/vscode/models   -> GET (API key auth) -> { models: [{ id, name, provider }] }
 *   - app/api/vscode/agent    -> POST (API key auth) -> streaming AI response with tool calls
 */

/**
 * The four subscription tiers used by `getUserPlanTier()` in lib/constants.ts.
 * NOTE: this is a 4-tier system (free / starter / pro / ultimate) — not 3.
 */
export type PlanTier = 'free' | 'starter' | 'pro' | 'ultimate';

/**
 * Authentication mode.
 *
 * - 'device': CLI session via Device Authorization Flow (accessToken in SecretStorage).
 * - 'apikey': Meldrix API key entered by the user (stored in SecretStorage).
 *
 * The extension auto-detects which mode is active. If an API key is stored,
 * it takes precedence (API key mode). Otherwise, device auth is used.
 */
export type AuthMode = 'device' | 'apikey';

/** A single AI model available inside a user's subscription plan. */
export interface ModelOption {
  /** Unique model id sent to the backend as `modelId`, e.g. "claude-3.7-sonnet". */
  id: string;
  /** Human friendly name, e.g. "Claude 3.7 Sonnet". */
  name: string;
  /** Provider family, e.g. "claude" | "gemini" | "grok". */
  provider?: string;
  /** Minimum tier required for this model (from MODEL_TIER_REQUIREMENTS). */
  minTier?: PlanTier;
}

/**
 * A model returned by GET /api/vscode/models (API key mode).
 *
 * Unlike ModelOption, this does NOT carry tier information — the Meldrix
 * backend is the source of truth for model entitlement. If a model appears
 * in the list, the user can select it. If the backend returns 403 for a
 * model request, the error is displayed.
 */
export interface MeldrixModel {
  id: string;
  name: string;
  provider?: string;
}

/** Subscription plan fetched from the backend DB via CLI auth token. */
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
    webSearch: boolean;
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
 * Backed by `createDeviceAuthorization()` in lib/auth/cli.ts, which generates
 * a `deviceCode` + short numeric `userCode` and stores them in Postgres.
 *
 * Step 1 — POST {deviceEndpoint} returns this. The user opens
 * `verificationUri` in a browser, signs in with their Gmail, and enters
 * the short `userCode`.
 */
export interface DeviceAuthInfo {
  /** Long-lived identifier used to poll for the token. */
  deviceCode: string;
  /** Short human-enterable code shown to the user (e.g. 6-7 digits). */
  userCode: string;
  /** URL the user opens to sign in & authorize (e.g. https://meldrix.com/authtoken). */
  verificationUri: string;
  /** Seconds until the codes expire. */
  expiresIn: number;
  /** Polling interval in seconds. */
  interval: number;
}

/**
 * CLI session credentials issued by `issueCliSession(deviceCode)` in
 * lib/auth/cli.ts. The accessToken is what `getAuthenticatedDbUser(request)`
 * validates via `getCliSession(token)` when it arrives as `Authorization: Bearer`.
 */
export interface CliSession {
  accessToken: string;
  refreshToken?: string;
  /** ISO timestamp / epoch ms when the access token expires (optional). */
  expiresAt?: string | number;
  /** User email returned by the backend, if any. */
  email?: string;
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

/**
 * Chat request body — matches `app/api/chat/route.ts` exactly:
 *   { messages, id?, modelId, enableSearch?, githubToken?, githubContext?, fileContext? }
 */
export interface ChatRequest {
  messages: ChatMessage[];
  /** Conversation id (optional, backend uses it for history). */
  id?: string;
  /** The selected model id — backend field is `modelId`, NOT `model`. */
  modelId?: string;
  /** Enable web search augmentation. */
  enableSearch?: boolean;
  /** Optional GitHub PAT for live repo editing. */
  githubToken?: string;
  /** Optional GitHub context (repo/branch/file). */
  githubContext?: Record<string, any>;
  /** Optional workspace file context injected into the prompt. */
  fileContext?: Record<string, any>;
  /** Local agentic tool definitions (extension-executed). */
  tools?: { name: string; description: string; parameters: Record<string, any> }[];
  /** Results of previously executed local tools. */
  toolResults?: { id: string; name: string; result: string }[];
}

/**
 * Request body for POST /api/vscode/agent (API key mode).
 *
 * The Meldrix backend provides the AI model/inference.
 * VS Code executes all tools locally.
 *
 * Token usage is reported by Meldrix (not estimated by VS Code).
 */
export interface MeldrixAgentRequest {
  /** Selected model id (from GET /api/vscode/models). */
  model: string;
  /** Conversation messages. */
  messages: ChatMessage[];
  /** Local tool definitions sent so the model knows what tools are available. */
  tools?: { name: string; description: string; parameters: Record<string, any> }[];
  /** Results of previously executed local tools (from the previous turn). */
  toolResults?: { id: string; name: string; result: string }[];
}

/**
 * Token usage reported by Meldrix (authoritative).
 *
 * VS Code must NOT calculate or estimate official token usage.
 * The Meldrix Dashboard remains the source of truth.
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * Fallback models used when the backend plan does not explicitly list models.
 * Mirrors the 4-tier system from lib/constants.ts (MODEL_TIER_REQUIREMENTS).
 *
 * The real source of truth is the backend — prefer `GET /api/models` or the
 * `models` array spread from `row.data` in the subscription response.
 */
export function fallbackModelsForPlan(plan: string): ModelOption[] {
  const claude: ModelOption = { id: 'claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', provider: 'claude', minTier: 'free' };
  const gemini: ModelOption = { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', provider: 'gemini', minTier: 'starter' };
  const grok: ModelOption = { id: 'grok-ai', name: 'Grok AI', provider: 'grok', minTier: 'pro' };

  switch (normalizeTier(plan)) {
    case 'ultimate':
      return [claude, gemini, grok];
    case 'pro':
      return [claude, gemini, grok];
    case 'starter':
      return [claude, gemini];
    case 'free':
    default:
      return [claude];
  }
}

/**
 * Maps any backend plan string onto one of the four real tiers.
 * Handles common aliases so a mismatch never silently downgrades a user.
 */
export function normalizeTier(plan?: string | null): PlanTier {
  const p = (plan || '').toString().trim().toLowerCase();
  if (!p) return 'free';

  if (p.includes('ultimate') || p.includes('max') || p.includes('unlimited')) return 'ultimate';
  if (p.includes('pro') || p.includes('premium') || p.includes('plus')) return 'pro';
  if (p.includes('starter') || p.includes('basic') || p.includes('standard')) return 'starter';
  if (p.includes('free') || p.includes('trial')) return 'free';

  // Unknown slug -> treat as free but keep the raw name for display.
  return 'free';
}

/** Ordered tier ranks, used for "is this model allowed on my plan?" checks. */
export const TIER_RANK: Record<PlanTier, number> = {
  free: 0,
  starter: 1,
  pro: 2,
  ultimate: 3,
};

/** Mirrors `isModelAllowedForTier(modelId, userTier)` from lib/constants.ts. */
export function isModelAllowedForTier(model: ModelOption | undefined, userTier: PlanTier): boolean {
  if (!model) return false;
  if (!model.minTier) return true;
  return TIER_RANK[userTier] >= TIER_RANK[model.minTier];
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
    webSearch: false,
  },
  limits: { messagesPerDay: 20 },
};

/**
 * Tool definition type used for specifying available tools to the AI model.
 */
export interface ToolDefinition {
  /** Name of the tool. */
  name: string;
  /** Description of what the tool does. */
  description: string;
  /** Parameters accepted by the tool. */
  parameters: Record<string, any>;
}