// GitHub.com and GitHub Enterprise Server.
import { paginate, parseBaseUrl, requestJson } from './http.mjs';
import { hmacSha256Hex, safeEqual } from '../security/crypto.mjs';

const DEFAULT_API = 'https://api.github.com/';
const TOKEN_NAME = 'Renovate (Home Assistant)';
const SCOPES = ['repo', 'workflow'];

/**
 * Registered OAuth App with "Enable Device Flow" switched on. The id is public by design (it identifies the
 * app, it is not a secret). Until one is registered, the sign-in button stays hidden and the token guide is
 * shown instead. Can also be set per installation with the option `advanced.github_client_id`.
 */
export const DEFAULT_CLIENT_ID = '';

const apiToWeb = (endpoint) => (endpoint === DEFAULT_API ? 'https://github.com' : endpoint.replace(/\/api\/v3\/?$/, '').replace(/\/$/, ''));

const headersFor = ({ token }) => ({ Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' });

export const github = {
  id: 'github',
  label: 'GitHub',
  renovatePlatform: 'github',
  endpointRequired: false,
  defaultEndpoint: DEFAULT_API,
  // The pull request events of Renovate itself and the Dependency Dashboard issue are the useful triggers.
  webhookEvents: ['push', 'pull_request', 'issues'],

  normalizeEndpoint(input) {
    if (!input) return DEFAULT_API;
    const url = parseBaseUrl(input);
    if (['github.com', 'api.github.com', 'www.github.com'].includes(url.host)) return DEFAULT_API;
    return `${url.origin}${url.path.endsWith('/api/v3') ? url.path : `${url.path}/api/v3`}/`;
  },

  webUrl: apiToWeb,

  tokenGuide(endpoint) {
    const web = apiToWeb(endpoint);
    const query = new URLSearchParams({ description: TOKEN_NAME, scopes: SCOPES.join(',') });
    const fine = new URLSearchParams({
      name: TOKEN_NAME,
      description: 'Dependency updates by Renovate',
      expires_in: '365',
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      workflows: 'write',
      metadata: 'read',
    });
    return {
      scopes: SCOPES,
      url: `${web}/settings/tokens/new?${query}`,
      alternativeUrl: `${web}/settings/personal-access-tokens/new?${fine}`,
    };
  },

  async whoami(ctx) {
    const { data, headers } = await requestJson(`${ctx.endpoint}user`, { headers: headersFor(ctx), fetch: ctx.fetch });
    const granted = headers.get('x-oauth-scopes');
    const warnings = [];
    // Fine-grained tokens send no scope header; for classic tokens a missing scope is easy to explain.
    if (granted !== null) {
      const have = granted.split(',').map((scope) => scope.trim());
      for (const needed of SCOPES) if (!have.includes(needed)) warnings.push({ code: 'missing_scope', scope: needed });
    }
    return { id: String(data.id), login: data.login, name: data.name ?? data.login, avatarUrl: data.avatar_url ?? null, warnings };
  },

  async *listRepositories(ctx) {
    const url = `${ctx.endpoint}user/repos?per_page=100&sort=full_name&affiliation=owner,collaborator,organization_member`;
    for await (const repo of paginate(url, { headers: headersFor(ctx), fetch: ctx.fetch })) {
      yield {
        fullName: repo.full_name,
        description: repo.description ?? null,
        htmlUrl: repo.html_url,
        defaultBranch: repo.default_branch ?? null,
        isPrivate: Boolean(repo.private),
        isFork: Boolean(repo.fork),
        isArchived: Boolean(repo.archived),
        canPush: repo.permissions?.push ?? true,
      };
    }
  },

  /** Sign-in without a redirect URL: the user types a short code on github.com. */
  deviceFlow: {
    async start(ctx, clientId) {
      const web = apiToWeb(ctx.endpoint);
      const { data } = await requestJson(`${web}/login/device/code`, { method: 'POST', form: { client_id: clientId, scope: SCOPES.join(' ') }, fetch: ctx.fetch });
      return { deviceCode: data.device_code, userCode: data.user_code, verificationUri: data.verification_uri, expiresIn: data.expires_in, interval: data.interval ?? 5 };
    },
    /** @returns {Promise<{status:'pending'|'slow_down'|'expired'|'denied'|'granted', token?:string}>} */
    async poll(ctx, clientId, deviceCode) {
      const web = apiToWeb(ctx.endpoint);
      const { data } = await requestJson(`${web}/login/oauth/access_token`, {
        method: 'POST',
        form: { client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
        fetch: ctx.fetch,
      });
      if (data.access_token) return { status: 'granted', token: data.access_token };
      const map = { authorization_pending: 'pending', slow_down: 'slow_down', expired_token: 'expired', access_denied: 'denied' };
      return { status: map[data.error] ?? 'denied' };
    },
  },

  webhooks: {
    async register(ctx, repository, { url, secret, events }) {
      const base = `${ctx.endpoint}repos/${repository}/hooks`;
      const { data: existing } = await requestJson(`${base}?per_page=100`, { headers: headersFor(ctx), fetch: ctx.fetch });
      const found = Array.isArray(existing) ? existing.find((hook) => hook.config?.url === url) : null;
      const payload = { active: true, events, config: { url, content_type: 'json', secret, insecure_ssl: '0' } };
      if (found) {
        await requestJson(`${base}/${found.id}`, { method: 'PATCH', headers: headersFor(ctx), body: payload, fetch: ctx.fetch });
        return 'updated';
      }
      await requestJson(base, { method: 'POST', headers: headersFor(ctx), body: { name: 'web', ...payload }, fetch: ctx.fetch });
      return 'created';
    },

    /** @returns {boolean} whether the signature proves the body came from the configured hook */
    verify(headers, rawBody, secret) {
      const signature = headers['x-hub-signature-256'];
      return typeof signature === 'string' && safeEqual(signature, `sha256=${hmacSha256Hex(secret, rawBody)}`);
    },

    /** Reduces a delivery to what the app needs: which repository, what happened, who did it. */
    parse(headers, payload) {
      const event = headers['x-github-event'];
      const repository = payload.repository?.full_name;
      const sender = payload.sender?.login;
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

  /** What Renovate needs to talk to this provider. */
  renovateConnection(connection) {
    return { platform: 'github', endpoint: connection.endpoint === DEFAULT_API ? null : connection.endpoint };
  },
};
