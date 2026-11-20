// Bitbucket Server and Data Center (your own installation). Signs in with an HTTP access token.
import { paginateWith, parseBaseUrl, requestJson } from './http.mjs';
import { ProviderError } from './http.mjs';

const headersFor = ({ token }) => ({ Authorization: `Bearer ${token}` });

export const bitbucketServer = {
  id: 'bitbucket-server',
  label: 'Bitbucket Server',
  renovatePlatform: 'bitbucket-server',
  credentials: 'token',
  usernameRequired: false,
  endpointRequired: true,
  defaultEndpoint: null,
  beta: true,
  deviceFlow: null,
  browserLogin: null,
  webhooks: null,

  normalizeEndpoint(input) {
    if (!input) throw new ProviderError('invalid_address', 'The address of your server is required.');
    const url = parseBaseUrl(input);
    return `${url.origin}${url.path.replace(/\/rest\/api\/.*$/, '')}/`;
  },
  webUrl: (endpoint) => endpoint.replace(/\/$/, ''),

  tokenGuide(endpoint) {
    return { scopes: ['Project: Read', 'Repository: Write'], url: `${endpoint}plugins/servlet/access-tokens/manage` };
  },

  async whoami(ctx) {
    // The account of a token is told by this servlet, as plain text and in a header.
    const reply = await requestJson(`${ctx.endpoint}plugins/servlet/applinks/whoami`, { headers: headersFor(ctx), fetch: ctx.fetch });
    const slug = String(reply.headers.get('x-ausername') ?? reply.data ?? '').trim();
    if (!slug) throw new ProviderError('provider_unauthorized', 'The server did not tell whose token this is. Check the token.', 401);
    let profile = {};
    try {
      ({ data: profile } = await requestJson(`${ctx.endpoint}rest/api/1.0/users/${encodeURIComponent(slug)}`, { headers: headersFor(ctx), fetch: ctx.fetch }));
    } catch {
      // The profile is a convenience; the user name is enough.
    }
    return { id: String(profile.id ?? slug), login: slug, name: profile.displayName ?? slug, avatarUrl: profile.avatarUrl ? new URL(profile.avatarUrl, ctx.endpoint).href : null, warnings: [] };
  },

  async *listRepositories(ctx) {
    const first = `${ctx.endpoint}rest/api/1.0/repos?permission=REPO_WRITE&limit=100`;
    const step = (data, url) => {
      const next = new URL(url);
      next.searchParams.set('start', String(data.nextPageStart));
      return { items: data.values ?? [], next: data.isLastPage === false ? next.href : null };
    };
    for await (const repo of paginateWith(first, { headers: headersFor(ctx), fetch: ctx.fetch }, step)) {
      yield {
        fullName: `${repo.project?.key}/${repo.slug}`,
        description: repo.description || null,
        htmlUrl: repo.links?.self?.[0]?.href ?? null,
        defaultBranch: null,
        isPrivate: !repo.public,
        isFork: Boolean(repo.origin),
        isArchived: Boolean(repo.archived),
        canPush: true,
      };
    }
  },

  renovateConnection: (connection) => ({ platform: 'bitbucket-server', endpoint: connection.endpoint, auth: 'token' }),
};
