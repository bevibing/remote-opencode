/**
 * Upstream OpenCode server authentication support.
 *
 * Mirrors the behavior of `opencode serve` when the following environment
 * variables are set:
 *   - OPENCODE_SERVER_PASSWORD — enables HTTP Basic auth on the server
 *   - OPENCODE_SERVER_USERNAME — optional, defaults to "opencode"
 *
 * When neither is set, this module is a no-op and existing behavior is
 * preserved. We never introduce our own auth mechanism; we only forward the
 * upstream credentials to the local opencode server so internal requests
 * (session HTTP calls, SSE /event stream, readiness checks) continue to work.
 *
 * This is optional hardening / compatibility for users who already rely on
 * upstream `OPENCODE_SERVER_PASSWORD`. It is not a replacement for the
 * Discord-side allowlist or other access controls.
 */

const DEFAULT_USERNAME = "opencode";

function getPassword(): string | undefined {
  const pw = process.env.OPENCODE_SERVER_PASSWORD;
  return pw && pw.length > 0 ? pw : undefined;
}

function getUsername(): string {
  const user = process.env.OPENCODE_SERVER_USERNAME;
  return user && user.length > 0 ? user : DEFAULT_USERNAME;
}

/**
 * Returns the base64 encoded `username:password` token expected by the
 * upstream `auth_token` query parameter, or undefined when auth is disabled.
 */
export function getAuthToken(): string | undefined {
  const pw = getPassword();
  if (!pw) return undefined;
  return Buffer.from(`${getUsername()}:${pw}`).toString("base64");
}

/**
 * Returns true when OPENCODE_SERVER_PASSWORD is set.
 */
export function isAuthEnabled(): boolean {
  return getPassword() !== undefined;
}

/**
 * Returns an object with an `Authorization: Basic <token>` header when auth
 * is enabled, or an empty object otherwise. Safe to spread into fetch headers.
 */
export function getAuthHeaders(): Record<string, string> {
  const token = getAuthToken();
  if (!token) return {};
  return { Authorization: `Basic ${token}` };
}

/**
 * Throws a clear, actionable error when a response indicates an auth
 * misconfiguration so the user does not see a vague connection failure.
 */
export function assertNotAuthError(status: number, context: string): void {
  if (status !== 401 && status !== 403) return;
  if (isAuthEnabled()) {
    throw new Error(
      `${context}: opencode server rejected credentials (HTTP ${status}). ` +
        `Check that OPENCODE_SERVER_PASSWORD (and OPENCODE_SERVER_USERNAME if set) ` +
        `match the values the opencode server was started with.`,
    );
  }
  throw new Error(
    `${context}: opencode server requires authentication (HTTP ${status}) but ` +
      `OPENCODE_SERVER_PASSWORD is not set in this process. Set it to the same ` +
      `value the opencode server was started with.`,
  );
}
