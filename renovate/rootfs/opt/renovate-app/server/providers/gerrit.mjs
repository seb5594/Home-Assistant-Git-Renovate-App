// Gerrit (experimental in Renovate). Signs in with the account name and the HTTP password of that account.
import { basicAuth, parseBaseUrl, requestJson, ProviderError } from './http.mjs';

const headersFor = (ctx) => ({ Authorization: basicAuth(ctx.username, ctx.token) });

/** Gerrit puts `)]}'` before its JSON to defeat script inclusion. */
const gerritJson = (data) => (typeof data === 'string' ? JSON.parse(data.replace(/^\)\]\}'\s*/, '')) : data);

export const gerrit = {
  id: 'gerrit',
  label: 'Gerrit',
  renovatePlatform: 'gerrit',
  credentials: 'password',
  usernameRequired: true,
  endpointRequired: true,
  defaultEndpoint: null,
  beta: true,
  deviceFlow: null,
  browserLogin: null,
  webhooks: null,

  normalizeEndpoint(input) {
    if (!input) throw new ProviderError('invalid_address', 'The address of your Gerrit server is required.');
    const url = parseBaseUrl(input);
    return `${url.origin}${url.path.replace(/\/a$/, '')}/`;
  },
  webUrl: (endpoint) => endpoint.replace(/\/$/, ''),

  tokenGuide(endpoint) {
    return { scopes: [], url: `${endpoint}settings/#HTTPCredentials` };
  },

  async whoami(ctx) {
    const { data } = await requestJson(`${ctx.endpoint}a/accounts/self`, { headers: headersFor(ctx), fetch: ctx.fetch });
    const account = gerritJson(data);
    return { id: String(account._account_id ?? ctx.username), login: account.username ?? ctx.username, name: account.name ?? ctx.username, avatarUrl: null, warnings: account.email ? [] : [{ code: 'missing_profile' }] };
  },

  async *listRepositories(ctx) {
    const { data } = await requestJson(`${ctx.endpoint}a/projects/?type=CODE&state=ACTIVE`, { headers: headersFor(ctx), fetch: ctx.fetch });
    for (const [name, project] of Object.entries(gerritJson(data))) {
      yield {
        fullName: name,
        description: project.description || null,
        htmlUrl: `${ctx.endpoint}admin/repos/${encodeURIComponent(name)}`,
        defaultBranch: null,
        isPrivate: true,
        isFork: false,
        isArchived: project.state === 'READ_ONLY',
        canPush: project.state !== 'READ_ONLY',
      };
    }
  },

  renovateConnection: (connection) => ({ platform: 'gerrit', endpoint: connection.endpoint, username: connection.username, auth: 'password' }),
};
