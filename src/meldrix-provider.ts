import * as vscode from 'vscode';
import { 
  MeldrixModel, 
  ChatMessage, 
  MeldrixAgentRequest, 
  TokenUsage,
  ToolDefinition
} from './types';

/**
 * MeldrixProvider handles API key authentication and communication with
 * the Meldrix backend API endpoints:
 * 
 * - GET /api/vscode/models  → fetch available models
 * - POST /api/vscode/agent  → streaming AI responses with tool calls
 * 
 * The provider is responsible for:
 * 1. Securely storing the API key in VS Code SecretStorage
 * 2. Making authenticated requests to Meldrix endpoints
 * 3. Handling API key validation and errors
 * 4. Streaming responses from the Meldrix backend
 */
export class MeldrixProvider {
  private static readonly SECRET_KEY = 'meldrix.apiKey';
  private static readonly BASE_URL = 'https://meldrix.com';
  private static readonly MODELS_ENDPOINT = '/api/vscode/models';
  private static readonly AGENT_ENDPOINT = '/api/vscode/agent';
  
  private cachedModels: MeldrixModel[] = [];
  private isConnected = false;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /**
   * Get the stored API key from VS Code SecretStorage.
   */
  async getApiKey(): Promise<string | undefined> {
    return await this.ctx.secrets.get(MeldrixProvider.SECRET_KEY);
  }

  /**
   * Store the API key securely in VS Code SecretStorage.
   */
  async setApiKey(apiKey: string): Promise<void> {
    await this.ctx.secrets.store(MeldrixProvider.SECRET_KEY, apiKey);
  }

  /**
   * Remove the API key from VS Code SecretStorage.
   */
  async clearApiKey(): Promise<void> {
    await this.ctx.secrets.delete(MeldrixProvider.SECRET_KEY);
    this.cachedModels = [];
    this.isConnected = false;
  }

  /**
   * Get a masked version of the API key for display purposes.
   */
  async getMaskedApiKey(): Promise<string> {
    const key = await this.getApiKey();
    if (!key) return '';
    if (key.length <= 8) return '*'.repeat(key.length);
    return '*'.repeat(key.length - 4) + key.slice(-4);
  }

  /**
   * Test the API key by fetching available models.
   */
  async testConnection(apiKey: string): Promise<boolean> {
    try {
      const models = await this.fetchModelsInternal(apiKey);
      this.cachedModels = models;
      this.isConnected = true;
      return true;
    } catch (error) {
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Fetch available models from the Meldrix backend.
   */
  async getModels(): Promise<MeldrixModel[]> {
    if (!this.isConnected) {
      throw new Error('Not connected to Meldrix. Please connect first.');
    }
    return this.cachedModels;
  }

  /**
   * Internal method to fetch models with a specific API key.
   */
  private async fetchModelsInternal(apiKey: string): Promise<MeldrixModel[]> {
    const url = MeldrixProvider.BASE_URL + MeldrixProvider.MODELS_ENDPOINT;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.status === 401) {
      throw new Error('Meldrix API key is invalid or expired.');
    }
    
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();
    const models = Array.isArray(data) ? data : data.models || [];
    
    return models.map((model: any) => ({
      id: model.id,
      name: model.name || model.id,
      provider: model.provider || ''
    }));
  }

  /**
   * Stream a chat completion from the Meldrix backend.
   */
  async streamChat(
    messages: ChatMessage[],
    model: string,
    tools: ToolDefinition[],
    onToken: (chunk: string) => void,
    onToolCall?: (toolCall: any) => void,
    onUsage?: (usage: TokenUsage) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('Meldrix API key not found. Please connect first.');
    }

    const url = MeldrixProvider.BASE_URL + MeldrixProvider.AGENT_ENDPOINT;
    
    const requestBody: MeldrixAgentRequest = {
      model,
      messages,
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }))
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal
    });

    if (response.status === 401) {
      throw new Error('Meldrix API key is invalid or expired.');
    }
    
    if (response.status === 403) {
      throw new Error('This model is not available on your Meldrix plan.');
    }
    
    if (response.status === 429) {
      throw new Error('Rate limit reached. Please try again later.');
    }
    
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(`Chat failed (${response.status}): ${text.slice(0, 300)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE frames separated by double newlines
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 2);
          this.handleFrame(frame, onToken, onToolCall, onUsage);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Handle a single SSE frame from the Meldrix backend.
   */
  private handleFrame(
    frame: string,
    onToken: (chunk: string) => void,
    onToolCall?: (toolCall: any) => void,
    onUsage?: (usage: TokenUsage) => void
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

          // Handle text chunks
          if (type === 'text-delta') {
            const chunk = obj.delta ?? obj.textDelta ?? obj.text ?? '';
            if (chunk) {
              onToken(String(chunk));
            }
            continue;
          }
          
          if (type === 'text' || type === 'text-start' || type === 'text-end') {
            const chunk = obj.text ?? '';
            if (chunk) {
              onToken(String(chunk));
            }
            continue;
          }

          // Handle tool calls
          if (type === 'tool-call' || type === 'tool_call') {
            onToolCall?.({
              id: obj.toolCallId || obj.id,
              name: obj.toolName || obj.name,
              args: obj.args ?? obj.arguments ?? {},
            });
            continue;
          }

          // Handle finish events
          if (type === 'finish' || type === 'done' || type === 'finish-step') {
            // Report token usage if available
            if (obj.usage) {
              onUsage?.({
                inputTokens: obj.usage.inputTokens,
                outputTokens: obj.usage.outputTokens,
                totalTokens: obj.usage.totalTokens
              });
            }
            continue;
          }

          // Handle errors
          if (type === 'error') {
            onToken(`\n⚠ ${obj.errorText || obj.message || 'stream error'}\n`);
            continue;
          }

          // Handle generic/tool call formats
          if (obj.tool_call || obj.toolCalls) {
            onToolCall?.(obj.tool_call || obj.toolCalls);
            continue;
          }
          
          const content =
            obj.choices?.[0]?.delta?.content ?? obj.content ?? obj.delta ?? obj.text ?? '';
          if (content) {
            onToken(String(content));
          }
        } catch {
          onToken(raw);
        }
      } else {
        onToken(raw);
      }
    }
  }
}