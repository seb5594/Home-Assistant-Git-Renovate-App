// Azure DevOps Services and Azure DevOps Server. Signs in with a personal access token.
import { basicAuth, paginateWith, parseBaseUrl, requestJson, ProviderError } from './http.mjs';

const SCOPES = ['Code: Read & write', 'Work Items: Read & write'];
const API_VERSION = '7.0';

// A PAT is sent as the password of an empty user name.
const headersFor = ({ token }) => ({ Authorization: basicAuth('', token) });

export const azure = {
  id: 'azure',
  label: 'Azure DevOps',
  renovatePlatform: 'azure',
  credentials: 'token',
  usernameRequired: false,
  endpointRequired: true,
  defaultEndpoint: null,
  beta: true,
  deviceFlow: null,
  browserLogin: null,
  webhooks: null,

  normalizeEndpoint(input) {
    if (!input) throw new ProviderError('invalid_address', 'The address of your organization is required, for example https://dev.azure.com/my-organization.');
    const url = parseBaseUrl(input);
    if (url.host === 'dev.azure.com' && !url.path) {
      throw new ProviderError('invalid_address', 'Add your organization: https://dev.azure.com/my-organization');
    }
    return `${url.origin}${url.path}/`;
  },
  webUrl: (endpoint) => endpoint.replace(/\/$/, ''),

  tokenGuide(endpoint) {
    return { scopes: SCOPES, url: `${endpoint}_usersSettings/tokens` };
  },

  async whoami(ctx) {
    const { data } = await requestJson(`${ctx.endpoint}_apis/connectionData?api-version=${API_VERSION}-preview`, { headers: headersFor(ctx), fetch: ctx.fetch });
    const user = data?.authenticatedUser;
    if (!user || user.isActive === false) throw new ProviderError('provider_unauthorized', 'The server did not accept this token.', 401);
    const login = user.properties?.Account?.$value ?? user.providerDisplayName ?? user.id;
    return { id: String(user.id), login, name: user.providerDisplayName ?? login, avatarUrl: null, warnings: [] };
  },

  async *listRepositories(ctx) {
    const url = `${ctx.endpoint}_apis/git/repositories?api-version=${API_VERSION}`;
    for await (const repo of paginateWith(url, { headers: headersFor(ctx), fetch: ctx.fetch }, (data) => ({ items: data.value ?? [], next: null }))) {
      yield {
        fullName: `${repo.project?.name}/${repo.name}`,
        description: null,
        htmlUrl: repo.webUrl ?? null,
        defaultBranch: repo.defaultBranch?.replace(/^refs\/heads\//, '') ?? null,
        isPrivate: true,
        isFork: Boolean(repo.isFork),
        isArchived: Boolean(repo.isDisabled),
        canPush: true,
      };
    }
  },

  renovateConnection: (connection) => ({ platform: 'azure', endpoint: connection.endpoint, auth: 'token' }),
};
