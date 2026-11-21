// Connections: the list, and the detail page with repositories, settings and webhooks.
import { api } from '../api.mjs';
import { avatar, badge, busy, configurationNotice, confirmDialog, emptyState, notice, reportError, skeleton, switchControl, toast } from '../components.mjs';
import { h, mount } from '../dom.mjs';
import { dateTime, relativeTime } from '../format.mjs';
import { iconCopy, iconPlay, iconPlus, iconRefresh } from '../icons.mjs';
import { t } from '../i18n.mjs';
import { EMOJI, emoji } from '../emoji.mjs';
import { providerName } from '../status.mjs';

export async function connectionsList(container, { navigate }) {
  mount(container, skeleton(2));
  const [connections, status] = await Promise.all([api.get('connections'), api.get('status')]);
  mount(container,
    configurationNotice(status.configuration),
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, emoji(EMOJI.nav.connections), t('connections.title')), h('p', {}, t('connections.subtitle'))),
      h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('/connect') }, iconPlus(), t('connections.add'))),
    connections.length
      ? h('div', { class: 'grid' }, connections.map((connection) => h('a', { class: 'card card-link stack', href: `#/connections/${connection.id}` },
        h('div', { class: 'row nowrap' }, avatar(connection), h('div', { class: 'grow' }, h('strong', {}, connection.name), h('div', { class: 'muted small' }, `${providerName(connection.provider)} · ${connection.accountLogin ?? ''}`))),
        connection.enabled ? null : h('div', { class: 'row' }, badge(t('connections.off'), 'warn')),
        h('div', { class: 'muted' }, t('connections.repository_summary', { enabled: connection.enabledRepositoryCount, total: connection.repositoryCount })),
        connection.lastSyncError ? badge(t('connections.sync_failed'), 'danger') : null)))
      : emptyState(t('connections.empty.title'), t('connections.empty.text'), h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('/connect') }, iconPlus(), t('connections.add'))));
}

// --- detail ---------------------------------------------------------------------------------------

const lines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);

function repositoryRow(connection, repository, reload) {
  const reasons = [];
  if (repository.isArchived) reasons.push(badge(t('repositories.archived'), 'warn'));
  if (repository.isFork) reasons.push(badge(t('repositories.fork')));
  if (!repository.canPush) reasons.push(badge(t('repositories.read_only'), 'warn'));
  if (repository.isPrivate) reasons.push(badge(t('repositories.private')));
  const toggle = switchControl({
    checked: repository.enabled,
    label: t('repositories.switch', { name: repository.fullName }),
    onchange: async (checked) => {
      try {
        await api.patch(`connections/${connection.id}/repositories/${repository.id}`, { override: checked ? 1 : 0 });
      } catch (error) {
        reportError(error);
        await reload();
      }
    },
  });
  return h('tr', { class: repository.enabled ? '' : 'muted' },
    h('td', {}, toggle),
    h('td', {}, h('div', {}, repository.htmlUrl ? h('a', { href: repository.htmlUrl, target: '_blank', rel: 'noopener noreferrer' }, repository.fullName) : repository.fullName),
      h('div', { class: 'row small' }, reasons), repository.description ? h('div', { class: 'muted small truncate hide-small' }, repository.description) : null),
    h('td', {}, repository.lastStatus ? badge(t(`repositories.status.${repository.lastStatus}`), repository.lastStatus === 'ok' ? 'ok' : 'danger') : h('span', { class: 'muted' }, '–')),
    h('td', { class: 'num' }, repository.openPrs ?? '–'),
    h('td', { class: 'hide-small' }, repository.lastRunId ? h('a', { href: `#/runs/${repository.lastRunId}` }, relativeTime(repository.lastRunAt)) : '–'),
    h('td', {}, h('button', { class: 'btn small ghost', type: 'button', title: t('repositories.run_one'), disabled: !repository.enabled, onclick: async (event) => busy(event.currentTarget, async () => {
      try {
        await api.post('runs', { connectionId: connection.id, repositories: [repository.fullName] });
        toast(t('overview.run_started'));
      } catch (error) {
        reportError(error);
      }
    }) }, iconPlay())));
}

