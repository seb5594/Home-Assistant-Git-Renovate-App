// Bitbucket Cloud. Signs in with the account name and an API token (Renovate calls it the password).
import { basicAuth, paginateWith, requestJson } from './http.mjs';
import { AppError } from '../util/errors.mjs';

const API = 'https://api.bitbucket.org/2.0/';
const SCOPES = ['read:repository:bitbucket', 'write:repository:bitbucket', 'read:pullrequest:bitbucket', 'write:pullrequest:bitbucket', 'read:user:bitbucket', 'read:workspace:bitbucket'];

const headersFor = (ctx) => ({ Authorization: basicAuth(ctx.username, ctx.token) });

export const bitbucket = {
  id: 'bitbucket',
  label: 'Bitbucket Cloud',
  renovatePlatform: 'bitbucket',
  credentials: 'password',
  usernameRequired: true,
  endpointRequired: false,
  defaultEndpoint: API,
  beta: true,
  deviceFlow: null,
  browserLogin: null,
  webhooks: null,

  normalizeEndpoint(input) {
    if (input && !/bitbucket\.org/i.test(input)) {
      throw new AppError(400, 'invalid_address', 'Bitbucket Cloud has a fixed address. For your own Bitbucket choose "Bitbucket Server".');
    }
    return API;
  },
  webUrl: () => 'https://bitbucket.org',

  tokenGuide() {
    return { scopes: SCOPES, url: 'https://id.atlassian.com/manage-profile/security/api-tokens' };
  },

  async whoami(ctx) {
    const { data } = await requestJson(`${API}user`, { headers: headersFor(ctx), fetch: ctx.fetch });
    return { id: String(data.account_id ?? ctx.username), login: ctx.username, name: data.display_name ?? ctx.username, avatarUrl: data.links?.avatar?.href ?? null, warnings: [] };
  },

  async *listRepositories(ctx) {
    // role=contributor: repositories the account may write to.
    const first = `${API}repositories?role=contributor&pagelen=100`;
    for await (const repo of paginateWith(first, { headers: headersFor(ctx), fetch: ctx.fetch }, (data) => ({ items: data.values ?? [], next: data.next ?? null }))) {
      yield {
        fullName: repo.full_name,
        description: repo.description || null,
        htmlUrl: repo.links?.html?.href ?? null,
        defaultBranch: repo.mainbranch?.name ?? null,
        isPrivate: Boolean(repo.is_private),
        isFork: Boolean(repo.parent),
        isArchived: false,
        canPush: true,
      };
    }
  },

  renovateConnection: (connection) => ({ platform: 'bitbucket', endpoint: null, username: connection.username, auth: 'password' }),
};
