// The one list of every setting. It drives validation, the settings page of the web interface, the
// schema and translations of config.yaml (tools/sync-config.mjs) and the tests that keep them equal.
//
// Where a value comes from, strongest first:
//   1. the app configuration (options.json): the value is locked in the web interface
//   2. the web interface (stored in the database)
//   3. the default below, or a value derived from the resource profile
//
// type     enum | bool | int | string | secret | list | records
// scope    live          takes effect immediately
//          next-run      is read when the next Renovate run starts
//          restart       needs a restart of the app
//          options-only  only the app configuration can change it (the web interface shows it read-only)

const TIME_ZONE = (value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return null;
  } catch {
    return 'Unknown time zone';
  }
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Names that the app itself controls for every run; an override would break the connection to the git server.
export const RESERVED_ENV = /^(RENOVATE_(TOKEN|PLATFORM|ENDPOINT|CONFIG_FILE|BASE_DIR|CACHE_DIR|REPOSITORIES|AUTODISCOVER)|GITHUB_COM_TOKEN|NODE_OPTIONS|HOME|PATH)$/;

export const GROUPS = ['general', 'schedule', 'resources', 'history', 'renovate', 'webhooks', 'home_assistant', 'advanced'];

/** @type {Array<Record<string, any>>} */
export const DEFINITIONS = [
  // --- general ---------------------------------------------------------------------------------
  { key: 'general.language', type: 'enum', values: ['auto', 'en', 'de'], default: 'auto', scope: 'live' },
  { key: 'general.theme', type: 'enum', values: ['auto', 'light', 'dark'], default: 'auto', scope: 'live' },
  { key: 'general.accent', type: 'enum', values: ['blue', 'home_assistant', 'custom'], default: 'blue', scope: 'live' },
  { key: 'general.accent_color', type: 'string', pattern: /^#[0-9a-fA-F]{6}$/, patternHint: '#RRGGBB', scope: 'live' },
  { key: 'general.log_level', type: 'enum', values: ['debug', 'info', 'warn', 'error'], default: 'info', scope: 'live' },
  { key: 'general.timezone', type: 'string', validate: TIME_ZONE, scope: 'live' },

  // --- schedule --------------------------------------------------------------------------------
  { key: 'schedule.mode', type: 'enum', values: ['cron', 'interval', 'manual'], default: 'cron', scope: 'live' },
  { key: 'schedule.cron', type: 'string', default: '0 */6 * * *', cron: true, scope: 'live' },
  { key: 'schedule.interval_minutes', type: 'int', min: 5, max: 10080, default: 360, scope: 'live' },
  { key: 'schedule.run_on_start', type: 'bool', default: false, scope: 'live' },

  // --- resources -------------------------------------------------------------------------------
  { key: 'resources.profile', type: 'enum', values: ['auto', 'light', 'balanced', 'performance'], default: 'auto', scope: 'next-run' },
  { key: 'resources.max_concurrent_runs', type: 'int', min: 1, max: 4, scope: 'next-run', advanced: true },
  { key: 'resources.memory_limit_mb', type: 'int', min: 256, max: 16384, scope: 'next-run', advanced: true },
  { key: 'resources.batch_size', type: 'int', min: 1, max: 100, scope: 'next-run', advanced: true },
  { key: 'resources.cpu_priority', type: 'int', min: 0, max: 19, scope: 'next-run', advanced: true },
  { key: 'resources.run_timeout_minutes', type: 'int', min: 5, max: 720, default: 90, scope: 'next-run', advanced: true },

  // --- history ---------------------------------------------------------------------------------
  { key: 'history.keep_runs', type: 'int', min: 10, max: 5000, default: 100, scope: 'live' },
  { key: 'history.keep_log_days', type: 'int', min: 1, max: 365, default: 30, scope: 'live' },

  // --- renovate --------------------------------------------------------------------------------
  { key: 'renovate.dry_run', type: 'enum', values: ['off', 'extract', 'lookup', 'full'], default: 'off', scope: 'next-run' },
  { key: 'renovate.onboarding', type: 'bool', default: true, scope: 'next-run' },
  { key: 'renovate.onboarding_preset', type: 'string', default: 'config:recommended', pattern: /^[^\s]+$/, patternHint: 'config:recommended', scope: 'next-run' },
  { key: 'renovate.require_config', type: 'enum', values: ['required', 'optional', 'ignored'], default: 'required', scope: 'next-run' },
  { key: 'renovate.git_author', type: 'string', pattern: /^[^<>]+ <[^<>@\s]+@[^<>\s]+>$/, patternHint: 'Renovate Bot <renovate@example.com>', scope: 'next-run' },
  { key: 'renovate.default_extends', type: 'list', default: [], itemPattern: /^[^\s]+$/, scope: 'next-run' },
  { key: 'renovate.default_labels', type: 'list', default: [], itemPattern: /^[^\n]{1,50}$/, scope: 'next-run' },
  { key: 'renovate.pr_concurrent_limit', type: 'int', min: 0, max: 100, scope: 'next-run' },
  { key: 'renovate.pr_hourly_limit', type: 'int', min: 0, max: 100, scope: 'next-run' },
  { key: 'renovate.github_com_token', type: 'secret', scope: 'next-run' },
  {
    key: 'renovate.host_rules',
    type: 'records',
    default: [],
    fields: [
      { key: 'match_host', type: 'string', required: true, pattern: /^[^\s]+$/ },
      { key: 'username', type: 'string' },
      { key: 'password', type: 'secret' },
      { key: 'token', type: 'secret' },
    ],
    scope: 'next-run',
  },
  { key: 'renovate.config_file', type: 'string', pattern: /^[A-Za-z0-9._-][A-Za-z0-9._/-]*\.json$/, patternHint: 'renovate.json', scope: 'next-run', advanced: true },

  // --- webhooks --------------------------------------------------------------------------------
  { key: 'webhooks.enabled', type: 'bool', default: false, scope: 'live' },
  { key: 'webhooks.port', type: 'int', min: 1024, max: 65535, default: 8092, scope: 'live' },
  { key: 'webhooks.public_url', type: 'url', scope: 'live' },
  { key: 'webhooks.debounce_seconds', type: 'int', min: 5, max: 3600, default: 60, scope: 'live' },
  { key: 'webhooks.ignore_own_events', type: 'bool', default: true, scope: 'live', advanced: true },

  // --- Home Assistant --------------------------------------------------------------------------
  { key: 'home_assistant.sensors', type: 'bool', default: true, scope: 'live' },
  { key: 'home_assistant.events', type: 'bool', default: true, scope: 'live' },
  { key: 'home_assistant.failure_notification', type: 'bool', default: false, scope: 'live' },

  // --- advanced --------------------------------------------------------------------------------
  { key: 'advanced.renovate_log_level', type: 'enum', values: ['debug', 'info', 'warn', 'error'], default: 'info', scope: 'next-run', advanced: true },
  { key: 'advanced.extra_packages', type: 'list', default: [], itemPattern: /^[a-z0-9][a-z0-9+._-]*$/, scope: 'options-only', advanced: true },
  {
    key: 'advanced.extra_env',
    type: 'records',
    default: [],
    fields: [
      { key: 'name', type: 'string', required: true, pattern: ENV_NAME },
      { key: 'value', type: 'string', required: true },
    ],
    scope: 'next-run',
    advanced: true,
  },
  { key: 'advanced.ca_certificate', type: 'string', pattern: /^[A-Za-z0-9._-][A-Za-z0-9._/-]*$/, patternHint: 'my-ca.pem', scope: 'options-only', advanced: true },
  { key: 'advanced.insecure_tls', type: 'bool', default: false, scope: 'options-only', advanced: true },
  { key: 'advanced.github_client_id', type: 'string', pattern: /^[A-Za-z0-9._-]+$/, scope: 'options-only', advanced: true },
];

export const DEFINITION_BY_KEY = new Map(DEFINITIONS.map((definition) => [definition.key, definition]));

export const groupOf = (key) => key.split('.')[0];
export const nameOf = (key) => key.split('.').slice(1).join('.');
