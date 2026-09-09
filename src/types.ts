/**
 * Shared type definitions for the Meldrix extension.
 */

export type PlanTier = 'free' | 'pro' | 'ultimate';

/** Subscription plan fetched from the backend DB via auth token. */
export interface PlanInfo {
  plan: PlanTier;
  planName: string;
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

export const DEFAULT_PLAN: PlanInfo = {
  plan: 'free',
  planName: 'Free',
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