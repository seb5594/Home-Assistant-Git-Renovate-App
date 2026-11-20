// Gitea and Forgejo (including Codeberg). Both speak the same API, so one implementation serves two ids.
import { paginate, parseBaseUrl, requestJson, ProviderError } from './http.mjs';
import { hmacSha256Hex, randomId, safeEqual } from '../security/crypto.mjs';

// From the Renovate documentation: repository and issue write, user and organization read (Gitea 1.20 and newer),
// and misc read, which only Gitea 1.20.0 and 1.20.1 need. Older versions ignore scopes they do not know.
const SCOPES = ['write:repository', 'write:issue', 'read:user', 'read:organization', 'read:misc'];
const TOKEN_PREFIX = 'renovate-home-assistant';

const apiToWeb = (endpoint) => endpoint.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
const tokenHeaders = ({ token }) => ({ Authorization: `token ${token}` });
const basicHeaders = (username, password, otp) => ({
  Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
  ...(otp ? { 'X-GITEA-OTP': otp } : {}),
});

function createProvider(id, label) {
  return {
    id,
    label,
    renovatePlatform: id,
    endpointRequired: true,
    defaultEndpoint: null,
    credentials: 'token',
    usernameRequired: false,
    beta: false,
    webhookEvents: ['push', 'pull_request', 'issues'],

    normalizeEndpoint(input) {
      if (!input) throw new ProviderError('invalid_address', 'The address of your server is required.');
      const url = parseBaseUrl(input);
      return `${url.origin}${url.path.endsWith('/api/v1') ? url.path : `${url.path}/api/v1`}/`;
    },

    webUrl: apiToWeb,

    tokenGuide(endpoint) {
      return { scopes: SCOPES, url: `${apiToWeb(endpoint)}/user/settings/applications` };
    },

    async whoami(ctx) {
      const { data } = await requestJson(`${ctx.endpoint}user`, { headers: tokenHeaders(ctx), fetch: ctx.fetch });
      // Renovate's documentation asks for a full name and an email address on the account: its commits use them.
      const warnings = data.full_name && data.email ? [] : [{ code: 'missing_profile' }];
      return { id: String(data.id), login: data.login, name: data.full_name || data.login, avatarUrl: data.avatar_url ?? null, warnings };
    },

    async *listRepositories(ctx) {
      for await (const repo of paginate(`${ctx.endpoint}user/repos?limit=50`, { headers: tokenHeaders(ctx), fetch: ctx.fetch })) {
        yield {
          fullName: repo.full_name,
          description: repo.description || null,
          htmlUrl: repo.html_url,
          defaultBranch: repo.default_branch ?? null,
          isPrivate: Boolean(repo.private),
          isFork: Boolean(repo.fork),
          isArchived: Boolean(repo.archived),
          // Renovate skips mirrors and repositories with pull requests switched off, so they are not offered either.
          canPush: (repo.permissions?.push ?? true) && !repo.mirror && repo.has_pull_requests !== false,
        };
      }
    },

    /** Gitea has no device flow, but it can hand out a token in exchange for the password, once. */
    credentialLogin: {
      /**
       * Creates a token with exactly the scopes Renovate needs. The password is used for this one request
       * and never stored.
       */
      async createToken(ctx, { username, password, otp }) {
        const name = `${TOKEN_PREFIX}-${randomId(3)}`;
        let reply;
        try {
          reply = await requestJson(`${ctx.endpoint}users/${encodeURIComponent(username)}/tokens`, {
            method: 'POST',
            headers: basicHeaders(username, password, otp),
            body: { name, scopes: SCOPES },
            fetch: ctx.fetch,
          });
        } catch (error) {
          if (error.upstreamStatus === 401 || error.upstreamStatus === 403) {
            const needsOtp = /otp|two.?factor|2fa|security key/i.test(error.message) && !otp;
            throw new ProviderError(needsOtp ? 'provider_otp_required' : 'provider_bad_credentials',
              needsOtp ? 'This account uses two-factor authentication. Enter the current code.' : 'Wrong user name or password.', error.upstreamStatus);
          }
          throw error;
        }
        return { token: reply.data.sha1 ?? reply.data.token, tokenName: name };
      },
    },

    deviceFlow: null,

    // Passkeys, security keys and single sign-on work through the browser, which signs in on Gitea's own page.
    browserLogin: { scope: SCOPES.join(' '), authorizePath: '/login/oauth/authorize', tokenPath: '/login/oauth/access_token', applicationsPath: '/user/settings/applications' },

    webhooks: {
      async register(ctx, repository, { url, secret, events }) {
        const base = `${ctx.endpoint}repos/${repository}/hooks`;
        const { data: existing } = await requestJson(`${base}?limit=50`, { headers: tokenHeaders(ctx), fetch: ctx.fetch });
        const found = Array.isArray(existing) ? existing.find((hook) => hook.config?.url === url) : null;
        const payload = { active: true, events, config: { url, content_type: 'json', secret } };
        if (found) {
          await requestJson(`${base}/${found.id}`, { method: 'PATCH', headers: tokenHeaders(ctx), body: payload, fetch: ctx.fetch });
          return 'updated';
        }
        await requestJson(base, { method: 'POST', headers: tokenHeaders(ctx), body: { type: id, ...payload }, fetch: ctx.fetch });
        return 'created';
      },

      verify(headers, rawBody, secret) {
        const expected = hmacSha256Hex(secret, rawBody);
        const candidates = [headers['x-gitea-signature'], headers['x-forgejo-signature'], headers['x-hub-signature-256']?.replace(/^sha256=/, '')];
        return candidates.some((candidate) => typeof candidate === 'string' && safeEqual(candidate, expected));
      },

      parse(headers, payload) {
        const event = headers['x-forgejo-event'] ?? headers['x-gitea-event'];
        const repository = payload.repository?.full_name;
        const sender = payload.sender?.login ?? payload.sender?.username;
        if (event === 'ping') return { kind: 'ping', repository, sender };
        if (event === 'push') {
          const onDefault = payload.ref === `refs/heads/${payload.repository?.default_branch}`;
          return { kind: onDefault ? 'push-default' : 'ignored', repository, sender };
        }
        if (event === 'pull_request') {
          return { kind: payload.action === 'closed' ? 'pull-request-closed' : 'ignored', repository, sender };
        }
        if (event === 'issues') {
          return { kind: payload.action === 'edited' ? 'issue-edited' : 'ignored', repository, sender, title: payload.issue?.title };
        }
        return { kind: 'ignored', repository, sender };
      },
    },

    renovateConnection(connection) {
      return { platform: id, endpoint: connection.endpoint, auth: 'token' };
    },
  };
}

export const gitea = createProvider('gitea', 'Gitea');
export const forgejo = createProvider('forgejo', 'Forgejo');