export function repositoriesTab(connection, panel) {
  let repositories = [];
  let query = '';
  let filter = 'all';
  const body = h('tbody');
  const summary = h('p', { class: 'muted' });

  const visible = () => repositories.filter((repository) => {
    if (query && !repository.fullName.toLowerCase().includes(query)) return false;
    if (filter === 'on') return repository.enabled;
    if (filter === 'off') return !repository.enabled;
    return repository.present;
  });

  function paint() {
    const shown = visible();
    mount(body, shown.map((repository) => repositoryRow(connection, repository, load)));
    summary.textContent = t('repositories.summary', { shown: shown.length, enabled: repositories.filter((repository) => repository.enabled).length, total: repositories.filter((repository) => repository.present).length });
  }

  async function load() {
    repositories = await api.get(`connections/${connection.id}/repositories`);
    paint();
  }

  const bulk = (override) => async (event) => busy(event.currentTarget, async () => {
    try {
      await api.post(`connections/${connection.id}/repositories/bulk`, { names: visible().map((repository) => repository.fullName), override });
      await load();
    } catch (error) {
      reportError(error);
    }
  });

  const refresh = async (event) => busy(event.currentTarget, async () => {
    try {
      const { count } = await api.post(`connections/${connection.id}/sync`);
      toast(t('repositories.refreshed', { count }));
      await load();
    } catch (error) {
      reportError(error);
    }
  });

  mount(panel,
    connection.mode === 'all' ? notice('info', t('repositories.mode_all')) : notice('info', t('repositories.mode_selected')),
    h('div', { class: 'row' },
      h('input', { type: 'text', placeholder: t('repositories.search'), 'aria-label': t('repositories.search'), oninput: (event) => { query = event.target.value.trim().toLowerCase(); paint(); } }),
      h('select', { 'aria-label': t('repositories.filter'), onchange: (event) => { filter = event.target.value; paint(); } },
        ['all', 'on', 'off'].map((key) => h('option', { value: key }, t(`repositories.filter.${key}`)))),
      h('button', { class: 'btn small', type: 'button', onclick: bulk(1) }, t('repositories.switch_on_shown')),
      h('button', { class: 'btn small', type: 'button', onclick: bulk(0) }, t('repositories.switch_off_shown')),
      h('button', { class: 'btn small', type: 'button', onclick: refresh }, iconRefresh(), t('repositories.refresh'))),
    summary,
    connection.lastSyncError ? notice('danger', t('connections.sync_error', { message: connection.lastSyncError })) : null,
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, t('repositories.col.on')), h('th', {}, t('repositories.col.name')), h('th', {}, t('repositories.col.result')), h('th', { class: 'num' }, t('repositories.col.prs')), h('th', { class: 'hide-small' }, t('repositories.col.last')), h('th', {}, ''))),
      body)));
  return load();
}

