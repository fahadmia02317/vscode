import * as vscode from 'vscode';
import { AuthManager } from './auth';
import { APIClient } from './api';
import { ToolRegistry } from './tools';
import { PlanInfo, DEFAULT_PLAN, ToolCall, ChatRequest } from './types';
import { MeldrixUI } from './ui';

/**
 * Meldrix AI — VS Code extension entry point.
 *
 * Mirrors the real meldrix.com backend:
 *
 * ── AUTH (lib/auth/cli.ts — Device Authorization Flow) ───────────────────
 *   1. User clicks "Login". POST {deviceEndpoint} -> createDeviceAuthorization()
 *      returns { deviceCode, userCode, verificationUri, expiresIn, interval }.
 *   2. We open the browser at meldrix.com/authtoken and show the userCode in
 *      the webview + a modal. The user signs in with Gmail and enters the code
 *      -> approveDeviceAuthorization(userCode, user).
 *   3. We poll POST {deviceTokenEndpoint} -> issueCliSession(deviceCode)
 *      returns { accessToken, refreshToken, expiresAt }, stored securely in
 *      VS Code SecretStorage. The accessToken is what
 *      `getAuthenticatedDbUser(request)` validates via `getCliSession(token)`.
 *
 * ── PLAN (app/api/subscription) ──────────────────────────────────────────
 *   GET {planEndpoint} (Authorization: Bearer <accessToken>)
 *   -> { subscription: { status, plan, endDate, renewsAt, ...(row.data) } }
 *   -> { subscription: null } when there is no subscription (free tier).
 *   Tiers are the FOUR from getUserPlanTier(): free | starter | pro | ultimate.
 *   The plan decides which models appear in the UI dropdown (mirroring
 *   MODEL_TIER_REQUIREMENTS + isModelAllowedForTier) and which tools are exposed.
 *
 * ── CHAT (app/api/chat) ──────────────────────────────────────────────────
 *   POST { messages, id?, modelId, enableSearch?, githubToken?, githubContext?, fileContext? }
 *   -> streamText().toUIMessageStreamResponse() (AI SDK UI message stream).
 *   The AI can invoke local agentic tools which we execute against the workspace.
 */
