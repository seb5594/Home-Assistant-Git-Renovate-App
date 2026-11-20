// The registry of git servers the app can talk to. A provider is a plain object (see github.mjs for the
// full shape); adding a server type means adding one file and one line here.
import { AppError } from '../util/errors.mjs';
import { forgejo, gitea } from './gitea.mjs';
import { github } from './github.mjs';
import { gitlab } from './gitlab.mjs';
import { azure } from './azure.mjs';
import { bitbucket } from './bitbucket.mjs';
import { bitbucketServer } from './bitbucket-server.mjs';
import { gerrit } from './gerrit.mjs';
import { scmManager } from './scm-manager.mjs';

export const providers = Object.freeze({ github, gitlab, gitea, forgejo, bitbucket, 'bitbucket-server': bitbucketServer, azure, gerrit, 'scm-manager': scmManager });

export function getProvider(id) {
  const provider = providers[id];
  if (!provider) throw new AppError(400, 'unknown_provider', `Unknown git server type "${id}"`);
  return provider;
}

/** Candidates for the address field: Gitea apps of Home Assistant are reachable by their internal host name. */
export const GITEA_APP_CANDIDATES = ['http://db21ed7f-gitea:3000', 'http://a0d7b954-gitea:3000'];

/** What the browser needs to know about each provider, without any logic. */
export function describeProviders({ githubClientId } = {}) {
  return Object.values(providers).map((provider) => ({
    id: provider.id,
    label: provider.label,
    endpointRequired: provider.endpointRequired,
    defaultEndpoint: provider.defaultEndpoint,
    credentials: provider.credentials,
    usernameRequired: provider.usernameRequired,
    beta: provider.beta,
    deviceFlow: Boolean(provider.deviceFlow && githubClientId),
    credentialLogin: Boolean(provider.credentialLogin),
    browserLogin: Boolean(provider.browserLogin),
    webhooks: Boolean(provider.webhooks),
  }));
}