function settingsTab(connection, panel, navigate, reload) {
  const field = (label, control, hint) => h('label', { class: 'field' }, label, control, hint ? h('span', { class: 'hint' }, hint) : null);
  const name = h('input', { type: 'text', value: connection.name, maxlength: '60' });
  const mode = h('select', {}, ['selected', 'all'].map((key) => h('option', { value: key, selected: connection.mode === key }, t(`connections.mode.${key}`))));
  const include = h('textarea', { rows: '3', placeholder: 'my-org/*\nsven/ha-*' }, connection.includePatterns.join('\n'));
  const exclude = h('textarea', { rows: '3', placeholder: '**/archive-*' }, connection.excludePatterns.join('\n'));
  const forks = switchControl({ checked: connection.skipForks, label: t('connections.skip_forks') });
  const archived = switchControl({ checked: connection.skipArchived, label: t('connections.skip_archived') });
  const enabled = switchControl({ checked: connection.enabled, label: t('connections.enabled') });
  const extra = h('textarea', { rows: '5', placeholder: '{\n  "extends": ["config:recommended"]\n}' }, Object.keys(connection.extraConfig).length ? JSON.stringify(connection.extraConfig, null, 2) : '');
  const token = h('input', { type: 'password', autocomplete: 'off', placeholder: t('connections.token_placeholder') });

  const save = async (event) => busy(event.currentTarget, async () => {
    try {
      let extraConfig = {};
      if (extra.value.trim()) {
        try {
          extraConfig = JSON.parse(extra.value);
        } catch {
          throw Object.assign(new Error(t('connections.extra_invalid')), { code: 'invalid_extra_config' });
        }
      }
      await api.patch(`connections/${connection.id}`, {
        name: name.value.trim(), mode: mode.value, includePatterns: lines(include.value), excludePatterns: lines(exclude.value),
        skipForks: forks.querySelector('input').checked, skipArchived: archived.querySelector('input').checked, enabled: enabled.querySelector('input').checked, extraConfig,
      });
      toast(t('common.saved'));
      await reload();
    } catch (error) {
      reportError(error);
    }
  });

  const replaceToken = async (event) => busy(event.currentTarget, async () => {
    try {
      const { warnings } = await api.put(`connections/${connection.id}/token`, { token: token.value.trim() });
      token.value = '';
      toast(warnings.length ? t('connections.token_replaced_warning') : t('connections.token_replaced'));
    } catch (error) {
      reportError(error);
    }
  });

  const remove = async () => {
    const confirmed = await confirmDialog({ title: t('connections.remove_title', { name: connection.name }), message: connection.tokenName ? t('connections.remove_text_token', { token: connection.tokenName }) : t('connections.remove_text'), confirmLabel: t('connections.remove'), danger: true });
    if (!confirmed) return;
    try {
      await api.delete(`connections/${connection.id}`);
      toast(t('connections.removed'));
      navigate('/connections');
    } catch (error) {
      reportError(error);
    }
  };

  mount(panel,
    h('section', { class: 'card stack' }, h('h3', {}, t('connections.section.general')),
      field(t('connections.name'), name),
      h('div', { class: 'check' }, enabled, h('span', {}, t('connections.enabled'), h('div', { class: 'hint' }, t('connections.enabled_hint')))),
      field(t('connections.mode'), mode, t('connections.mode_hint'))),
    h('section', { class: 'card stack' }, h('h3', {}, t('connections.section.filter')), h('p', { class: 'muted' }, t('connections.filter_hint')),
      field(t('connections.include'), include, t('connections.patterns_hint')), field(t('connections.exclude'), exclude),
      h('div', { class: 'check' }, forks, h('span', {}, t('connections.skip_forks'))), h('div', { class: 'check' }, archived, h('span', {}, t('connections.skip_archived')))),
    h('section', { class: 'card stack' }, h('h3', {}, t('connections.section.renovate')), h('p', { class: 'muted' }, t('connections.extra_hint')), extra),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: save }, t('common.save'))),
    h('section', { class: 'card stack' }, h('h3', {}, t('connections.section.token')),
      connection.authMethod === 'browser'
        ? h('div', { class: 'stack' }, notice('info', t('connections.browser_login')), h('p', { class: 'muted' }, t('connections.browser_login_again')))
        : h('div', { class: 'stack' },
          h('p', { class: 'muted' }, t('connections.token_hint', { account: connection.accountLogin ?? '' })),
          connection.tokenName ? h('p', { class: 'small muted' }, t('connections.token_name', { name: connection.tokenName })) : null,
          h('div', { class: 'row' }, token, h('button', { class: 'btn', type: 'button', onclick: replaceToken }, t('connections.replace_token'))))),
    h('section', { class: 'card stack' }, h('h3', {}, t('connections.section.danger')),
      h('div', {}, h('button', { class: 'btn danger', type: 'button', onclick: remove }, t('connections.remove')))));
}

