import * as vscode from 'vscode';

/**
 * Shared webview HTML + message routing used by both the sidebar view and the
 * full editor panel. The actual client-side logic lives in media/webview.js.
 */
export class MeldrixUI {
  static readonly VIEW_TYPE = 'meldrixChat';

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly onMessage: (msg: any, reply: (payload: any) => void) => void
  ) {}

  getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview.css')
    );
    const nonce = this.nonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>Meldrix AI</title>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="spark">✦</span>
        <span>Meldrix AI</span>
      </div>
      <div class="topbar-right">
        <select id="modelSelect" class="model-select" title="AI model"></select>
        <div id="planBadge" class="plan-badge">–</div>
      </div>
    </header>

    <div id="messages" class="messages"></div>

    <div class="composer">
      <textarea id="input" rows="1" placeholder="Ask Meldrix to build, explain or debug..."></textarea>
      <button id="send" title="Send">➤</button>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private nonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}