import * as vscode from 'vscode';
import { AuthManager } from './auth';
import { APIClient } from './api';
import { ToolRegistry } from './tools';
import { PlanInfo, DEFAULT_PLAN, ToolCall } from './types';
import { MeldrixUI } from './ui';

/**
 * Meldrix AI — VS Code extension entry point.
 *
 * Flow:
 *   1. User logs in (token saved in SecretStorage).
 *   2. On activation (and every login) we fetch the subscription plan
 *      from the backend DB using the auth token.
 *   3. The plan decides which tools are exposed to the AI and in the UI.
 *   4. Chat is streamed from the backend; the AI can invoke tools which we
 *      execute locally (file edit, terminal, search, ...).
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

  // ---- Status bar indicator -------------------------------------------
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = '$(sparkle) Meldrix';
  statusBar.command = 'meldrix.open';
  statusBar.tooltip = 'Open Meldrix AI assistant';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // ---- Shared message handler for chat UI -----------------------------
  const post = (webview: vscode.Webview) => ({
    send: (payload: any) => void webview.postMessage(payload),
  });

  async function refreshPlan(): Promise<void> {
    try {
      const plan = await api.getPlan();
      setPlan(plan);
      void vscode.commands.executeCommand(
        'setContext',
        'meldrix.loggedIn',
        true
      );
      return plan as unknown as void;
    } catch (e: any) {
      if (e?.message === 'unauthorized' || e?.message?.includes('401')) {
        currentPlan = undefined;
        void vscode.commands.executeCommand('setContext', 'meldrix.loggedIn', false);
      }
      return undefined;
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
          }
          send({ type: 'plan', plan: cached || DEFAULT_PLAN });
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
        await handleChat(msg.text, send);
        break;
      }
    }
  };

  async function handleChat(text: string, send: (p: any) => void) {
    if (!(await auth.isLoggedIn())) {
      send({ type: 'error', text: 'Please login first (Meldrix: Login).' });
      return;
    }
    if (!currentPlan) {
      await refreshPlan();
    }
    if (!currentPlan?.features.chat) {
      send({ type: 'error', text: 'Your plan does not include chat. Upgrade to continue.' });
      return;
    }

    const request = {
      messages: [{ role: 'user' as const, content: text }],
      tools: tools.publicDefinitions(),
    };

    // Collect the AI's tool calls (single loop for simplicity).
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

      // Execute any tool calls and (optionally) report results back.
      for (const call of pendingToolCalls) {
        const result = await tools.execute(call.name, call.arguments);
        send({ type: 'status', text: `⚙ ${call.name} → ${result.success ? 'ok' : 'failed'}` });
        // Could send the result back to the backend for a follow-up turn;
        // uncomment to close the agentic loop:
        // await api.chatStream({
        //   messages: [...request.messages, { role: 'assistant', content: '' }],
        //   tools: tools.publicDefinitions(),
        //   toolResults: [{ id: call.id, name: call.name, result: result.output }],
        // }, (chunk) => send({ type: 'token', text: chunk }));
      }

      send({ type: 'done' });
    } catch (e: any) {
      send({ type: 'error', text: e?.message || 'Chat failed' });
    }
  }

  function normalizeToolCall(toolCall: any): ToolCall | undefined {
    if (!toolCall) return undefined;
    // Accept { name, arguments } or { function: { name, arguments } }.
    if (toolCall.function) {
      toolCall = toolCall.function;
    }
    if (!toolCall.name) return undefined;
    let args = toolCall.arguments ?? toolCall.args ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    return { id: toolCall.id || String(Math.random()), name: toolCall.name, arguments: args };
  }

  // ---- Login command ---------------------------------------------------
  async function commandLogin(send?: (p: any) => void) {
    const email = await vscode.window.showInputBox({
      prompt: 'Meldrix account email',
      placeHolder: 'you@example.com',
      ignoreFocusOut: true,
    });
    if (!email) return;

    const password = await vscode.window.showInputBox({
      prompt: 'Password',
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) return;

    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Signing in to Meldrix...' },
      async () => {
        try {
          const token = await api.login(email, password);
          await auth.saveToken(token);
          const plan = await api.getPlan();
          setPlan(plan);
          void vscode.commands.executeCommand('setContext', 'meldrix.loggedIn', true);
          vscode.window.showInformationMessage(`Meldrix: connected as ${email} (${plan.planName} plan)`);
          send?.({ type: 'plan', plan });
        } catch (e: any) {
          vscode.window.showErrorMessage(`Meldrix login failed: ${e?.message}`);
          send?.({ type: 'error', text: `Login failed: ${e?.message}` });
        }
      }
    );
  }

  // ---- Commands --------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('meldrix.login', () => commandLogin()),
    vscode.commands.registerCommand('meldrix.logout', async () => {
      await auth.clearToken();
      currentPlan = undefined;
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
      const lines = [
        `Plan: ${p.planName} (${p.plan})`,
        `Chat: ${f.chat ? '✅' : '❌'}`,
        `Tools (edit/terminal): ${f.tools ? '✅' : '❌'}`,
        `GitHub: ${f.github ? '✅' : '❌'}`,
        `Image: ${f.imageGeneration ? '✅' : '❌'}  Video: ${f.videoGeneration ? '✅' : '❌'}  TTS: ${f.tts ? '✅' : '❌'}`,
        `Messages/day: ${p.limits.messagesPerDay}${p.limits.usedMessages ? ` (used ${p.limits.usedMessages})` : ''}`,
      ];
      vscode.window.showInformationMessage(lines.join('\n'), { modal: true }, 'OK');
    }),
    vscode.commands.registerCommand('meldrix.refreshPlan', async () => {
      await refreshPlan();
      vscode.window.showInformationMessage(
        currentPlan
          ? `Meldrix plan refreshed: ${currentPlan.planName}`
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
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:meldrix'
      );
    })
  );

  // ---- Sidebar view (activity bar) -------------------------------------
  class SidebarProvider implements vscode.WebviewViewProvider {
    resolveWebviewView(view: vscode.WebviewView): void {
      const ui = new MeldrixUI(context, handleMessage);
      view.webview.options = { enableScripts: true };
      view.webview.html = ui.getHtml(view.webview);
      view.webview.onDidReceiveMessage((m) =>
        handleMessage(m, post(view.webview).send)
      );
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
    panel.webview.onDidReceiveMessage((m) =>
      handleMessage(m, post(panel!.webview).send)
    );
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