export function activate(context: vscode.ExtensionContext) {
  const auth = new AuthManager(context);
  const api = new APIClient(auth);

  let currentPlan: PlanInfo | undefined = undefined;
  const setPlan = (p: PlanInfo) => {
    currentPlan = p;
    void context.workspaceState.update('meldrix.plan', p);
  };

  const tools = new ToolRegistry(() => currentPlan);

  /** Remembered so the webview "Open Browser" button can re-open the sign-in page. */
  let lastVerificationUri: string | undefined;

  // ---- Status bar indicator -------------------------------------------
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = '$(sparkle) Meldrix';
  statusBar.command = 'meldrix.open';
  statusBar.tooltip = 'Open Meldrix AI assistant';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // ---- Message reply helper --------------------------------------------
  const post = (webview: vscode.Webview) => ({
    send: (payload: any) => void webview.postMessage(payload),
  });

  async function refreshPlan(): Promise<PlanInfo | undefined> {
    try {
      const plan = await api.getPlan();
      setPlan(plan);
      void vscode.commands.executeCommand('setContext', 'meldrix.loggedIn', true);
      return plan;
    } catch (e: any) {
      if (e?.message === 'unauthorized' || e?.message?.includes('401')) {
        // Token is invalid/expired and could not be refreshed -> force re-login.
        currentPlan = undefined;
        void vscode.commands.executeCommand('setContext', 'meldrix.loggedIn', false);
      }
      return undefined;
    }
  }

  /** Warns the user when their subscription is not active. */
  function warnIfInactive(plan: PlanInfo) {
    const status = (plan.status || 'active').toLowerCase();
    if (status !== 'active' && status !== 'trialing') {
      vscode.window.showWarningMessage(
        `Meldrix: your subscription is "${status}". Some features may be limited.`
      );
    }
  }

  const handleMessage = async (msg: any, send: (p: any) => void) => {
    switch (msg.type) {
      case 'ready': {
        if (!(await auth.isLoggedIn())) {
          send({ type: 'status', text: 'Connect your Meldrix account to get started.' });
          send({ type: 'loggedOut' });
        } else {
          const cached = context.workspaceState.get<PlanInfo>('meldrix.plan');
          if (cached) {
            currentPlan = cached;
            // Show cached plan immediately for a snappy UI.
            send({ type: 'plan', plan: cached });
          }
          void refreshPlan().then((p) => {
            if (p) {
              send({ type: 'plan', plan: p });
            }
          });
        }
        break;
      }

      case 'login': {
        await commandLogin(send);
        break;
      }

      case 'chat': {
        await handleChat(msg.text, msg.model, send);
        break;
      }

      // ── Webview device-code card actions (previously unhandled) ────────
      case 'copyCode': {
        const code = msg.userCode ? String(msg.userCode) : undefined;
        if (code) {
          await vscode.env.clipboard.writeText(code);
          send({ type: 'status', text: `Code ${code} copied to clipboard.` });
        }
        break;
      }

      case 'openBrowser': {
        const uri = msg.verificationUri || lastVerificationUri || api.verificationUri();
        lastVerificationUri = uri;
        void vscode.env.openExternal(vscode.Uri.parse(uri));
        break;
      }
    }
  };

  async function handleChat(text: string, model: string | undefined, send: (p: any) => void) {
    if (!(await auth.isLoggedIn())) {
      send({ type: 'error', text: 'Please login first (Meldrix: Login).' });
      return;
    }
    if (!currentPlan) {
      const p = await refreshPlan();
      if (p) {
        send({ type: 'plan', plan: p });
      } else {
        send({ type: 'error', text: 'Could not load your subscription. Please login again.' });
        return;
      }
    }
    if (!currentPlan?.features.chat) {
      send({ type: 'error', text: 'Your plan does not include chat. Upgrade to continue.' });
      return;
    }

    // Safety: only allow models that are in the user's plan (mirrors
    // isModelAllowedForTier on the backend, which returns 402 when denied).
    const allowed = (currentPlan?.models || []).map((m) => m.id);
    if (model && allowed.length > 0 && !allowed.includes(model)) {
      send({
        type: 'error',
        text: `Model "${model}" is not available on your ${currentPlan?.planName} plan.`,
      });
      return;
    }

    // Backend chat route expects `modelId` (not `model`).
    const request: ChatRequest = {
      messages: [{ role: 'user' as const, content: text }],
      modelId: model || undefined,
      enableSearch: currentPlan?.features.webSearch,
      tools: tools.publicDefinitions(),
    };

    // Collect the AI's tool calls for the agentic loop.
    const pendingToolCalls: ToolCall[] = [];

    try {
      await api.chatStream(
        request,
        (chunk) => send({ type: 'token', text: chunk }),
        (toolCall: any) => {
          const normalized = normalizeToolCall(toolCall);
          if (normalized) {
            pendingToolCalls.push(normalized);
            send({ type: 'tool', name: normalized.name });
          }
        }
      );

      // Execute any tool calls locally and report the result.
      for (const call of pendingToolCalls) {
        const result = await tools.execute(call.name, call.arguments);
        send({ type: 'status', text: `⚙ ${call.name} → ${result.success ? 'ok' : 'failed'}` });
        // NOTE: to close the agentic loop, send `result.output` back to the
        // backend for a follow-up turn. Uncomment and wire your backend's
        // tool-result format here:
        // await api.chatStream(
        //   {
        //     messages: [...request.messages, { role: 'assistant', content: '' }],
        //     modelId: model,
        //     tools: tools.publicDefinitions(),
        //     toolResults: [{ id: call.id, name: call.name, result: result.output }],
        //   },
        //   (chunk) => send({ type: 'token', text: chunk })
        // );
      }

      send({ type: 'done' });
    } catch (e: any) {
      const message = e?.message || 'Chat failed';
      if (message === 'unauthorized' || message.includes('401')) {
        // Access token expired and refresh failed -> prompt re-login.
        currentPlan = undefined;
        void vscode.commands.executeCommand('setContext', 'meldrix.loggedIn', false);
        send({ type: 'loggedOut' });
        send({ type: 'error', text: 'Session expired. Please login again.' });
      } else {
        send({ type: 'error', text: message });
      }
    }
  }

  function normalizeToolCall(toolCall: any): ToolCall | undefined {
    if (!toolCall) return undefined;
    // Accept { name, arguments } or { function: { name, arguments } }.
    if (toolCall.function) {
      toolCall = toolCall.function;
    }
    const name = toolCall.name || toolCall.toolName;
    if (!name) return undefined;
    let args = toolCall.arguments ?? toolCall.args ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    return { id: toolCall.id || toolCall.toolCallId || String(Math.random()), name, arguments: args };
  }

  // ---- Login command (Device Authorization Flow) -----------------------
  async function commandLogin(send?: (p: any) => void) {
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Starting device sign-in...' },
      async () => {
        let device: Awaited<ReturnType<APIClient['startDeviceAuth']>>;
        try {
          device = await api.startDeviceAuth();
        } catch (e: any) {
          vscode.window.showErrorMessage(`Meldrix login failed: ${e?.message}`);
          send?.({ type: 'error', text: `Login failed: ${e?.message}` });
          return;
        }

        lastVerificationUri = device.verificationUri;

        // 1) Show the code + verification URL in the webview.
        send?.({
          type: 'deviceCode',
          userCode: device.userCode,
          verificationUri: device.verificationUri,
        });

        // 2) Open the browser to the verification URL.
        void vscode.env.openExternal(vscode.Uri.parse(device.verificationUri));

        // 3) Also surface the code prominently as a modal so the user can copy it.
        const copyAction = 'Copy Code';
        const openAgain = 'Open Browser Again';
        const choice = await vscode.window.showInformationMessage(
          `Meldrix sign-in: enter this code on ${device.verificationUri}`,
          { modal: true },
          copyAction,
          openAgain
        );
        if (choice === copyAction) {
          await vscode.env.clipboard.writeText(device.userCode);
          vscode.window.showInformationMessage('Code copied to clipboard.');
        } else if (choice === openAgain) {
          void vscode.env.openExternal(vscode.Uri.parse(device.verificationUri));
        }

        // 4) Poll for the CLI session (accessToken + refreshToken).
        const deadline = Date.now() + (device.expiresIn || 600) * 1000;
        const intervalMs = (device.interval || 5) * 1000;
        let session: Awaited<ReturnType<APIClient['pollForSession']>> | undefined;

        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, intervalMs));
          try {
            session = await api.pollForSession(device.deviceCode);
            break;
          } catch (e: any) {
            const code = e?.code;
            if (code === 'expired_token' || code === 'access_denied') {
              vscode.window.showErrorMessage(
                `Meldrix sign-in ${code === 'expired_token' ? 'expired' : 'denied'}.`
              );
              send?.({
                type: 'error',
                text: `Sign-in ${code === 'expired_token' ? 'expired' : 'denied'}. Please try again.`,
              });
              return;
            }
            // authorization_pending / slow_down -> keep polling
          }
        }

        if (!session?.accessToken) {
          vscode.window.showErrorMessage('Meldrix sign-in timed out. Please try again.');
          send?.({ type: 'error', text: 'Sign-in timed out. Please try again.' });
          return;
        }

        // 5) Save the full CLI session, fetch plan, and update UI.
        await auth.saveSession(session);
        const plan = await api.getPlan();
        setPlan(plan);
        void vscode.commands.executeCommand('setContext', 'meldrix.loggedIn', true);
        vscode.window.showInformationMessage(`Meldrix: connected (${plan.planName} plan)`);
        warnIfInactive(plan);
        send?.({ type: 'plan', plan });
      }
    );
  }

  // ---- Commands --------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('meldrix.login', () => commandLogin()),
    vscode.commands.registerCommand('meldrix.logout', async () => {
      await api.revokeSession();
      await auth.clearToken();
      currentPlan = undefined;
      void context.workspaceState.update('meldrix.plan', undefined);
      void vscode.commands.executeCommand('setContext', 'meldrix.loggedIn', false);
      vscode.window.showInformationMessage('Meldrix: logged out.');
    }),
    vscode.commands.registerCommand('meldrix.showPlan', async () => {
      if (!(await auth.isLoggedIn())) {
        vscode.window.showInformationMessage('Meldrix: you are not logged in.');
        return;
      }
      if (!currentPlan) await refreshPlan();
      const p = currentPlan;
      if (!p) {
        vscode.window.showErrorMessage('Meldrix: could not load plan.');
        return;
      }
      const f = p.features;
      const modelList = (p.models || []).map((m) => m.name).join(', ');
      const lines = [
        `Plan: ${p.planName} (${p.plan})`,
        `Status: ${p.status || 'active'}`,
        `Models: ${modelList || 'default'}`,
        `Chat: ${f.chat ? '✅' : '❌'}`,
        `Tools (edit/terminal): ${f.tools ? '✅' : '❌'}`,
        `GitHub: ${f.github ? '✅' : '❌'}`,
        `Image: ${f.imageGeneration ? '✅' : '❌'}  Video: ${f.videoGeneration ? '✅' : '❌'}  TTS: ${f.tts ? '✅' : '❌'}`,
        `Web search: ${f.webSearch ? '✅' : '❌'}`,
        `Messages/day: ${p.limits.messagesPerDay}${p.limits.usedMessages ? ` (used ${p.limits.usedMessages})` : ''}`,
        p.renewsAt ? `Renews: ${new Date(p.renewsAt).toLocaleDateString()}` : '',
        p.expiresAt ? `Expires: ${new Date(p.expiresAt).toLocaleDateString()}` : '',
      ].filter(Boolean);
      vscode.window.showInformationMessage(lines.join('\n'), { modal: true }, 'OK');
    }),
    vscode.commands.registerCommand('meldrix.refreshPlan', async () => {
      const p = await refreshPlan();
      vscode.window.showInformationMessage(
        p
          ? `Meldrix plan refreshed: ${p.planName} (${p.status || 'active'})`
          : 'Meldrix: not logged in or plan unavailable.'
      );
    }),
    vscode.commands.registerCommand('meldrix.explainCode', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('Meldrix: no active editor.');
        return;
      }
      const sel = editor.document.getText(editor.selection) || editor.document.getText();
      const panel = openPanel();
      panel.webview.postMessage({
        type: 'status',
        text: `Explain the following code:\n\n${sel.slice(0, 2000)}`,
      });
    }),
    vscode.commands.registerCommand('meldrix.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:meldrix');
    })
  );

  // ---- Sidebar view (activity bar) -------------------------------------
  class SidebarProvider implements vscode.WebviewViewProvider {
    resolveWebviewView(view: vscode.WebviewView): void {
      const ui = new MeldrixUI(context, handleMessage);
      view.webview.options = { enableScripts: true };
      view.webview.html = ui.getHtml(view.webview);
      view.webview.onDidReceiveMessage((m) => handleMessage(m, post(view.webview).send));
    }
  }
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('meldrix.view', new SidebarProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // ---- Full editor panel (Meldrix: Open Assistant) ----------------------
  let panel: vscode.WebviewPanel | undefined;

  function openPanel(): vscode.WebviewPanel {
    if (panel) {
      panel.reveal(vscode.ViewColumn.One);
      return panel;
    }
    panel = vscode.window.createWebviewPanel(
      MeldrixUI.VIEW_TYPE,
      'Meldrix AI',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const ui = new MeldrixUI(context, handleMessage);
    panel.webview.html = ui.getHtml(panel.webview);
    panel.webview.onDidReceiveMessage((m) => handleMessage(m, post(panel!.webview).send));
    panel.onDidDispose(() => (panel = undefined));
    return panel;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('meldrix.open', () => {
      openPanel();
    })
  );

  // Restore cached plan + set login context at startup.
  void (async () => {
    const cached = context.workspaceState.get<PlanInfo>('meldrix.plan');
    if (cached) {
      currentPlan = cached;
    }
    const loggedIn = await auth.isLoggedIn();
    void vscode.commands.executeCommand('setContext', 'meldrix.loggedIn', loggedIn);
    if (loggedIn) {
      void refreshPlan();
    }
  })();
}

export function deactivate() {}
