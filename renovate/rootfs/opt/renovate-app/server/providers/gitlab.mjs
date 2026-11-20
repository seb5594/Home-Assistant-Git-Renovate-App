// GitLab.com and self-managed GitLab.
import { paginate, parseBaseUrl, requestJson } from './http.mjs';
import { safeEqual } from '../security/crypto.mjs';

const DEFAULT_API = 'https://gitlab.com/api/v4/';
const TOKEN_NAME = 'Renovate (Home Assistant)';
const SCOPES = ['api', 'write_repository'];
// Developer: the lowest role that may push branches and open merge requests.
const DEVELOPER = 30;

const apiToWeb = (endpoint) => endpoint.replace(/\/api\/v4\/?$/, '').replace(/\/$/, '');
const headersFor = ({ token }) => ({ 'PRIVATE-TOKEN': token });

export const gitlab = {
  id: 'gitlab',
  label: 'GitLab',
  renovatePlatform: 'gitlab',
  endpointRequired: false,
  defaultEndpoint: DEFAULT_API,
  webhookEvents: ['push', 'merge_requests', 'issues'],

  normalizeEndpoint(input) {
    if (!input) return DEFAULT_API;
    const url = parseBaseUrl(input);
    if (['gitlab.com', 'www.gitlab.com'].includes(url.host)) return DEFAULT_API;
    return `${url.origin}${url.path.endsWith('/api/v4') ? url.path : `${url.path}/api/v4`}/`;
  },

  webUrl: apiToWeb,

  tokenGuide(endpoint) {
    const query = new URLSearchParams({ name: TOKEN_NAME, scopes: SCOPES.join(',') });
    return { scopes: SCOPES, url: `${apiToWeb(endpoint)}/-/user_settings/personal_access_tokens?${query}` };
  },

  async whoami(ctx) {
    const { data } = await requestJson(`${ctx.endpoint}user`, { headers: headersFor(ctx), fetch: ctx.fetch });
    const warnings = [];
    try {
      // Tells the scopes of a personal access token; other token kinds answer 404, which is fine.
      const { data: self } = await requestJson(`${ctx.endpoint}personal_access_tokens/self`, { headers: headersFor(ctx), fetch: ctx.fetch });
      const have = self.scopes ?? [];
      if (!have.includes('api')) {
        for (const needed of SCOPES) if (!have.includes(needed)) warnings.push({ code: 'missing_scope', scope: needed });
      }
    } catch {
      // Not a personal access token: nothing to verify.
    }
    return { id: String(data.id), login: data.username, name: data.name ?? data.username, avatarUrl: data.avatar_url ?? null, warnings };
  },

  async *listRepositories(ctx) {
    const url = `${ctx.endpoint}projects?membership=true&min_access_level=${DEVELOPER}&simple=true&per_page=100&order_by=path&sort=asc`;
    for await (const project of paginate(url, { headers: headersFor(ctx), fetch: ctx.fetch })) {
      yield {
        fullName: project.path_with_namespace,
        description: project.description ?? null,
        htmlUrl: project.web_url,
        defaultBranch: project.default_branch ?? null,
        isPrivate: project.visibility !== 'public',
        isFork: Boolean(project.forked_from_project),
        isArchived: Boolean(project.archived),
        canPush: true,
      };
    }
  },

  // GitLab's device grant issues tokens that expire after two hours, which a scheduled job cannot use
  // without refresh logic. Personal access tokens are the dependable choice, so no device flow here.
  deviceFlow: null,

  webhooks: {
    async register(ctx, repository, { url, secret }) {
      const base = `${ctx.endpoint}projects/${encodeURIComponent(repository)}/hooks`;
      const { data: existing } = await requestJson(`${base}?per_page=100`, { headers: headersFor(ctx), fetch: ctx.fetch });
      const found = Array.isArray(existing) ? existing.find((hook) => hook.url === url) : null;
      const payload = { url, token: secret, push_events: true, merge_requests_events: true, issues_events: true, enable_ssl_verification: true };
      if (found) {
        await requestJson(`${base}/${found.id}`, { method: 'PUT', headers: headersFor(ctx), body: payload, fetch: ctx.fetch });
        return 'updated';
      }
      await requestJson(base, { method: 'POST', headers: headersFor(ctx), body: payload, fetch: ctx.fetch });
      return 'created';
    },

    verify(headers, _rawBody, secret) {
      const token = headers['x-gitlab-token'];
      return typeof token === 'string' && safeEqual(token, secret);
    },

    parse(headers, payload) {
      const event = headers['x-gitlab-event'];
      const repository = payload.project?.path_with_namespace;
      const sender = payload.user_username ?? payload.user?.username;
      if (event === 'Push Hook') {
        const onDefault = payload.ref === `refs/heads/${payload.project?.default_branch}`;
        return { kind: onDefault ? 'push-default' : 'ignored', repository, sender };
      }
      if (event === 'Merge Request Hook') {
        const closed = ['merge', 'close'].includes(payload.object_attributes?.action);
        return { kind: closed ? 'pull-request-closed' : 'ignored', repository, sender };
      }
      if (event === 'Issue Hook') {
        const edited = payload.object_attributes?.action === 'update' && Boolean(payload.changes?.description);
        return { kind: edited ? 'issue-edited' : 'ignored', repository, sender, title: payload.object_attributes?.title };
      }
      return { kind: 'ignored', repository, sender };
    },
  },

  renovateConnection(connection) {
    return { platform: 'gitlab', endpoint: connection.endpoint === DEFAULT_API ? null : connection.endpoint };
  },
};
