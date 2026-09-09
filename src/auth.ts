import * as vscode from 'vscode';

/**
 * AuthManager handles the user's Meldrix auth token.
 *
 * The token is stored securely in VS Code's SecretStorage (backed by the OS
 * keychain on macOS/Windows and libsecret on Linux). A static token can also
 * be supplied through the `meldrix.authToken` setting as a fallback.
 */
export class AuthManager {
  private static readonly SECRET_KEY = 'meldrix.authToken';

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /** Returns the current auth token, or undefined if not logged in. */
  async getToken(): Promise<string | undefined> {
    const secret = await this.ctx.secrets.get(AuthManager.SECRET_KEY);
    if (secret) {
      return secret;
    }
    const fromSetting = vscode.workspace
      .getConfiguration('meldrix')
      .get<string>('authToken');
    return fromSetting && fromSetting.length > 0 ? fromSetting : undefined;
  }

  async isLoggedIn(): Promise<boolean> {
    return (await this.getToken()) !== undefined;
  }

  async saveToken(token: string): Promise<void> {
    await this.ctx.secrets.store(AuthManager.SECRET_KEY, token.trim());
  }

  async clearToken(): Promise<void> {
    await this.ctx.secrets.delete(AuthManager.SECRET_KEY);
  }
}