async function webhooksTab(connection, panel, navigate) {
  const info = await api.get(`connections/${connection.id}/webhook`);
  if (info.supported === false) {
    mount(panel, notice('info', t('webhooks.unsupported', { name: providerName(connection.provider) })));
    return;
  }
  const copy = (value) => h('button', { class: 'btn small', type: 'button', onclick: async () => { await navigator.clipboard?.writeText(value).catch(() => {}); toast(t('common.copied')); } }, iconCopy(), t('common.copy'));
  const register = async (event) => busy(event.currentTarget, async () => {
    try {
      const outcome = await api.post(`connections/${connection.id}/webhook/register`);
      toast(t('webhooks.registered', { created: outcome.created, updated: outcome.updated, failed: outcome.failed.length }), { error: outcome.failed.length > 0 && outcome.created + outcome.updated === 0 });
    } catch (error) {
      reportError(error);
    }
  });
  mount(panel,
    notice('info', t('webhooks.explain')),
    info.enabled ? null : notice('warn', t('webhooks.disabled'), h('button', { class: 'btn small', type: 'button', onclick: () => navigate('/settings') }, t('webhooks.open_settings'))),
    info.enabled && !info.url ? notice('warn', t('webhooks.no_url'), h('button', { class: 'btn small', type: 'button', onclick: () => navigate('/settings') }, t('webhooks.open_settings'))) : null,
    h('section', { class: 'card stack' },
      h('label', { class: 'field' }, t('webhooks.url'), h('div', { class: 'row' }, h('input', { type: 'text', readonly: true, value: info.url ?? t('webhooks.url_missing') }), info.url ? copy(info.url) : null)),
      h('label', { class: 'field' }, t('webhooks.secret'), h('div', { class: 'row' }, h('input', { type: 'text', readonly: true, value: info.secret }), copy(info.secret))),
      h('p', { class: 'hint' }, t('webhooks.events', { events: info.events.join(', ') })),
      h('p', { class: 'hint' }, t('webhooks.port', { port: info.port })),
      h('div', {}, h('button', { class: 'btn primary', type: 'button', disabled: !info.enabled || !info.url, onclick: register }, t('webhooks.register')))));
}

export async function connectionDetail(container, { boot, params: [id], query, navigate }) {
  mount(container, skeleton(2));
  let connection;
  let tab = query.get('tab') ?? 'repositories';
  const panel = h('div', { class: 'stack' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });

  async function load() {
    connection = await api.get(`connections/${id}`);
    mount(container,
      h('div', { class: 'page-head' },
        h('div', { class: 'row' }, avatar(connection),
          h('div', {}, h('h1', {}, connection.name), h('p', {}, `${providerName(connection.provider)} · ${connection.accountLogin ?? ''}`, connection.endpoint && connection.provider !== 'github' ? h('span', { class: 'mono small' }, ` · ${connection.endpoint}`) : null))),
        h('div', { class: 'row' },
          connection.lastSyncAt ? h('span', { class: 'muted small' }, t('connections.synced', { when: dateTime(connection.lastSyncAt) })) : null,
          h('button', { class: 'btn primary', type: 'button', disabled: !connection.enabled, onclick: async (event) => busy(event.currentTarget, async () => {
            try {
              await api.post('runs', { connectionId: connection.id });
              toast(t('overview.run_started'));
            } catch (error) {
              reportError(error);
            }
          }) }, iconPlay(), t('overview.run_connection')),
          h('button', { class: 'btn', type: 'button', title: t('overview.preview_hint'), onclick: async (event) => busy(event.currentTarget, async () => {
            try {
              await api.post('runs', { connectionId: connection.id, dryRun: 'full' });
              toast(t('overview.preview_started'));
            } catch (error) {
              reportError(error);
            }
          }) }, t('overview.preview'))),
      ),
      tabs, panel);
    await showTab(tab);
  }

  async function showTab(name) {
    tab = name;
    const webhooks = boot.providers.find((provider) => provider.id === connection.provider)?.webhooks;
    mount(tabs, ['repositories', 'settings', ...(webhooks ? ['webhooks'] : [])].map((key) => h('button', { type: 'button', role: 'tab', aria: { selected: String(key === name) }, onclick: () => showTab(key) }, t(`connections.tab.${key}`))));
    mount(panel, skeleton(1));
    try {
      if (name === 'repositories') await repositoriesTab(connection, panel);
      else if (name === 'settings') settingsTab(connection, panel, navigate, load);
      else await webhooksTab(connection, panel, navigate);
    } catch (error) {
      mount(panel, notice('danger', error.message));
    }
  }

  await load();
}

