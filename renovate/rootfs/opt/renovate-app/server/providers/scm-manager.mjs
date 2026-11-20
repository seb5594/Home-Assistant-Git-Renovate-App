// SCM-Manager 3 (experimental in Renovate; needs the Review plugin from version 3.11). Signs in with an API key.
import { paginateWith, parseBaseUrl, requestJson, ProviderError } from './http.mjs';

const headersFor = ({ token }) => ({ Authorization: `Bearer ${token}` });

export const scmManager = {
  id: 'scm-manager',
  label: 'SCM-Manager',
  renovatePlatform: 'scm-manager',
  credentials: 'token',
  usernameRequired: false,
  endpointRequired: true,
  defaultEndpoint: null,
  beta: true,
  deviceFlow: null,
  browserLogin: null,
  webhooks: null,

  normalizeEndpoint(input) {
    if (!input) throw new ProviderError('invalid_address', 'The address of your SCM-Manager is required, for example https://scm.example.org/scm.');
    const url = parseBaseUrl(input);
    return `${url.origin}${url.path.replace(/\/api(\/v2)?$/, '')}/`;
  },
  webUrl: (endpoint) => endpoint.replace(/\/$/, ''),

  tokenGuide(endpoint) {
    return { scopes: [], url: `${endpoint}me/settings/apiKeys` };
  },

  async whoami(ctx) {
    const { data } = await requestJson(`${ctx.endpoint}api/v2/me`, { headers: headersFor(ctx), fetch: ctx.fetch });
    return { id: String(data.name), login: data.name, name: data.displayName ?? data.name, avatarUrl: null, warnings: data.mail ? [] : [{ code: 'missing_profile' }] };
  },

  async *listRepositories(ctx) {
    const first = `${ctx.endpoint}api/v2/repositories?pageSize=100&page=0`;
    const step = (data) => ({ items: data._embedded?.repositories ?? [], next: data._links?.next?.href ?? null });
    for await (const repo of paginateWith(first, { headers: headersFor(ctx), fetch: ctx.fetch }, step)) {
      // Renovate works with Git repositories only.
      if (repo.type !== 'git') continue;
      yield {
        fullName: `${repo.namespace}/${repo.name}`,
        description: repo.description || null,
        htmlUrl: `${ctx.endpoint}repo/${repo.namespace}/${repo.name}`,
        defaultBranch: null,
        isPrivate: true,
        isFork: false,
        isArchived: Boolean(repo.archived),
        canPush: true,
      };
    }
  },

  renovateConnection: (connection) => ({ platform: 'scm-manager', endpoint: connection.endpoint, auth: 'token' }),
};
