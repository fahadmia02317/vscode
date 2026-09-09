import * as vscode from 'vscode';
import { CliSession } from './types';

/**
 * AuthManager handles the user's Meldrix CLI session credentials.
 *
 * The real backend (lib/auth/cli.ts) issues a session with BOTH an
 * `accessToken` and a `refreshToken` via `issueCliSession(deviceCode)`.
 * `getAuthenticatedDbUser(request)` validates the accessToken through
 * `getCliSession(token)` when it arrives as `Authorization: Bearer <token>`.
 *
 * Storage: VS Code SecretStorage (OS keychain on macOS/Windows, libsecret on
 * Linux). We persist the whole session as JSON so the refreshToken survives
 * restarts and can be used to silently re-authenticate.
 *
 * A static token can also be supplied through the `meldrix.authToken` setting
 * as a fallback for testing.
 */
export class AuthManager {
  private static readonly SECRET_KEY = 'meldrix.cliSession';
  /** Legacy key from earlier versions — migrated on read. */
  private static readonly LEGACY_SECRET_KEY = 'meldrix.authToken';

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /** Returns the full stored CLI session, or undefined if not logged in. */
  async getSession(): Promise<CliSession | undefined> {
    const raw = await this.ctx.secrets.get(AuthManager.SECRET_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as CliSession;
        if (parsed?.accessToken) {
          return parsed;
        }
      } catch {
        // Stored value is a bare token string (older format) — wrap it.
        if (raw.trim().length > 0) {
          return { accessToken: raw.trim() };
        }
      }
    }

    // Migrate from the legacy single-token key if present.
    const legacy = await this.ctx.secrets.get(AuthManager.LEGACY_SECRET_KEY);
    if (legacy && legacy.trim().length > 0) {
      const session: CliSession = { accessToken: legacy.trim() };
      await this.saveSession(session);
      await this.ctx.secrets.delete(AuthManager.LEGACY_SECRET_KEY);
      return session;
    }

    // Final fallback: static token from settings (useful for local testing).
    const fromSetting = vscode.workspace.getConfiguration('meldrix').get<string>('authToken');
    if (fromSetting && fromSetting.trim().length > 0) {
      return { accessToken: fromSetting.trim() };
    }

    return undefined;
  }

  /** Returns the current access token, or undefined if not logged in. */
  async getToken(): Promise<string | undefined> {
    const session = await this.getSession();
    return session?.accessToken;
  }

  /** Returns the refresh token, if the backend issued one. */
  async getRefreshToken(): Promise<string | undefined> {
    const session = await this.getSession();
    return session?.refreshToken;
  }

  async isLoggedIn(): Promise<boolean> {
    return (await this.getToken()) !== undefined;
  }

  /** Persists a full CLI session (accessToken + refreshToken + expiry). */
  async saveSession(session: CliSession): Promise<void> {
    await this.ctx.secrets.store(
      AuthManager.SECRET_KEY,
      JSON.stringify({
        accessToken: session.accessToken.trim(),
        refreshToken: session.refreshToken?.trim(),
        expiresAt: session.expiresAt,
        email: session.email,
      })
    );
  }

  /** Backwards-compatible helper: store a bare access token. */
  async saveToken(token: string): Promise<void> {
    const existing = await this.getSession();
    await this.saveSession({
      accessToken: token,
      refreshToken: existing?.refreshToken,
      expiresAt: existing?.expiresAt,
      email: existing?.email,
    });
  }

  /** Updates only the access token after a successful refresh. */
  async updateAccessToken(accessToken: string, expiresAt?: string | number): Promise<void> {
    const existing = await this.getSession();
    await this.saveSession({
      accessToken,
      refreshToken: existing?.refreshToken,
      expiresAt: expiresAt ?? existing?.expiresAt,
      email: existing?.email,
    });
  }

  /** True when the stored access token is known to be expired. */
  async isExpired(): Promise<boolean> {
    const session = await this.getSession();
    if (!session?.expiresAt) return false;

    const expiryMs =
      typeof session.expiresAt === 'number'
        ? // Heuristic: values < 1e12 are epoch seconds.
          session.expiresAt < 1e12
          ? session.expiresAt * 1000
          : session.expiresAt
        : Date.parse(session.expiresAt);

    if (Number.isNaN(expiryMs)) return false;
    // Treat as expired 60s early to avoid mid-request failures.
    return Date.now() >= expiryMs - 60_000;
  }

  async clearToken(): Promise<void> {
    await this.ctx.secrets.delete(AuthManager.SECRET_KEY);
    await this.ctx.secrets.delete(AuthManager.LEGACY_SECRET_KEY);
  }
}
