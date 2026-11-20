// Sign-in through the browser with OAuth 2 (authorization code with PKCE) for servers that are their own
// identity provider: GitLab, Gitea and Forgejo. The user signs in on the server's own page, so whatever that
// page accepts works: password, passkey, a security key such as a YubiKey, single sign-on.
//
// No public address is needed. The server sends the browser to a loopback address (http://127.0.0.1:5594/callback)
// where nothing listens; the user copies the address of that page into the app. Gitea and GitLab accept loopback
// redirects for public clients, which is what makes this work from any device.
import { createHash, randomBytes } from 'node:crypto';
import { requestJson, ProviderError } from './http.mjs';
import { AppError } from '../util/errors.mjs';

export const REDIRECT_URI = 'http://127.0.0.1:5594/callback';

export function createPkce() {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export const randomState = () => randomBytes(16).toString('base64url');

/**
 * What the user pastes: the address the browser ended on (`http://127.0.0.1:5594/callback?code=…&state=…`),
 * only its query, or just the code.
 * @returns {{code:string, state:string|null, error:string|null}}
 */
export function parseRedirect(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new AppError(400, 'oauth_missing_code', 'Paste the address of the page that opened after the sign-in.');
  const query = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text;
  const params = new URLSearchParams(query.replace(/#.*$/, ''));
  if (params.has('code') || params.has('error')) {
    return { code: params.get('code') ?? '', state: params.get('state'), error: params.get('error_description') ?? params.get('error') };
  }
  // Not a query: take it as the bare code.
  return { code: text, state: null, error: null };
}

function tokenResult(data) {
  if (!data?.access_token) throw new ProviderError('oauth_failed', 'The server did not return an access token.');
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : null,
  };
}

const webBaseOf = (provider, endpoint) => provider.webUrl(endpoint);

/** Step 1: the address the user opens to sign in. */
export function beginBrowserLogin(provider, { endpoint, clientId }) {
  if (!provider.browserLogin) throw new AppError(400, 'unsupported', 'This server type has no sign-in through the browser');
  const { verifier, challenge } = createPkce();
  const state = randomState();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: provider.browserLogin.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return { authorizeUrl: `${webBaseOf(provider, endpoint)}${provider.browserLogin.authorizePath}?${params}`, state, verifier };
}

/** Step 2: exchanges what the user pasted for tokens. */
export async function finishBrowserLogin(provider, ctx, { clientId, verifier, state, pasted }) {
  const redirect = parseRedirect(pasted);
  if (redirect.error) throw new AppError(400, 'oauth_denied', `The server refused the sign-in: ${redirect.error}`);
  if (!redirect.code) throw new AppError(400, 'oauth_missing_code', 'The address does not contain a code. Paste the whole address of the page that opened.');
  if (redirect.state !== null && redirect.state !== state) throw new AppError(400, 'oauth_state_mismatch', 'This address belongs to another sign-in. Start again.');
  const { data } = await requestJson(`${webBaseOf(provider, ctx.endpoint)}${provider.browserLogin.tokenPath}`, {
    method: 'POST',
    form: { grant_type: 'authorization_code', client_id: clientId, code: redirect.code, redirect_uri: REDIRECT_URI, code_verifier: verifier },
    fetch: ctx.fetch,
  });
  return tokenResult(data);
}

/** Access tokens expire (Gitea after an hour, GitLab after two); the refresh token renews them. */
export async function refreshAccessToken(provider, ctx, { clientId, refreshToken }) {
  const { data } = await requestJson(`${webBaseOf(provider, ctx.endpoint)}${provider.browserLogin.tokenPath}`, {
    method: 'POST',
    form: { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken },
    fetch: ctx.fetch,
  });
  const result = tokenResult(data);
  // A server that does not rotate refresh tokens does not send a new one: keep the old one.
  return { ...result, refreshToken: result.refreshToken ?? refreshToken };
}
