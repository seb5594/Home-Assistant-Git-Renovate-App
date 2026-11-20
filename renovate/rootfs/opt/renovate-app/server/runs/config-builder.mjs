// Builds the configuration and the environment of one Renovate process. Pure functions: nothing here touches
// the disk or the network, so the whole mapping from settings to Renovate options is covered by unit tests.
import path from 'node:path';
import { RESERVED_ENV } from '../settings/registry.mjs';

// Only these variables of the app's own environment reach Renovate. The Supervisor token and everything
// else stays behind, because Renovate runs code and package managers on repositories that others may change.
const INHERITED_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'SSL_CERT_FILE', 'GIT_SSL_CAINFO', 'GIT_SSL_NO_VERIFY', 'REQUESTS_CA_BUNDLE', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

/** Renovate options that the app sets itself and that no setting or connection may override. */
function forcedOptions({ renovate, repositories, directories }) {
  return {
    platform: renovate.platform,
    ...(renovate.endpoint ? { endpoint: renovate.endpoint } : {}),
    repositories,
    autodiscover: false,
    binarySource: 'global',
    baseDir: directories.baseDir,
    cacheDir: directories.cacheDir,
    repositoryCache: 'enabled',
    reportType: 'file',
    reportPath: directories.reportPath,
  };
}

function hostRulesFrom(settings) {
  return settings['renovate.host_rules'].map((rule) => ({
    matchHost: rule.match_host,
    ...(rule.username ? { username: rule.username } : {}),
    ...(rule.password ? { password: rule.password } : {}),
    ...(rule.token ? { token: rule.token } : {}),
  }));
}

/**
 * @param {object} input
 * @param {{extraConfig:object}} input.connection
 * @param {{platform:string, endpoint:string|null}} input.renovate the provider's view of the connection
 * @param {string[]} input.repositories repositories of this batch
 * @param {Record<string, any>} input.settings effective settings
 * @param {{baseDir:string, cacheDir:string, reportPath:string}} input.directories
 * @param {object} [input.userConfig] contents of the JSON file the user placed in the app's config folder
 * @param {string|null} [input.dryRun] one-off override from the "preview" button
 */
export function buildRenovateConfig({ connection, renovate, repositories, settings, directories, userConfig = {}, dryRun = null }) {
  const configuredDryRun = settings['renovate.dry_run'] === 'off' ? null : settings['renovate.dry_run'];
  const defaults = {
    onboarding: settings['renovate.onboarding'],
    onboardingConfig: { extends: [settings['renovate.onboarding_preset']] },
    requireConfig: settings['renovate.require_config'],
    dryRun: dryRun ?? configuredDryRun,
    ...(settings['renovate.git_author'] ? { gitAuthor: settings['renovate.git_author'] } : {}),
    ...(settings['renovate.default_extends'].length ? { extends: settings['renovate.default_extends'] } : {}),
    ...(settings['renovate.default_labels'].length ? { labels: settings['renovate.default_labels'] } : {}),
    ...(settings['renovate.pr_concurrent_limit'] !== null ? { prConcurrentLimit: settings['renovate.pr_concurrent_limit'] } : {}),
    ...(settings['renovate.pr_hourly_limit'] !== null ? { prHourlyLimit: settings['renovate.pr_hourly_limit'] } : {}),
    hostRules: hostRulesFrom(settings),
  };
  // Order, weakest first: app defaults, the user's file, the connection's own options, then what the app forces.
  const merged = { ...defaults, ...userConfig, ...connection.extraConfig };
  // A preview must stay a preview, whatever the user's file says.
  if (dryRun) merged.dryRun = dryRun;
  return { ...merged, ...forcedOptions({ renovate, repositories, directories }) };
}

/**
 * @param {object} input
 * @param {NodeJS.ProcessEnv} input.processEnv environment of the app
 * @param {{token:string}} input.connection
 * @param {{platform:string, endpoint:string|null}} input.renovate
 * @param {Record<string, any>} input.settings
 * @param {{memoryLimitMb:number}} input.resources
 * @param {{configFile:string, home:string}} input.files
 */
export function buildRenovateEnv({ processEnv, connection, renovate, settings, resources, files }) {
  const env = {};
  for (const name of INHERITED_ENV) if (processEnv[name] !== undefined) env[name] = processEnv[name];

  for (const { name, value } of settings['advanced.extra_env']) {
    if (!RESERVED_ENV.test(name)) env[name] = value;
  }

  Object.assign(env, {
    HOME: files.home,
    LOG_LEVEL: settings['advanced.renovate_log_level'],
    LOG_FORMAT: 'json',
    GIT_TERMINAL_PROMPT: '0',
    // Renovate's regular expression engine (re2) is a native module that is not part of the image: smaller and
    // buildable everywhere. Renovate falls back to the built-in engine.
    RENOVATE_X_IGNORE_RE2: 'true',
    NODE_OPTIONS: `--max-old-space-size=${resources.memoryLimitMb}`,
    RENOVATE_CONFIG_FILE: files.configFile,
  });
  // Bitbucket Cloud and Gerrit sign in with a user name and a password (an API token), the others with a token.
  if (renovate.auth === 'password') {
    env.RENOVATE_USERNAME = renovate.username;
    env.RENOVATE_PASSWORD = connection.token;
  } else {
    env.RENOVATE_TOKEN = connection.token;
  }

  // Release notes and changelogs come from GitHub. On github.com the connection's own token does that job.
  const githubToken = settings['renovate.github_com_token'] || (renovate.platform === 'github' && !renovate.endpoint ? connection.token : null);
  if (githubToken) env.GITHUB_COM_TOKEN = githubToken;
  return env;
}

/** Splits a list into groups of at most `size` entries. */
export function chunk(list, size) {
  const groups = [];
  for (let index = 0; index < list.length; index += size) groups.push(list.slice(index, index + size));
  return groups;
}

export function runDirectories({ work, cache, runId }) {
  const root = path.join(work, `run-${runId}`);
  return {
    root,
    baseDir: path.join(root, 'base'),
    cacheDir: cache,
    home: path.join(root, 'home'),
    configFile: path.join(root, 'config.json'),
    reportPath: path.join(root, 'report.json'),
  };
}
